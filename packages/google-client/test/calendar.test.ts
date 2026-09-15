/**
 * The Calendar API client, against a faithful Google double.
 *
 * The behaviours under test are the ones that decide whether a user ends up
 * with duplicated events, missing events, or a sync stuck forever: idempotent
 * creates, tolerant deletes, PATCH-not-PUT, and retrying only what is worth
 * retrying.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { GoogleEventPayload } from '@hebrew-dates/google-calendar';
import {
  GoogleApiError,
  GoogleCalendarClient,
  GoogleTransportError,
  backoffMilliseconds,
} from '../src/index';
import { FakeGoogle } from './helpers/fake-google';

const CALENDAR_SUMMARY = 'Hebrew Dates';

/** Never actually sleep in tests; record what the client asked to wait. */
function instantSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (milliseconds: number) => {
      waits.push(milliseconds);
    },
  };
}

async function connectedClient(options: { maxAttempts?: number } = {}) {
  const google = new FakeGoogle();
  // Mint a token the fake will accept, with the calendar scope granted.
  const accessToken = await mintAccessToken(google);
  const timing = instantSleep();
  const client = new GoogleCalendarClient({
    accessToken,
    fetch: google.fetch,
    sleep: timing.sleep,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });
  return { google, client, accessToken, timing };
}

/** Run the real OAuth flow through the fake so the token is genuinely issued. */
async function mintAccessToken(google: FakeGoogle): Promise<string> {
  const { buildAuthorizationUrl, createPkcePair, createNonce, exchangeCode } = await import(
    '../src/index'
  );
  const config = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    redirectUri: google.redirectUri,
    fetch: google.fetch,
  };
  const pkce = createPkcePair();
  const code = google.authorize(
    buildAuthorizationUrl(config, {
      state: 's',
      codeChallenge: pkce.challenge,
      nonce: createNonce(),
    }),
  );
  const tokens = await exchangeCode(config, { code, codeVerifier: pkce.verifier });
  return tokens.accessToken;
}

const event = (id: string, overrides: Partial<GoogleEventPayload> = {}): GoogleEventPayload =>
  ({
    id,
    summary: 'Yahrzeit of Avraham ben Yitzchak',
    description: 'Managed by Hebrew Dates.',
    start: { dateTime: '2026-04-01T19:12:00+03:00', timeZone: 'Asia/Jerusalem' },
    end: { dateTime: '2026-04-02T19:13:00+03:00', timeZone: 'Asia/Jerusalem' },
    transparency: 'transparent',
    visibility: 'default',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 1440 }] },
    extendedProperties: {
      private: { hdOccurrenceKey: id, hdVersion: '1', hdContentHash: 'abc' },
    },
    ...overrides,
  }) as GoogleEventPayload;

describe('creating the application calendar', () => {
  it('creates a calendar and returns its id', async () => {
    const { google, client } = await connectedClient();
    const calendar = await client.createCalendar({
      summary: CALENDAR_SUMMARY,
      description: 'Hebrew birthdays and yahrzeits.',
      timeZone: 'Asia/Jerusalem',
    });

    expect(calendar.id).toContain('@group.calendar.google.com');
    expect(calendar.summary).toBe(CALENDAR_SUMMARY);
    expect(calendar.timeZone).toBe('Asia/Jerusalem');
    expect(google.calendarIds()).toContain(calendar.id);
  });

  it('sends the access token as a bearer credential', async () => {
    const { google, client, accessToken } = await connectedClient();
    await client.createCalendar({ summary: CALENDAR_SUMMARY });
    const request = google.requests.find((entry) => entry.url.endsWith('/calendars'));
    expect(request?.authorization).toBe(`Bearer ${accessToken}`);
  });

  it('cannot reach a calendar it did not create', async () => {
    // The whole point of calendar.app.created. Google reports someone else's
    // calendar as absent, not forbidden, so the app cannot even enumerate.
    const { google, client } = await connectedClient();
    google.addForeignCalendar('someone-else@group.calendar.google.com');

    const error = await client
      .getCalendar('someone-else@group.calendar.google.com')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).kind).toBe('not_found');
  });

  it('renames a calendar with PATCH, leaving other fields alone', async () => {
    const { google, client } = await connectedClient();
    const calendar = await client.createCalendar({
      summary: CALENDAR_SUMMARY,
      description: 'original description',
      timeZone: 'Asia/Jerusalem',
    });

    await client.patchCalendar(calendar.id, { summary: 'Hebrew Dates (family)' });
    const stored = google.calendar(calendar.id);
    expect(stored?.summary).toBe('Hebrew Dates (family)');
    // Not cleared: PATCH merges.
    expect(stored?.description).toBe('original description');
    expect(stored?.timeZone).toBe('Asia/Jerusalem');
  });

  it('reports an already-deleted calendar without failing', async () => {
    const { client } = await connectedClient();
    const calendar = await client.createCalendar({ summary: CALENDAR_SUMMARY });
    await expect(client.deleteCalendar(calendar.id)).resolves.toEqual({ deleted: true });
    await expect(client.deleteCalendar(calendar.id)).resolves.toEqual({ deleted: false });
  });

  it('refuses to be constructed without a token', () => {
    expect(() => new GoogleCalendarClient({ accessToken: '' })).toThrow(/needs an access token/);
  });

  it('classifies an expired access token as needing re-authorisation', async () => {
    const google = new FakeGoogle();
    const client = new GoogleCalendarClient({
      accessToken: 'never-issued',
      fetch: google.fetch,
      maxAttempts: 1,
    });
    const error = await client
      .createCalendar({ summary: CALENDAR_SUMMARY })
      .catch((caught: unknown) => caught);
    expect((error as GoogleApiError).kind).toBe('auth_required');
    expect((error as GoogleApiError).requiresReauth).toBe(true);
  });
});

describe('writing events', () => {
  let google: FakeGoogle;
  let client: GoogleCalendarClient;
  let calendarId: string;

  beforeEach(async () => {
    const connected = await connectedClient();
    google = connected.google;
    client = connected.client;
    calendarId = (await client.createCalendar({ summary: CALENDAR_SUMMARY })).id;
  });

  it('inserts an event at the id the caller chose', async () => {
    const result = await client.insertEvent(calendarId, event('abc123'));
    expect(result).toEqual({ created: true, id: 'abc123' });
    expect(google.calendar(calendarId)?.events.has('abc123')).toBe(true);
  });

  it('is idempotent: a repeated insert does not duplicate the event', async () => {
    // The failure this prevents is a person seeing their grandfather's yahrzeit
    // twice because a function timed out after the write reached Google.
    await client.insertEvent(calendarId, event('abc123'));
    const second = await client.insertEvent(calendarId, event('abc123'));

    expect(second).toEqual({ created: false, id: 'abc123' });
    expect(google.calendar(calendarId)?.events.size).toBe(1);
  });

  it('treats a re-insert of a deleted event as already existing', async () => {
    // Google reserves event IDs after deletion, forever. An insert here can
    // never succeed, so it must not be reported as a failure to retry.
    await client.insertEvent(calendarId, event('abc123'));
    await client.deleteEvent(calendarId, 'abc123');

    const again = await client.insertEvent(calendarId, event('abc123'));
    expect(again).toEqual({ created: false, id: 'abc123' });
  });

  it('updates an event with PATCH, so unmanaged fields survive', async () => {
    await client.insertEvent(calendarId, event('abc123'));
    await client.patchEvent(calendarId, 'abc123', {
      summary: 'Yahrzeit of Avraham ben Yitzchak (corrected)',
    });

    const stored = google.calendar(calendarId)?.events.get('abc123');
    expect(stored?.summary).toBe('Yahrzeit of Avraham ben Yitzchak (corrected)');
    // The extended properties were not in the patch and must remain.
    expect(stored?.extendedProperties?.private?.hdOccurrenceKey).toBe('abc123');

    const patchRequest = google.requests.filter((entry) => entry.method === 'PATCH').at(-1);
    expect(patchRequest?.method).toBe('PATCH');
  });

  it('deletes an event', async () => {
    await client.insertEvent(calendarId, event('abc123'));
    await expect(client.deleteEvent(calendarId, 'abc123')).resolves.toEqual({
      deleted: true,
      alreadyGone: false,
    });
  });

  it('tolerates deleting an event the user already removed by hand', async () => {
    // Otherwise the row sits in `deleting` forever and the dashboard shows a
    // permanent error for something that is already in the desired state.
    await client.insertEvent(calendarId, event('abc123'));
    await client.deleteEvent(calendarId, 'abc123');
    await expect(client.deleteEvent(calendarId, 'abc123')).resolves.toEqual({
      deleted: false,
      alreadyGone: true,
    });
  });

  it('returns undefined for an event that is not there', async () => {
    await expect(client.getEvent(calendarId, 'never-existed')).resolves.toBeUndefined();
  });

  it('url-encodes ids, so a calendar id with an @ is addressed correctly', async () => {
    await client.insertEvent(calendarId, event('abc123'));
    const request = google.requests.find(
      (entry) => entry.method === 'POST' && entry.url.includes('/events'),
    );
    expect(request?.url).toContain(encodeURIComponent(calendarId));
    expect(request?.url).not.toContain(`/calendars/${calendarId}/`);
  });
});

describe('listing managed events', () => {
  let google: FakeGoogle;
  let client: GoogleCalendarClient;
  let calendarId: string;

  beforeEach(async () => {
    const connected = await connectedClient();
    google = connected.google;
    client = connected.client;
    calendarId = (await client.createCalendar({ summary: CALENDAR_SUMMARY })).id;
  });

  it('returns this app\'s events with their private properties', async () => {
    await client.insertEvent(calendarId, event('key-one'));
    await client.insertEvent(calendarId, event('key-two'));

    const page = await client.listManagedEvents(calendarId, {
      privateExtendedProperty: ['hdVersion=1'],
    });

    expect(page.events.map((entry) => entry.id).sort()).toEqual(['key-one', 'key-two']);
    expect(page.events[0]?.privateProperties.hdVersion).toBe('1');
  });

  it('excludes events the app did not create', async () => {
    // Reconciliation deletes events it does not recognise. If the filter were
    // wrong, it would delete the user's own entries from their own calendar.
    await client.insertEvent(calendarId, event('key-one'));
    google.addUserEvent(calendarId, 'users-own-event', 'Dentist');

    const page = await client.listManagedEvents(calendarId, {
      privateExtendedProperty: ['hdVersion=1'],
    });
    expect(page.events.map((entry) => entry.id)).toEqual(['key-one']);
  });

  it('sends the private-property filter as a repeated query parameter', async () => {
    await client.listManagedEvents(calendarId, {
      privateExtendedProperty: ['hdVersion=1', 'hdDataset=abc'],
    });
    const request = google.requests.filter((entry) => entry.method === 'GET').at(-1);
    const query = new URL(request?.url as string).searchParams;
    expect(query.getAll('privateExtendedProperty')).toEqual(['hdVersion=1', 'hdDataset=abc']);
  });

  it('includes cancelled events by default', async () => {
    // Knowing an event was cancelled is different from it never existing: the
    // reconciler needs to tell "user deleted this" from "we never wrote it".
    await client.insertEvent(calendarId, event('key-one'));
    await client.deleteEvent(calendarId, 'key-one');

    const withDeleted = await client.listManagedEvents(calendarId);
    expect(withDeleted.events.find((entry) => entry.id === 'key-one')?.status).toBe('cancelled');

    const withoutDeleted = await client.listManagedEvents(calendarId, { showDeleted: false });
    expect(withoutDeleted.events.map((entry) => entry.id)).not.toContain('key-one');
  });

  it('walks every page', async () => {
    for (let index = 0; index < 25; index += 1) {
      await client.insertEvent(calendarId, event(`key-${index}`));
    }
    google.pageSize = 7;

    const all = await client.listAllManagedEvents(calendarId);
    expect(all.events).toHaveLength(25);
    expect(all.complete).toBe(true);
    expect(all.nextSyncToken).toBe('sync-token-1');
  });

  it('reports an incomplete walk rather than pretending it finished', async () => {
    // A caller that deletes "orphans" must never act on a truncated list.
    for (let index = 0; index < 25; index += 1) {
      await client.insertEvent(calendarId, event(`key-${index}`));
    }
    google.pageSize = 2;

    const partial = await client.listAllManagedEvents(calendarId, {}, 3);
    expect(partial.complete).toBe(false);
    expect(partial.events).toHaveLength(6);
  });

  it('caps the page size at Google\'s maximum', async () => {
    await client.listManagedEvents(calendarId, { maxResults: 999_999 });
    const request = google.requests.filter((entry) => entry.method === 'GET').at(-1);
    expect(new URL(request?.url as string).searchParams.get('maxResults')).toBe('2500');
  });

  it('does not combine a sync token with a time window', async () => {
    // Google rejects the combination outright.
    await client.listManagedEvents(calendarId, {
      syncToken: 'token',
      timeMin: '2026-01-01T00:00:00Z',
    });
    const query = new URL(
      google.requests.filter((entry) => entry.method === 'GET').at(-1)?.url as string,
    ).searchParams;
    expect(query.get('syncToken')).toBe('token');
    expect(query.get('timeMin')).toBeNull();
  });
});

describe('retrying', () => {
  it('retries a 500 and then succeeds', async () => {
    const { google, client, timing } = await connectedClient();
    google.failures.push({ match: /\/calendars$/, status: 500 });

    const calendar = await client.createCalendar({ summary: CALENDAR_SUMMARY });
    expect(calendar.id).toBeTruthy();
    expect(timing.waits).toHaveLength(1);
  });

  it('retries a rate limit and honours Retry-After', async () => {
    const { google, client, timing } = await connectedClient();
    google.failures.push({ match: /\/calendars$/, status: 403, reason: 'rateLimitExceeded' });

    await client.createCalendar({ summary: CALENDAR_SUMMARY });
    // Google's own header, not our schedule: it knows how long the window has.
    expect(timing.waits).toEqual([2000]);
  });

  it('does not retry a permission failure', async () => {
    // 403 insufficientPermissions must never be retried: it cannot succeed, and
    // retrying burns the quota that the rest of the sync needs.
    const { google, client, timing } = await connectedClient();
    google.failures.push({
      match: /\/calendars$/,
      status: 403,
      reason: 'insufficientPermissions',
      times: 5,
    });

    const error = await client
      .createCalendar({ summary: CALENDAR_SUMMARY })
      .catch((caught: unknown) => caught);
    expect((error as GoogleApiError).kind).toBe('auth_required');
    expect(timing.waits).toEqual([]);
  });

  it('does not retry an invalid request', async () => {
    const { google, client, timing } = await connectedClient();
    google.failures.push({ match: /\/events$/, status: 400, reason: 'invalid', times: 5 });
    const calendarId = (await client.createCalendar({ summary: CALENDAR_SUMMARY })).id;

    await expect(client.insertEvent(calendarId, event('abc'))).rejects.toThrow(GoogleApiError);
    expect(timing.waits).toEqual([]);
  });

  it('gives up after the attempt budget and reports the last failure', async () => {
    const { google, client, timing } = await connectedClient({ maxAttempts: 3 });
    google.failures.push({ match: /\/calendars$/, status: 503, times: 10 });

    const error = await client
      .createCalendar({ summary: CALENDAR_SUMMARY })
      .catch((caught: unknown) => caught);
    expect((error as GoogleApiError).status).toBe(503);
    expect((error as GoogleApiError).retryable).toBe(true);
    // Three attempts means two waits.
    expect(timing.waits).toHaveLength(2);
  });

  it('retries a network failure', async () => {
    const { google, client, timing } = await connectedClient();
    google.networkFailures.push({ match: /\/calendars$/ });

    await expect(client.createCalendar({ summary: CALENDAR_SUMMARY })).resolves.toBeDefined();
    expect(timing.waits).toHaveLength(1);
  });

  it('surfaces a persistent network failure as transient, so the job retries', async () => {
    const { google, client } = await connectedClient({ maxAttempts: 2 });
    google.networkFailures.push({ match: /\/calendars$/, times: 10 });

    const error = await client
      .createCalendar({ summary: CALENDAR_SUMMARY })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleTransportError);
    expect((error as GoogleTransportError).retryable).toBe(true);
  });

  it('never retries when the budget is one attempt', async () => {
    const { google, client, timing } = await connectedClient({ maxAttempts: 1 });
    google.failures.push({ match: /\/calendars$/, status: 503 });
    await expect(client.createCalendar({ summary: CALENDAR_SUMMARY })).rejects.toThrow();
    expect(timing.waits).toEqual([]);
  });
});

describe('backoff', () => {
  it('grows exponentially and stays within the cap', () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const wait = backoffMilliseconds(attempt);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(30_000);
    }
    // The floor grows with the attempt number.
    const early = Array.from({ length: 50 }, () => backoffMilliseconds(1));
    const later = Array.from({ length: 50 }, () => backoffMilliseconds(4));
    expect(Math.min(...later)).toBeGreaterThan(Math.min(...early));
  });

  it('jitters, so retries do not arrive in lockstep after an outage', () => {
    const waits = new Set(Array.from({ length: 50 }, () => backoffMilliseconds(3)));
    expect(waits.size).toBeGreaterThan(5);
  });
});
