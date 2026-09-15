/**
 * The sync runner: plan, execute, persist.
 *
 * Three stages, kept separate because each fails differently.
 *
 *  1. **Project.** Read the stored occurrences and render them for this
 *     destination. Pure; no I/O beyond the database read.
 *  2. **Plan.** `planSync` compares desired against stored actual and returns
 *     actions. Pure and total: it decides what *should* happen, including
 *     refusing to do anything when the location is unconfirmed or the calendar
 *     does not exist yet.
 *  3. **Execute.** Issue the writes, and persist the outcome of each one
 *     individually.
 *
 * The critical property is that stage 3 records each result as it happens
 * rather than at the end. A serverless function can be killed mid-run, and the
 * difference between "we wrote it and recorded it" and "we wrote it and lost
 * the record" is a duplicate event in someone's calendar. Because the event ID
 * is derived from the occurrence key, even the lost-record case recovers: the
 * retried insert returns 409 and the row is reconciled rather than duplicated.
 *
 * Convergent, not event-sourced. Every run asks "what is the difference between
 * what should exist and what does" and closes the gap. There is no queue of
 * pending mutations to get out of order, and an interrupted run is simply a run
 * that left more work for the next one.
 */
import {
  getDestinationCalendar,
  listSourceRecords,
  markEventFailed,
  markEventSynced,
  deleteDestinationEventRow,
  getReminders,
  upsertDestinationEvent,
  type DatasetAccess,
  type SourceRecordRow,
} from '@hebrew-dates/db';
import {
  hebrewDateLabels,
  renderForDestination,
  type DestinationEvent,
  type HebrewMonthNumber,
} from '@hebrew-dates/engine';
import { toGoogleEvent } from '@hebrew-dates/google-calendar';
import { GoogleApiError, isRetryable, requiresReauth } from '@hebrew-dates/google-client';
import {
  nextAttemptAt,
  planSync,
  type StoredDestinationEvent,
  type SyncAction,
  type SyncPlan,
} from '@hebrew-dates/sync';
import type { ServiceContext } from './context';
import { googleCalendarIdFor } from './calendar-setup';
import { destinationLocation } from './records';
import { ReauthRequiredError, liveAccessToken } from './tokens';

/**
 * Writes per pass.
 *
 * Chosen against Vercel's function timeout rather than Google's rate limit: at
 * roughly 150ms per call this is about 30 seconds of work, which leaves room in
 * a 60-second budget. The planner orders nearest-first, so a truncated pass
 * always keeps the years the user is about to need.
 */
export const DEFAULT_MAX_WRITES = 200;

/**
 * The `content_hash` of a row that has been staged but never successfully
 * written. 32 zeroes: the column is `char(32)` and a real hash is hex, so this
 * is a value the engine can never produce.
 */
export const UNWRITTEN_CONTENT_HASH = '0'.repeat(32);

export interface SyncResult {
  destinationCalendarId: string;
  plan: SyncPlan;
  created: number;
  updated: number;
  deleted: number;
  failed: number;
  /** True when the write budget or a backoff left work behind. */
  hasMoreWork: boolean;
  blocked: SyncPlan['blocked'];
  /** Set when the run stopped because the Google grant is no longer usable. */
  needsReauth: boolean;
}

export interface SyncOptions {
  maxWrites?: number;
  /** Skips the Google calls. Used to show a user what a run would do. */
  dryRun?: boolean;
}

/**
 * Bring one destination calendar in line with the dataset.
 *
 * Safe to call repeatedly: a run with nothing to do issues no writes at all,
 * because the content hash comparison happens before any network call.
 */
export async function syncDestination(
  context: ServiceContext,
  access: DatasetAccess,
  params: { destinationCalendarId: string; userId: string },
  options: SyncOptions = {},
): Promise<SyncResult> {
  const now = context.now();
  const destination = await getDestinationCalendar(
    context.db,
    access,
    params.destinationCalendarId,
  );

  const location = await destinationLocation(context, access, params.destinationCalendarId);
  const externalCalendarId = await googleCalendarIdFor(context, params.destinationCalendarId);
  const connectionStatus = await destinationConnectionStatus(context, params.userId);

  const projection: Projection =
    location && location.confirmedByUser
      ? await projectDesiredEvents(context, access, {
          destinationCalendarId: params.destinationCalendarId,
          location,
          displayMode: destination.display_mode,
          language: destination.language,
          visibility: destination.event_visibility,
          calendarTimezoneHint: destination.calendar_timezone_hint,
        })
      : { events: [], typeByOccurrenceKey: new Map() };
  const desired = projection.events;

  const actual = await readStoredEvents(context, access, params.destinationCalendarId);

  const plan = planSync({
    destinationCalendarId: params.destinationCalendarId,
    externalCalendarId: externalCalendarId ?? null,
    desired,
    actual,
    nowEpochMs: now.getTime(),
    // The planner refuses to write anything without this. It is the "never
    // silently choose a location" rule, enforced one layer below the UI.
    locationConfirmed: location?.confirmedByUser === true,
    connectionStatus,
    maxWrites: options.maxWrites ?? DEFAULT_MAX_WRITES,
  });

  const result: SyncResult = {
    destinationCalendarId: params.destinationCalendarId,
    plan,
    created: 0,
    updated: 0,
    deleted: 0,
    failed: 0,
    hasMoreWork: plan.hasMoreWork,
    blocked: plan.blocked,
    needsReauth: false,
  };

  if (plan.blocked || plan.summary.writes === 0 || options.dryRun) return result;

  // Persist the desired state before writing anything, so a killed function
  // leaves rows that describe what should exist rather than nothing at all.
  const rowIds = await stageDesiredEvents(context, access, {
    destinationCalendarId: params.destinationCalendarId,
    externalCalendarId: externalCalendarId ?? null,
    plan,
    desired,
  });

  let accessToken: string;
  try {
    accessToken = (await liveAccessToken(context, params.userId)).accessToken;
  } catch (error) {
    if (error instanceof ReauthRequiredError) return { ...result, needsReauth: true };
    throw error;
  }
  const client = context.calendarClient(accessToken);
  const targetCalendarId = externalCalendarId as string;

  for (const action of plan.actions) {
    if (action.type === 'noop' || action.type === 'skip') continue;

    const rowId = rowIds.get(action.occurrenceKey);
    try {
      if (action.type === 'create' || action.type === 'update') {
        const payload = toGoogleEvent(action.event, {
          reminders: await remindersFor(context, {
            destinationCalendarId: params.destinationCalendarId,
            sourceRecordId: action.event.sourceRecordId,
            eventType: projection.typeByOccurrenceKey.get(action.occurrenceKey) ?? 'birthday',
          }),
          sourceUrl: `${context.appUrl}/dates/${action.event.sourceRecordId}`,
        });

        if (action.type === 'create') {
          const inserted = await client.insertEvent(targetCalendarId, payload);
          // `created: false` means the ID was taken — a previous attempt did
          // reach Google. Patch it so the content is right either way.
          if (!inserted.created) {
            await client.patchEvent(targetCalendarId, payload.id, payload);
          }
          result.created += 1;
        } else {
          try {
            await client.patchEvent(targetCalendarId, action.externalEventId, payload);
            result.updated += 1;
          } catch (error) {
            // The user deleted this one event by hand. Convergence means
            // putting it back, not recording a permanent failure for something
            // that simply is not there.
            if (!(error instanceof GoogleApiError) || error.kind !== 'not_found') throw error;
            await client.insertEvent(targetCalendarId, payload);
            result.created += 1;
          }
        }

        if (rowId) {
          await markEventSynced(context.db, {
            destinationEventId: rowId,
            externalEventId: payload.id,
            externalCalendarId: targetCalendarId,
            contentHash: action.event.contentHash,
          });
        }
        continue;
      }

      // delete
      await client.deleteEvent(action.externalCalendarId ?? targetCalendarId, action.externalEventId);
      if (rowId) await deleteDestinationEventRow(context.db, rowId);
      result.deleted += 1;
    } catch (error) {
      result.failed += 1;

      if (requiresReauth(error)) {
        // Nothing else in this run can succeed either. Stop rather than
        // burning the attempt counter of every remaining event.
        result.needsReauth = true;
        result.hasMoreWork = true;
        if (rowId) await recordFailure(context, rowId, error, now);
        break;
      }

      if (rowId) await recordFailure(context, rowId, error, now);
      if (!isRetryable(error) && !(error instanceof GoogleApiError)) throw error;
    }
  }

  return result;
}

/** Sync every active destination in a dataset. */
export async function syncDataset(
  context: ServiceContext,
  access: DatasetAccess,
  params: { userId: string },
  options: SyncOptions = {},
): Promise<SyncResult[]> {
  const destinations = await context.db
    .selectFrom('destination_calendars')
    .select('id')
    .where('dataset_id', '=', access.datasetId)
    .where('active', '=', true)
    .orderBy('created_at')
    .execute();

  const results: SyncResult[] = [];
  for (const destination of destinations) {
    results.push(
      await syncDestination(
        context,
        access,
        { destinationCalendarId: destination.id, userId: params.userId },
        options,
      ),
    );
  }
  return results;
}

/* ------------------------------------------------------------ projection -- */

interface ProjectionParams {
  destinationCalendarId: string;
  location: NonNullable<Awaited<ReturnType<typeof destinationLocation>>>;
  displayMode: 'exact_sunset' | 'two_day_all_day';
  language: 'en' | 'he';
  visibility: 'default' | 'private';
  calendarTimezoneHint: string | null;
}

/**
 * Render every stored occurrence for one destination.
 *
 * Reads `generated_occurrences` rather than recomputing from the engine: the
 * database is the source of truth, so a manual override or a correction stored
 * last month is reflected here without being recalculated away.
 */
export interface Projection {
  events: DestinationEvent[];
  /** Occurrence key to the type of the record it belongs to. */
  typeByOccurrenceKey: Map<string, SourceRecordRow['type']>;
}

export async function projectDesiredEvents(
  context: ServiceContext,
  access: DatasetAccess,
  params: ProjectionParams,
): Promise<Projection> {
  const records = await listSourceRecords(context.db, access);
  const activeById = new Map(
    records.filter((record) => record.active).map((record) => [record.id, record] as const),
  );
  if (activeById.size === 0) return { events: [], typeByOccurrenceKey: new Map() };

  const rows = await context.db
    .selectFrom('generated_occurrences')
    .innerJoin('source_records', 'source_records.id', 'generated_occurrences.source_record_id')
    .selectAll('generated_occurrences')
    .where('source_records.dataset_id', '=', access.datasetId)
    .where('source_records.deleted_at', 'is', null)
    .where('source_records.active', '=', true)
    .orderBy('generated_occurrences.gregorian_date')
    .execute();

  const events: DestinationEvent[] = [];
  const typeByOccurrenceKey = new Map<string, SourceRecordRow['type']>();
  for (const row of rows) {
    const record = activeById.get(row.source_record_id);
    if (!record) continue;

    typeByOccurrenceKey.set(row.occurrence_key, record.type);
    const hebrewDate = {
      year: row.hebrew_year,
      month: row.hebrew_month as HebrewMonthNumber,
      day: row.hebrew_day,
    };
    events.push(
      renderForDestination(
        {
          key: row.occurrence_key,
          sourceRecordId: row.source_record_id,
          hebrewYear: row.hebrew_year,
          sequence: row.sequence,
          hebrewDate,
          // Rebuilt rather than stored: the labels are a pure function of the
          // Hebrew date, so storing them would be a second source of truth.
          labels: hebrewDateLabels(hebrewDate),
          gregorianDate: parseCivilDate(row.gregorian_date),
          precedingGregorianDate: addDays(parseCivilDate(row.gregorian_date), -1),
          followingGregorianDate: addDays(parseCivilDate(row.gregorian_date), 1),
          ruleApplied: row.rule_applied as never,
          ambiguities: (row.ambiguities ?? []) as never,
          isManualOverride: row.is_manual_override,
          calculationVersion: row.calculation_version,
        },
        {
          type: record.type,
          displayName: record.display_name,
          ...(record.notes ? { notes: record.notes } : {}),
          ...(record.custom_title ? { customTitle: record.custom_title } : {}),
        },
        {
          id: params.destinationCalendarId,
          destinationType: 'google',
          location: params.location,
          // A per-record override beats the calendar's setting.
          displayMode: record.display_mode_override ?? params.displayMode,
          language: params.language,
          visibility: params.visibility,
          ...(params.calendarTimezoneHint
            ? { calendarTimezoneHint: params.calendarTimezoneHint }
            : {}),
        },
      ),
    );
  }

  return { events, typeByOccurrenceKey };
}

/* ------------------------------------------------------------ persistence -- */

/** Project our own rows into the shape the planner compares against. */
async function readStoredEvents(
  context: ServiceContext,
  access: DatasetAccess,
  destinationCalendarId: string,
): Promise<StoredDestinationEvent[]> {
  const rows = await context.db
    .selectFrom('destination_events')
    .innerJoin(
      'generated_occurrences',
      'generated_occurrences.id',
      'destination_events.generated_occurrence_id',
    )
    .innerJoin('source_records', 'source_records.id', 'generated_occurrences.source_record_id')
    .select([
      'destination_events.id as id',
      'destination_events.external_calendar_id as external_calendar_id',
      'destination_events.external_event_id as external_event_id',
      'destination_events.content_hash as content_hash',
      'destination_events.sync_status as sync_status',
      'destination_events.attempt_count as attempt_count',
      'destination_events.next_attempt_at as next_attempt_at',
      'destination_events.start_at as start_at',
      'generated_occurrences.occurrence_key as occurrence_key',
      'generated_occurrences.gregorian_date as gregorian_date',
    ])
    .where('destination_events.destination_calendar_id', '=', destinationCalendarId)
    .where('source_records.dataset_id', '=', access.datasetId)
    .execute();

  return rows.map((row) => ({
    occurrenceKey: row.occurrence_key,
    destinationCalendarId,
    externalCalendarId: row.external_calendar_id,
    externalEventId: row.external_event_id,
    contentHash: row.content_hash,
    syncStatus: row.sync_status,
    attemptCount: row.attempt_count,
    nextAttemptAtEpochMs: row.next_attempt_at?.getTime() ?? null,
    startAtEpochMs: row.start_at?.getTime() ?? null,
    // Midnight UTC of the covered day: a coarse but reliable "is this past"
    // signal that works for all-day events too.
    gregorianDateEpochMs: Date.parse(`${row.gregorian_date}T00:00:00Z`),
  }));
}

/**
 * Write the intended state of every event the plan will touch, before touching
 * Google.
 *
 * A killed function then leaves rows that say what should exist, in a status the
 * next run recognises as incomplete — rather than leaving no trace of a write
 * that may already have reached Google.
 */
async function stageDesiredEvents(
  context: ServiceContext,
  access: DatasetAccess,
  params: {
    destinationCalendarId: string;
    externalCalendarId: string | null;
    plan: SyncPlan;
    desired: DestinationEvent[];
  },
): Promise<Map<string, string>> {
  const byKey = new Map(params.desired.map((event) => [event.key, event] as const));
  const occurrenceIds = await occurrenceIdsFor(context, access, [...byKey.keys()]);
  const rowIds = new Map<string, string>();

  for (const action of params.plan.actions) {
    if (action.type === 'noop' || action.type === 'skip') continue;

    if (action.type === 'delete') {
      const existing = await context.db
        .selectFrom('destination_events')
        .innerJoin(
          'generated_occurrences',
          'generated_occurrences.id',
          'destination_events.generated_occurrence_id',
        )
        .select('destination_events.id as id')
        .where('destination_events.destination_calendar_id', '=', params.destinationCalendarId)
        .where('generated_occurrences.occurrence_key', '=', action.occurrenceKey)
        .executeTakeFirst();
      if (existing) {
        rowIds.set(action.occurrenceKey, existing.id);
        await context.db
          .updateTable('destination_events')
          .set({ sync_status: 'deleting', updated_at: context.now() })
          .where('id', '=', existing.id)
          .execute();
      }
      continue;
    }

    const event = byKey.get(action.occurrenceKey);
    const occurrenceId = occurrenceIds.get(action.occurrenceKey);
    if (!event || !occurrenceId) continue;

    const row = await upsertDestinationEvent(context.db, {
      generatedOccurrenceId: occurrenceId,
      destinationCalendarId: params.destinationCalendarId,
      destinationType: 'google',
      externalCalendarId: params.externalCalendarId,
      // Left null for a create until the insert has actually landed. Writing
      // the deterministic ID here would make the row look like an event that
      // exists, so a retry after a failed insert would plan a PATCH against
      // something Google has never seen. Nothing is lost by waiting: the ID is
      // derived from the occurrence key, so it is always recoverable.
      externalEventId: action.type === 'update' ? action.externalEventId : null,
      startAt: event.timing ? new Date(event.timing.startEpochMs) : null,
      endAt: event.timing ? new Date(event.timing.endEpochMs) : null,
      timezoneId: event.displayTimezoneId,
      locationSnapshot: event.locationSnapshot,
      // Never the hash of what is about to be written: only `markEventSynced`
      // records that, once the write has actually landed. An update keeps the
      // hash of the content last confirmed in the calendar; a create has no
      // confirmed content yet, so it gets a sentinel that cannot match anything
      // the engine produces. Staging the new hash here would make a failed
      // write look already-synced to the next run.
      contentHash: action.type === 'update' ? action.previousContentHash : UNWRITTEN_CONTENT_HASH,
      syncStatus: action.type === 'create' ? 'creating' : 'updating',
    });
    rowIds.set(action.occurrenceKey, row.id);
  }

  return rowIds;
}

async function occurrenceIdsFor(
  context: ServiceContext,
  access: DatasetAccess,
  occurrenceKeys: string[],
): Promise<Map<string, string>> {
  if (occurrenceKeys.length === 0) return new Map();
  const rows = await context.db
    .selectFrom('generated_occurrences')
    .innerJoin('source_records', 'source_records.id', 'generated_occurrences.source_record_id')
    .select(['generated_occurrences.id as id', 'generated_occurrences.occurrence_key as key'])
    .where('generated_occurrences.occurrence_key', 'in', occurrenceKeys)
    .where('source_records.dataset_id', '=', access.datasetId)
    .execute();
  return new Map(rows.map((row) => [row.key, row.id] as const));
}

async function recordFailure(
  context: ServiceContext,
  destinationEventId: string,
  error: unknown,
  now: Date,
): Promise<void> {
  const row = await context.db
    .selectFrom('destination_events')
    .select('attempt_count')
    .where('id', '=', destinationEventId)
    .executeTakeFirst();

  const retryable = isRetryable(error);
  await markEventFailed(context.db, {
    destinationEventId,
    error: error instanceof Error ? error.message : String(error),
    // Backoff from the shared schedule, so the dashboard's "next attempt" and
    // the worker's behaviour cannot disagree.
    nextAttemptAt: retryable
      ? new Date(nextAttemptAt((row?.attempt_count ?? 0) + 1, now.getTime()))
      : null,
    terminal: !retryable,
  });
}

/* ---------------------------------------------------------------- helpers -- */

async function destinationConnectionStatus(
  context: ServiceContext,
  userId: string,
): Promise<'connected' | 'needs_reauth' | 'revoked'> {
  const account = await context.db
    .selectFrom('google_accounts')
    .select('connection_status')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return account?.connection_status ?? 'needs_reauth';
}

async function remindersFor(
  context: ServiceContext,
  params: {
    destinationCalendarId: string;
    sourceRecordId: string;
    eventType: SourceRecordRow['type'];
  },
): Promise<{ minutesBeforeStart: number }[]> {
  const rules = await getReminders(context.db, params);
  return rules.filter((rule) => rule.enabled).map((rule) => ({ minutesBeforeStart: rule.minutesBeforeStart }));
}

function parseCivilDate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split('-').map(Number);
  return { year: year as number, month: month as number, day: day as number };
}

function addDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  // UTC arithmetic so the host zone cannot shift a calendar day.
  const instant = Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000;
  const shifted = new Date(instant);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}
