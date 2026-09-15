/**
 * Google Calendar API client — exactly the calls this product makes.
 *
 * Five operations: create the app's own calendar, and insert / patch / delete /
 * list events on it. Nothing reads the user's other calendars, because under
 * `calendar.app.created` nothing can.
 *
 * Two decisions worth stating.
 *
 * **Creates are idempotent by ID.** The event ID is derived from the occurrence
 * key, so inserting the same occurrence twice is a 409 rather than a duplicate
 * in the user's calendar. `insertEvent` reports that 409 as
 * `{ created: false }`, which is the correct outcome for a retried write — the
 * alternative is a person seeing their grandfather's yahrzeit twice.
 *
 * **Retries are bounded and only for transient failures.** The classification
 * lives in `errors.ts`; this module only decides how long to wait. Retrying a
 * permission error would burn quota forever and never succeed.
 */
import type { GoogleEventPayload } from '@hebrew-dates/google-calendar';
import { GoogleApiError, GoogleTransportError, isRetryable, toGoogleApiError } from './errors';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** Google's page size cap for events.list. */
const MAX_PAGE_SIZE = 2500;

export interface CalendarClientOptions {
  /** A live access token. Never a refresh token; this module does not refresh. */
  accessToken: string;
  fetch?: typeof fetch;
  /** Attempts per request, including the first. 1 disables retrying. */
  maxAttempts?: number;
  /** Injected in tests so backoff does not actually sleep. */
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface CreatedCalendar {
  id: string;
  summary: string;
  timeZone: string | undefined;
}

export interface ListedEvent {
  id: string;
  status: string | undefined;
  summary: string | undefined;
  updated: string | undefined;
  /** `extendedProperties.private`, where this app's own keys live. */
  privateProperties: Record<string, string>;
}

export interface EventPage {
  events: ListedEvent[];
  nextPageToken: string | undefined;
  /** Returned on the final page; lets a later run do an incremental sync. */
  nextSyncToken: string | undefined;
}

export class GoogleCalendarClient {
  readonly #accessToken: string;
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: CalendarClientOptions) {
    if (!options.accessToken) {
      throw new Error('GoogleCalendarClient needs an access token.');
    }
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /* --------------------------------------------------------- calendars -- */

  /**
   * Create the application's own calendar.
   *
   * This is what makes `calendar.app.created` usable: the scope grants access
   * only to calendars the app created, so this call is the moment the app gains
   * any calendar access at all. The returned ID is the only calendar it will
   * ever write to.
   *
   * `timeZone` here is the *calendar's* display zone, not a sunset input. Events
   * carry their own absolute times; this only affects how Google renders a
   * date-only event and what a new event defaults to.
   */
  async createCalendar(params: {
    summary: string;
    description?: string;
    timeZone?: string;
  }): Promise<CreatedCalendar> {
    const body = await this.#request<{
      id?: string;
      summary?: string;
      timeZone?: string;
    }>('create calendar', 'POST', `${CALENDAR_API}/calendars`, {
      summary: params.summary,
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.timeZone !== undefined ? { timeZone: params.timeZone } : {}),
    });

    if (!body.id) {
      throw new GoogleTransportError(
        'create calendar',
        new Error('Google returned a calendar with no id'),
      );
    }
    return { id: body.id, summary: body.summary ?? params.summary, timeZone: body.timeZone };
  }

  /** Confirm a calendar still exists and is reachable with this grant. */
  async getCalendar(calendarId: string): Promise<CreatedCalendar> {
    const body = await this.#request<{ id?: string; summary?: string; timeZone?: string }>(
      'get calendar',
      'GET',
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`,
    );
    return { id: body.id ?? calendarId, summary: body.summary ?? '', timeZone: body.timeZone };
  }

  /**
   * Delete the whole calendar.
   *
   * Used when a user disconnects and asks for their events to be removed:
   * deleting one calendar is a single call, where deleting its events would be
   * hundreds and could half-finish.
   */
  async deleteCalendar(calendarId: string): Promise<{ deleted: boolean }> {
    try {
      await this.#request<void>(
        'delete calendar',
        'DELETE',
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`,
      );
      return { deleted: true };
    } catch (error) {
      // Already gone is the desired end state.
      if (error instanceof GoogleApiError && error.kind === 'not_found') {
        return { deleted: false };
      }
      throw error;
    }
  }

  /**
   * Update the calendar's own metadata, e.g. after a rename.
   *
   * PATCH rather than PUT: a PUT would clear fields this app does not set.
   */
  async patchCalendar(
    calendarId: string,
    patch: { summary?: string; description?: string; timeZone?: string },
  ): Promise<CreatedCalendar> {
    const body = await this.#request<{ id?: string; summary?: string; timeZone?: string }>(
      'patch calendar',
      'PATCH',
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`,
      patch,
    );
    return { id: body.id ?? calendarId, summary: body.summary ?? '', timeZone: body.timeZone };
  }

  /* ------------------------------------------------------------ events -- */

  /**
   * Insert an event, tolerating the case where it already exists.
   *
   * The caller supplies the ID (derived from the occurrence key), so this is
   * safe to retry: a duplicate insert returns `{ created: false }` rather than
   * creating a second event. That is the whole idempotency story at the API
   * boundary.
   */
  async insertEvent(
    calendarId: string,
    event: GoogleEventPayload,
  ): Promise<{ created: boolean; id: string }> {
    try {
      const body = await this.#request<{ id?: string }>(
        'insert event',
        'POST',
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        event,
      );
      return { created: true, id: body.id ?? (event.id as string) };
    } catch (error) {
      if (error instanceof GoogleApiError && error.kind === 'already_exists') {
        // Google keeps deleted event IDs reserved, so this also covers
        // re-inserting an event the user deleted by hand. The reconciler
        // decides whether to patch it back; here it is simply not an error.
        return { created: false, id: event.id as string };
      }
      throw error;
    }
  }

  /**
   * Update an existing event.
   *
   * PATCH, not PUT. A PUT would overwrite fields Google or the user set that
   * this app does not manage — a reminder the user added by hand, for one.
   */
  async patchEvent(
    calendarId: string,
    eventId: string,
    event: Partial<GoogleEventPayload>,
  ): Promise<{ id: string }> {
    const body = await this.#request<{ id?: string }>(
      'patch event',
      'PATCH',
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      event,
    );
    return { id: body.id ?? eventId };
  }

  /**
   * Delete an event, tolerating one that has already gone.
   *
   * A user may delete an event by hand between planning and execution, and a
   * delete that then fails would leave the row stuck in `deleting` forever.
   */
  async deleteEvent(
    calendarId: string,
    eventId: string,
  ): Promise<{ deleted: boolean; alreadyGone: boolean }> {
    try {
      await this.#request<void>(
        'delete event',
        'DELETE',
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
      return { deleted: true, alreadyGone: false };
    } catch (error) {
      if (error instanceof GoogleApiError && error.kind === 'not_found') {
        return { deleted: false, alreadyGone: true };
      }
      throw error;
    }
  }

  /** Fetch one event, or undefined if it is not there. */
  async getEvent(calendarId: string, eventId: string): Promise<ListedEvent | undefined> {
    try {
      const body = await this.#request<RawEvent>(
        'get event',
        'GET',
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
      return toListedEvent(body);
    } catch (error) {
      if (error instanceof GoogleApiError && error.kind === 'not_found') return undefined;
      throw error;
    }
  }

  /**
   * List the events this app manages on a calendar.
   *
   * Filtered by `privateExtendedProperty` so reconciliation only ever considers
   * its own events. Even on an app-created calendar a user can add their own
   * events, and those must not be deleted as "orphans".
   *
   * `showDeleted` is on: Google keeps cancelled events for a while, and knowing
   * that an event was cancelled is different from it never having existed.
   */
  async listManagedEvents(
    calendarId: string,
    params: {
      privateExtendedProperty?: string[];
      pageToken?: string;
      syncToken?: string;
      maxResults?: number;
      timeMin?: string;
      showDeleted?: boolean;
    } = {},
  ): Promise<EventPage> {
    const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
    const query = url.searchParams;
    query.set('maxResults', String(Math.min(params.maxResults ?? 250, MAX_PAGE_SIZE)));
    query.set('showDeleted', String(params.showDeleted ?? true));
    query.set('singleEvents', 'true');

    for (const property of params.privateExtendedProperty ?? []) {
      query.append('privateExtendedProperty', property);
    }
    if (params.pageToken) query.set('pageToken', params.pageToken);
    // A sync token cannot be combined with a time window; Google rejects it.
    if (params.syncToken) query.set('syncToken', params.syncToken);
    else if (params.timeMin) query.set('timeMin', params.timeMin);

    const body = await this.#request<{
      items?: RawEvent[];
      nextPageToken?: string;
      nextSyncToken?: string;
    }>('list events', 'GET', url.toString());

    return {
      events: (body.items ?? []).map(toListedEvent),
      nextPageToken: body.nextPageToken,
      nextSyncToken: body.nextSyncToken,
    };
  }

  /** Walk every page. Bounded, so a pagination bug cannot loop forever. */
  async listAllManagedEvents(
    calendarId: string,
    params: Parameters<GoogleCalendarClient['listManagedEvents']>[1] = {},
    maxPages = 40,
  ): Promise<{ events: ListedEvent[]; nextSyncToken: string | undefined; complete: boolean }> {
    const events: ListedEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.listManagedEvents(calendarId, {
        ...params,
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
      events.push(...result.events);
      nextSyncToken = result.nextSyncToken ?? nextSyncToken;
      if (!result.nextPageToken) return { events, nextSyncToken, complete: true };
      pageToken = result.nextPageToken;
    }

    // Ran out of pages rather than events: report it instead of pretending the
    // list is complete, because a caller that then deletes "orphans" would
    // delete real events.
    return { events, nextSyncToken, complete: false };
  }

  /* ----------------------------------------------------------- internal -- */

  async #request<T>(operation: string, method: string, url: string, body?: unknown): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.#accessToken}`,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (cause) {
        lastError = new GoogleTransportError(operation, cause);
        if (attempt < this.#maxAttempts) {
          await this.#sleep(backoffMilliseconds(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new GoogleTransportError(
            operation,
            new Error('Google returned a success status with a non-JSON body'),
          );
        }
      }

      const error = await toGoogleApiError(operation, response);
      lastError = error;

      if (!isRetryable(error) || attempt >= this.#maxAttempts) throw error;

      // Honour Google's own Retry-After when it sends one; it knows better than
      // a fixed schedule how long a quota window has left.
      const waitMilliseconds =
        error.retryAfterSeconds !== undefined
          ? error.retryAfterSeconds * 1000
          : backoffMilliseconds(attempt);
      await this.#sleep(waitMilliseconds);
    }

    throw lastError;
  }
}

interface RawEvent {
  id?: string;
  status?: string;
  summary?: string;
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
}

function toListedEvent(raw: RawEvent): ListedEvent {
  return {
    id: raw.id ?? '',
    status: raw.status,
    summary: raw.summary,
    updated: raw.updated,
    privateProperties: raw.extendedProperties?.private ?? {},
  };
}

/** Exponential backoff with jitter: 1s, 2s, 4s, … capped at 30s. */
export function backoffMilliseconds(attempt: number, cap = 30_000): number {
  const base = Math.min(cap, 1000 * 2 ** (attempt - 1));
  // Jitter so that a fleet of serverless functions retrying after one outage
  // does not arrive back in lockstep.
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
