/**
 * The first-run path: confirm a location, create the calendar, add a date.
 *
 * This file exists so the order of those steps lives in one place. Each of them
 * has a precondition the next depends on, and getting the order wrong produces
 * a failure that is hard to read: a date added before a location is confirmed
 * generates nothing, and a sync before the calendar exists is blocked with
 * `calendar_not_created_yet`.
 */
import {
  confirmLocationRow,
  getLocation,
  recordAuditEvent,
  saveLocation,
  updateDestinationCalendar,
  type CalendarLocationRow,
  type DatasetAccess,
} from '@hebrew-dates/db';
import {
  suggestLocationForTimezone,
  type CalculationLocation,
  type LocationSuggestion,
} from '@hebrew-dates/engine';
import {
  timezoneForCoordinates,
  type PlaceCandidate,
  type SearchOutcome,
} from '@hebrew-dates/geocoding';
import type { ServiceContext } from './context';
import { ensureGoogleCalendar } from './calendar-setup';
import { queueInitialBackfill } from './jobs';
import { createHebrewDate, type CreateHebrewDateInput } from './records';
import { syncDestination, type SyncResult } from './sync';
import { pendingSunsetDecision, type SunsetDecision } from './sunset-decision';

export interface SetupStatus {
  googleConnected: boolean;
  locationConfirmed: boolean;
  calendarCreated: boolean;
  hasDates: boolean;
  /** The next thing the user needs to do, or undefined when set up. */
  nextStep: 'connect_google' | 'confirm_location' | 'create_calendar' | 'add_date' | undefined;
}

export async function setupStatus(
  context: ServiceContext,
  access: DatasetAccess,
  params: { userId: string; destinationCalendarId: string },
): Promise<SetupStatus> {
  const [account, location, connection, dateCount] = await Promise.all([
    context.db
      .selectFrom('google_accounts')
      .select('connection_status')
      .where('user_id', '=', params.userId)
      .executeTakeFirst(),
    getLocation(context.db, access, params.destinationCalendarId),
    context.db
      .selectFrom('google_calendar_connections')
      .select('google_calendar_id')
      .where('destination_calendar_id', '=', params.destinationCalendarId)
      .executeTakeFirst(),
    context.db
      .selectFrom('source_records')
      .select(context.db.fn.countAll().as('count'))
      .where('dataset_id', '=', access.datasetId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst(),
  ]);

  const googleConnected = account?.connection_status === 'connected';
  const locationConfirmed = location?.confirmed_at !== null && location !== undefined;
  const calendarCreated = Boolean(connection?.google_calendar_id);
  const hasDates = Number(dateCount?.count ?? 0) > 0;

  return {
    googleConnected,
    locationConfirmed,
    calendarCreated,
    hasDates,
    nextStep: !googleConnected
      ? 'connect_google'
      : !locationConfirmed
        ? 'confirm_location'
        : !calendarCreated
          ? 'create_calendar'
          : !hasDates
            ? 'add_date'
            : undefined,
  };
}

/**
 * Propose a location from a browser time zone.
 *
 * Returned as a *suggestion* that must be confirmed, never saved as fact. A
 * time zone is not a place: `America/New_York` covers Maine to Michigan, and
 * sunset differs by nearly an hour across it. So the user sees what was guessed
 * and says yes.
 *
 * With real search available this is now only a starting point — a prefilled
 * guess above the search box, not the primary way to set a location.
 */
export function suggestLocation(timezoneId: string): LocationSuggestion | undefined {
  return suggestLocationForTimezone(timezoneId, 'timezone_suggestion');
}

export class PlaceNotFoundError extends Error {
  constructor() {
    super(
      'That place could not be found again. Please search once more and pick from the list.',
    );
  }
}

/**
 * Search for a place.
 *
 * Returns candidates only. Nothing is stored, and nothing about the user's
 * calculation location changes until they confirm one of these by its id.
 */
export async function searchPlaces(
  context: ServiceContext,
  params: { query: string; limit?: number; countryCodes?: string[] },
): Promise<SearchOutcome> {
  return context.geocoder.searchWithOutcome({
    query: params.query,
    limit: params.limit ?? 8,
    ...(params.countryCodes ? { countryCodes: params.countryCodes } : {}),
  });
}

/** The built-in cities, for a "or pick a nearby city" control. */
export async function listCataloguePlaces(
  context: ServiceContext,
): Promise<PlaceCandidate[]> {
  return context.geocoder.catalogue();
}

/**
 * Confirm a place the user picked from a search.
 *
 * The **id** is what the form sends, and the place is re-resolved from the
 * provider rather than reconstructed from coordinates that travelled through
 * the browser. That is the whole point of taking an id: a form cannot be edited
 * to store a location the user never saw, and the values written are values the
 * provider stands behind.
 *
 * The time zone is likewise the one derived from the resolved coordinates. A
 * time zone never arrives from the client and is never used *as* a location.
 */
export async function confirmPlaceById(
  context: ServiceContext,
  access: DatasetAccess,
  params: {
    destinationCalendarId: string;
    userId: string;
    placeId: string;
    /** The calendar's own display zone, kept separate from the location's. */
    calendarTimezoneHint?: string | null;
  },
): Promise<{ location: CalendarLocationRow; place: PlaceCandidate }> {
  const place = await context.geocoder.lookup(params.placeId);
  if (!place) throw new PlaceNotFoundError();

  const location = await confirmLocation(context, access, {
    destinationCalendarId: params.destinationCalendarId,
    userId: params.userId,
    location: {
      id: place.id,
      displayName: place.displayName,
      countryCode: place.countryCode,
      latitude: place.latitude,
      longitude: place.longitude,
      timezoneId: place.timezoneId,
      ...(place.elevationMeters !== undefined
        ? { elevationMeters: place.elevationMeters }
        : {}),
      useElevation: true,
      geocoderPlaceId: place.providerPlaceId,
      source: place.provider === 'catalogue' ? 'user_selected' : 'geocoded',
    },
    // Defaults to the place's own zone, which is right for the overwhelmingly
    // common case of one person with one calendar where they live.
    calendarTimezoneHint: params.calendarTimezoneHint ?? place.timezoneId,
    geocoder: place.provider,
    geocoderDisplayName: place.providerDisplayName,
  });

  return { location, place };
}

/**
 * Save a location the user has explicitly confirmed.
 *
 * `confirmedByUserId` is what turns a suggestion into something the sync
 * planner will act on, and it is a separate argument so it cannot be filled in
 * by accident alongside the coordinates.
 */
export async function confirmLocation(
  context: ServiceContext,
  access: DatasetAccess,
  params: {
    destinationCalendarId: string;
    userId: string;
    location: CalculationLocation;
    /** The calendar's own zone, kept separate from the location's. */
    calendarTimezoneHint?: string | null;
    /** Which provider resolved it, when one did. */
    geocoder?: string;
    /** What the provider called it, before tidying. */
    geocoderDisplayName?: string;
  },
): Promise<CalendarLocationRow> {
  // Re-derived from the coordinates rather than trusted. Everything downstream
  // renders instants in this zone, and a mismatched one would put an event on
  // the wrong day at the boundary.
  const timezoneId = timezoneForCoordinates(
    params.location.latitude,
    params.location.longitude,
  );

  const saved = await saveLocation(context.db, access, {
    destinationCalendarId: params.destinationCalendarId,
    location: {
      displayName: params.location.displayName,
      countryCode: params.location.countryCode,
      latitude: params.location.latitude,
      longitude: params.location.longitude,
      elevationMeters: params.location.elevationMeters ?? null,
      useElevation: params.location.useElevation ?? true,
      timezoneId,
      geocoderPlaceId: params.location.geocoderPlaceId ?? null,
      source: params.geocoder && params.geocoder !== 'catalogue' ? 'geocoded' : 'user_selected',
      ...(params.geocoder ? { geocoder: params.geocoder } : {}),
      ...(params.geocoderDisplayName
        ? { geocoderDisplayName: params.geocoderDisplayName }
        : {}),
    },
    confirmedByUserId: params.userId,
  });

  if (params.calendarTimezoneHint !== undefined) {
    await updateDestinationCalendar(context.db, access, params.destinationCalendarId, {
      calendarTimezoneHint: params.calendarTimezoneHint,
    });
  }

  await recordAuditEvent(
    context.db,
    {
      // The zone only. Coordinates are the user's own data and reveal where
      // they live to a precision an audit trail has no use for.
      action: 'location.confirmed',
      subjectType: 'destination_calendar',
      subjectId: params.destinationCalendarId,
      timezoneId,
      source: params.geocoder && params.geocoder !== 'catalogue' ? 'geocoded' : 'user_selected',
      ...(params.geocoder ? { geocoder: params.geocoder } : {}),
    },
    { actorUserId: params.userId, at: context.now() },
  );

  return saved;
}

/** Confirm a location already stored as a suggestion. */
export async function acceptSuggestedLocation(
  context: ServiceContext,
  access: DatasetAccess,
  params: { destinationCalendarId: string; userId: string },
): Promise<void> {
  await confirmLocationRow(context.db, access, params);

  const stored = await getLocation(context.db, access, params.destinationCalendarId);
  await recordAuditEvent(
    context.db,
    {
      action: 'location.confirmed',
      subjectType: 'destination_calendar',
      subjectId: params.destinationCalendarId,
      timezoneId: stored?.timezone_id ?? 'unknown',
      source: 'timezone_suggestion',
    },
    { actorUserId: params.userId, at: context.now() },
  );
}

export interface AddDateResult {
  sourceRecordId: string;
  occurrencesPersisted: number;
  hebrewYearsGenerated: number;
  requiresReview: boolean;
  sync: SyncResult;
  /**
   * True when the entry is a draft waiting on the sunset question. Nothing was
   * generated and nothing was written.
   */
  awaitingSunsetDecision: boolean;
  /**
   * The question to put to the user, when one is needed.
   *
   * Returned rather than thrown. "I do not know which side of sunset" is an
   * ordinary answer, and the user needs both candidates and the local sunset
   * time in front of them — not an error message.
   */
  sunsetDecision: SunsetDecision | undefined;
}

/**
 * The whole first-run flow after sign-in: calendar, date, synchronous sync.
 *
 * Two Hebrew years are written now and the remaining eighteen are queued. That
 * split is the product decision: the user must see their calendar populate on
 * the request that added the date, and nobody needs 2044 within two seconds.
 */
export async function addDateAndSync(
  context: ServiceContext,
  access: DatasetAccess,
  params: {
    userId: string;
    destinationCalendarId: string;
    date: CreateHebrewDateInput;
  },
): Promise<AddDateResult> {
  // Before the date, because generating occurrences needs a confirmed location
  // and writing them needs a calendar. Both are idempotent.
  await ensureGoogleCalendar(context, access, {
    destinationCalendarId: params.destinationCalendarId,
    userId: params.userId,
  });

  const created = await createHebrewDate(context, access, params.date);

  const sync = await syncDestination(context, access, {
    destinationCalendarId: params.destinationCalendarId,
    userId: params.userId,
  });

  // A draft generates nothing, so there is nothing to backfill yet either.
  if (!created.awaitingSunsetDecision) {
    await queueInitialBackfill(context, { datasetId: access.datasetId });
  }

  return {
    sourceRecordId: created.record.id,
    occurrencesPersisted: created.occurrencesPersisted,
    hebrewYearsGenerated: created.hebrewYearsGenerated,
    requiresReview: created.requiresReview,
    sync,
    awaitingSunsetDecision: created.awaitingSunsetDecision,
    sunsetDecision: created.awaitingSunsetDecision
      ? await pendingSunsetDecision(context, access, {
          sourceRecordId: created.record.id,
          destinationCalendarId: params.destinationCalendarId,
        })
      : undefined,
  };
}
