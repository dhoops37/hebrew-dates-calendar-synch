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
import type { ServiceContext } from './context';
import { ensureGoogleCalendar } from './calendar-setup';
import { queueInitialBackfill } from './jobs';
import { createHebrewDate, type CreateHebrewDateInput } from './records';
import { syncDestination, type SyncResult } from './sync';

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
 */
export function suggestLocation(timezoneId: string): LocationSuggestion | undefined {
  return suggestLocationForTimezone(timezoneId, 'timezone_suggestion');
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
  },
): Promise<CalendarLocationRow> {
  const saved = await saveLocation(context.db, access, {
    destinationCalendarId: params.destinationCalendarId,
    location: {
      displayName: params.location.displayName,
      countryCode: params.location.countryCode,
      latitude: params.location.latitude,
      longitude: params.location.longitude,
      elevationMeters: params.location.elevationMeters ?? null,
      useElevation: params.location.useElevation ?? true,
      timezoneId: params.location.timezoneId,
      geocoderPlaceId: params.location.geocoderPlaceId ?? null,
      source: 'user_selected',
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
      timezoneId: params.location.timezoneId,
      source: 'user_selected',
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
  await recordAuditEvent(
    context.db,
    {
      action: 'location.confirmed',
      subjectType: 'destination_calendar',
      subjectId: params.destinationCalendarId,
      timezoneId: params.timezoneId,
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

  // The remaining years, in the background.
  await queueInitialBackfill(context, { datasetId: access.datasetId });

  return {
    sourceRecordId: created.record.id,
    occurrencesPersisted: created.occurrencesPersisted,
    hebrewYearsGenerated: created.hebrewYearsGenerated,
    requiresReview: created.requiresReview,
    sync,
  };
}
