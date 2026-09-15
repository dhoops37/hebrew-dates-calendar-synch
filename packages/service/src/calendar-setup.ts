/**
 * Creating the application's own Google calendar.
 *
 * This is the moment the app gains any calendar access at all. Under
 * `calendar.app.created` it can only touch calendars it created, so until this
 * call succeeds there is nowhere to write — and the sync planner blocks with
 * `calendar_not_created_yet` rather than guessing.
 *
 * A dedicated calendar rather than the user's primary one is a product
 * decision as much as a permission one: the user can hide, colour, share or
 * unsubscribe from the whole thing in one action, and nothing this app does can
 * disturb their appointments.
 */
import { getDestinationCalendar, recordAudit, type DatasetAccess } from '@hebrew-dates/db';
import { GoogleApiError } from '@hebrew-dates/google-client';
import { liveAccessToken } from './tokens';
import type { ServiceContext } from './context';

export const CALENDAR_SUMMARY = 'Hebrew Dates';
export const CALENDAR_DESCRIPTION =
  'Hebrew birthdays and yahrzeits, kept on the correct Gregorian date each year. ' +
  'Managed by Hebrew Dates — changes made here may be overwritten.';

export interface EnsureCalendarResult {
  googleCalendarId: string;
  /** False when the calendar already existed, so this call did nothing. */
  created: boolean;
}

/**
 * Create the calendar if this destination does not have one yet.
 *
 * Idempotent, and deliberately not idempotent-by-retry: if the row already
 * names a calendar, that calendar is verified rather than a second one created.
 * Creating a duplicate would leave the user with two "Hebrew Dates" calendars
 * and half their events in each.
 */
export async function ensureGoogleCalendar(
  context: ServiceContext,
  access: DatasetAccess,
  params: { destinationCalendarId: string; userId: string },
): Promise<EnsureCalendarResult> {
  const destination = await getDestinationCalendar(
    context.db,
    access,
    params.destinationCalendarId,
  );

  const token = await liveAccessToken(context, params.userId);
  const client = context.calendarClient(token.accessToken);

  const existing = await context.db
    .selectFrom('google_calendar_connections')
    .selectAll()
    .where('destination_calendar_id', '=', params.destinationCalendarId)
    .executeTakeFirst();

  if (existing?.google_calendar_id) {
    // Confirm it is still there. A user can delete the calendar from Google's
    // own UI, and continuing to write to a dead ID would produce a wall of 404s
    // rather than the one clear "it was deleted" this recovers from.
    try {
      await client.getCalendar(existing.google_calendar_id);
      return { googleCalendarId: existing.google_calendar_id, created: false };
    } catch (error) {
      if (!(error instanceof GoogleApiError) || error.kind !== 'not_found') throw error;

      await context.db
        .updateTable('google_calendar_connections')
        .set({
          google_calendar_id: null,
          last_error: 'The calendar was deleted in Google Calendar; recreating.',
          updated_at: context.now(),
        })
        .where('id', '=', existing.id)
        .execute();

      // Every event we believed existed is gone with it. Clearing the external
      // IDs makes the planner recreate them rather than trying to patch events
      // in a calendar that no longer exists.
      await context.db
        .updateTable('destination_events')
        .set({
          external_event_id: null,
          external_calendar_id: null,
          sync_status: 'pending',
          attempt_count: 0,
          next_attempt_at: null,
          updated_at: context.now(),
        })
        .where('destination_calendar_id', '=', params.destinationCalendarId)
        .execute();
    }
  }

  const created = await client.createCalendar({
    summary: destination.name || CALENDAR_SUMMARY,
    description: CALENDAR_DESCRIPTION,
    // The calendar's own display zone. Never a sunset input: events carry
    // absolute instants. Falls back to the location's zone when no hint is set.
    ...(await displayTimezoneFor(context, access, params.destinationCalendarId)),
  });

  const account = await context.db
    .selectFrom('google_accounts')
    .select('id')
    .where('user_id', '=', params.userId)
    .executeTakeFirstOrThrow();

  await context.db
    .insertInto('google_calendar_connections')
    .values({
      destination_calendar_id: params.destinationCalendarId,
      google_account_id: account.id,
      google_calendar_id: created.id,
      created_by_app: true,
      last_error: null,
    })
    .onConflict((oc) =>
      oc.column('destination_calendar_id').doUpdateSet({
        google_account_id: account.id,
        google_calendar_id: created.id,
        last_error: null,
        updated_at: context.now(),
      }),
    )
    .execute();

  await recordAudit(context.db, {
    actorUserId: params.userId,
    action: 'calendar.created',
    subjectType: 'destination_calendar',
    subjectId: params.destinationCalendarId,
    detail: { googleCalendarId: created.id, summary: created.summary },
  });

  return { googleCalendarId: created.id, created: true };
}

async function displayTimezoneFor(
  context: ServiceContext,
  access: DatasetAccess,
  destinationCalendarId: string,
): Promise<{ timeZone?: string }> {
  const row = await context.db
    .selectFrom('destination_calendars')
    .leftJoin(
      'calendar_locations',
      'calendar_locations.destination_calendar_id',
      'destination_calendars.id',
    )
    .select([
      'destination_calendars.calendar_timezone_hint as hint',
      'calendar_locations.timezone_id as location_zone',
    ])
    .where('destination_calendars.id', '=', destinationCalendarId)
    .where('destination_calendars.dataset_id', '=', access.datasetId)
    .executeTakeFirst();

  const timeZone = row?.hint ?? row?.location_zone;
  return timeZone ? { timeZone } : {};
}

/** The Google calendar a destination writes to, or undefined if none yet. */
export async function googleCalendarIdFor(
  context: ServiceContext,
  destinationCalendarId: string,
): Promise<string | undefined> {
  const row = await context.db
    .selectFrom('google_calendar_connections')
    .select('google_calendar_id')
    .where('destination_calendar_id', '=', destinationCalendarId)
    .executeTakeFirst();
  return row?.google_calendar_id ?? undefined;
}
