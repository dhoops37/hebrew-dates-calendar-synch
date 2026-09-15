/**
 * Typed repositories.
 *
 * Every function that touches dataset-scoped data takes a `DatasetAccess` token
 * rather than a bare ID, so a route that skipped authorisation cannot compile.
 * The queries then re-filter on the dataset as well — belt and braces, because
 * the cost is a single indexed predicate and the failure mode is one family
 * seeing another's dates.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DatasetAccess } from './access';
import { AccessDeniedError } from './access';
import type {
  CalendarLocationRow,
  Database,
  DestinationCalendarRow,
  DestinationEventRow,
  GeneratedOccurrenceRow,
  HebrewMonthValue,
  SourceRecordRow,
  SourceRecordTypeValue,
  SyncStatusValue,
} from './schema';

/* ------------------------------------------------------------------ users -- */

export async function upsertUserByEmail(
  db: Kysely<Database>,
  params: { email: string; displayName?: string | null },
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', params.email)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (existing) return { id: existing.id, created: false };

  const inserted = await db
    .insertInto('users')
    .values({ email: params.email, display_name: params.displayName ?? null })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: inserted.id, created: true };
}

/**
 * Give a brand-new user their own dataset and one destination calendar.
 *
 * Even a single user gets an `owner` row, because the owner is what a synagogue
 * or household will later be, and retrofitting ownership onto rows keyed by
 * `user_id` is exactly the migration this avoids.
 */
export async function createPersonalDataset(
  db: Kysely<Database>,
  params: { userId: string; ownerName: string; datasetName: string; calendarName: string },
): Promise<{ ownerId: string; datasetId: string; destinationCalendarId: string }> {
  return db.transaction().execute(async (trx) => {
    const owner = await trx
      .insertInto('owners')
      .values({ kind: 'individual', name: params.ownerName })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('owner_members')
      .values({ owner_id: owner.id, user_id: params.userId, role: 'admin' })
      .execute();

    const dataset = await trx
      .insertInto('datasets')
      .values({ owner_id: owner.id, name: params.datasetName })
      .returning('id')
      .executeTakeFirstOrThrow();

    const destination = await trx
      .insertInto('destination_calendars')
      .values({
        dataset_id: dataset.id,
        user_id: params.userId,
        name: params.calendarName,
        destination_type: 'google',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return {
      ownerId: owner.id,
      datasetId: dataset.id,
      destinationCalendarId: destination.id,
    };
  });
}

/* ------------------------------------------------------------- calendars -- */

export async function listDestinationCalendars(
  db: Kysely<Database>,
  access: DatasetAccess,
): Promise<DestinationCalendarRow[]> {
  return db
    .selectFrom('destination_calendars')
    .selectAll()
    .where('dataset_id', '=', access.datasetId)
    .where('active', '=', true)
    .orderBy('created_at')
    .execute();
}

export async function getDestinationCalendar(
  db: Kysely<Database>,
  access: DatasetAccess,
  destinationCalendarId: string,
): Promise<DestinationCalendarRow> {
  const row = await db
    .selectFrom('destination_calendars')
    .selectAll()
    .where('id', '=', destinationCalendarId)
    .where('dataset_id', '=', access.datasetId)
    .executeTakeFirst();
  if (!row) throw new AccessDeniedError();
  return row;
}

export async function updateDestinationCalendar(
  db: Kysely<Database>,
  access: DatasetAccess,
  destinationCalendarId: string,
  patch: {
    name?: string;
    displayMode?: 'exact_sunset' | 'two_day_all_day';
    eventVisibility?: 'default' | 'private';
    calendarTimezoneHint?: string | null;
  },
): Promise<void> {
  const result = await db
    .updateTable('destination_calendars')
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.displayMode !== undefined ? { display_mode: patch.displayMode } : {}),
      ...(patch.eventVisibility !== undefined ? { event_visibility: patch.eventVisibility } : {}),
      ...(patch.calendarTimezoneHint !== undefined
        ? { calendar_timezone_hint: patch.calendarTimezoneHint }
        : {}),
      updated_at: new Date(),
    })
    .where('id', '=', destinationCalendarId)
    .where('dataset_id', '=', access.datasetId)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw new AccessDeniedError();
}

/* ------------------------------------------------------------- locations -- */

export interface LocationInput {
  displayName: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  elevationMeters?: number | null;
  useElevation?: boolean;
  timezoneId: string;
  geocoderPlaceId?: string | null;
  source: 'user_selected' | 'geocoded' | 'timezone_suggestion' | 'calendar_timezone_hint';
}

/**
 * Save (or replace) a destination's calculation location.
 *
 * `confirmedByUserId` is what turns a suggestion into something the sync planner
 * will act on. It is a separate argument rather than a field on `LocationInput`
 * so that "who confirmed this" cannot be filled in by accident along with the
 * coordinates.
 */
export async function saveLocation(
  db: Kysely<Database>,
  access: DatasetAccess,
  params: {
    destinationCalendarId: string;
    location: LocationInput;
    confirmedByUserId: string | null;
  },
): Promise<CalendarLocationRow> {
  await getDestinationCalendar(db, access, params.destinationCalendarId);
  const { location } = params;
  const confirmed = params.confirmedByUserId !== null;

  const values = {
    destination_calendar_id: params.destinationCalendarId,
    display_name: location.displayName,
    country_code: location.countryCode,
    // Sent as strings so Postgres numeric keeps full precision.
    latitude: location.latitude.toFixed(6),
    longitude: location.longitude.toFixed(6),
    elevation_meters: location.elevationMeters ?? null,
    use_elevation: location.useElevation ?? true,
    timezone_id: location.timezoneId,
    geocoder_place_id: location.geocoderPlaceId ?? null,
    source: location.source,
    confirmed_at: confirmed ? new Date() : null,
    confirmed_by_user_id: params.confirmedByUserId,
    updated_at: new Date(),
  };

  return db
    .insertInto('calendar_locations')
    .values(values)
    .onConflict((oc) => oc.column('destination_calendar_id').doUpdateSet(values))
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getLocation(
  db: Kysely<Database>,
  access: DatasetAccess,
  destinationCalendarId: string,
): Promise<CalendarLocationRow | undefined> {
  await getDestinationCalendar(db, access, destinationCalendarId);
  return db
    .selectFrom('calendar_locations')
    .selectAll()
    .where('destination_calendar_id', '=', destinationCalendarId)
    .executeTakeFirst();
}

/** Confirm an existing suggested location, recording who did it. */
export async function confirmLocationRow(
  db: Kysely<Database>,
  access: DatasetAccess,
  params: { destinationCalendarId: string; userId: string },
): Promise<void> {
  await getDestinationCalendar(db, access, params.destinationCalendarId);
  await db
    .updateTable('calendar_locations')
    .set({
      confirmed_at: new Date(),
      confirmed_by_user_id: params.userId,
      source: 'user_selected',
      updated_at: new Date(),
    })
    .where('destination_calendar_id', '=', params.destinationCalendarId)
    .execute();
}

/* --------------------------------------------------------- source records -- */

export interface SourceRecordInput {
  type: SourceRecordTypeValue;
  displayName: string;
  hebrewMonth: HebrewMonthValue;
  hebrewDay: number;
  originalHebrewYear?: number | null;
  originalGregorianDate?: string | null;
  sunsetStatus?: 'before_sunset' | 'after_sunset' | null;
  hebrewName?: string | null;
  relationship?: string | null;
  notes?: string | null;
  customTitle?: string | null;
  adarConvention?: 'both' | 'adar_i' | 'adar_ii';
  /**
   * Defaults to active. Set false for a Gregorian entry whose sunset status the
   * user has not settled yet: `unresolved_sunset_entry_cannot_be_active`
   * requires it, and that is what makes "I am not sure" a storable state rather
   * than an error.
   */
  active?: boolean;
}

export async function createSourceRecord(
  db: Kysely<Database>,
  access: DatasetAccess,
  input: SourceRecordInput,
): Promise<SourceRecordRow> {
  return db
    .insertInto('source_records')
    .values({
      dataset_id: access.datasetId,
      type: input.type,
      display_name: input.displayName,
      hebrew_month: input.hebrewMonth,
      hebrew_day: input.hebrewDay,
      original_hebrew_year: input.originalHebrewYear ?? null,
      original_gregorian_date: input.originalGregorianDate ?? null,
      sunset_status: input.sunsetStatus ?? null,
      hebrew_name: input.hebrewName ?? null,
      relationship: input.relationship ?? null,
      notes: input.notes ?? null,
      custom_title: input.customTitle ?? null,
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.adarConvention
        ? {
            calculation_convention: {
              adarOrdinaryYahrzeitInLeapYear: input.adarConvention,
            },
          }
        : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function listSourceRecords(
  db: Kysely<Database>,
  access: DatasetAccess,
): Promise<SourceRecordRow[]> {
  return db
    .selectFrom('source_records')
    .selectAll()
    .where('dataset_id', '=', access.datasetId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at')
    .execute();
}

export async function getSourceRecord(
  db: Kysely<Database>,
  access: DatasetAccess,
  sourceRecordId: string,
): Promise<SourceRecordRow> {
  const row = await db
    .selectFrom('source_records')
    .selectAll()
    .where('id', '=', sourceRecordId)
    .where('dataset_id', '=', access.datasetId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw new AccessDeniedError();
  return row;
}

export interface SourceRecordPatch {
  displayName?: string;
  hebrewName?: string | null;
  relationship?: string | null;
  notes?: string | null;
  customTitle?: string | null;
  hebrewMonth?: HebrewMonthValue;
  hebrewDay?: number;
  originalHebrewYear?: number | null;
  sunsetStatus?: 'before_sunset' | 'after_sunset' | null;
  adarConvention?: 'both' | 'adar_i' | 'adar_ii';
  displayModeOverride?: 'exact_sunset' | 'two_day_all_day' | null;
}

/**
 * Which fields of a patch actually differ from the stored row.
 *
 * Returned as names, not values. The caller needs to know *whether* the Hebrew
 * date moved — because that re-keys every occurrence — and the audit log records
 * which fields changed without recording what they changed to.
 */
export interface RecordChange {
  changed: string[];
  /** True when the patch moves the Hebrew date itself. */
  dateChanged: boolean;
}

/** Fields that, if changed, change which Hebrew dates the engine produces. */
const DATE_FIELDS = new Set([
  'hebrewMonth',
  'hebrewDay',
  'originalHebrewYear',
  'sunsetStatus',
  'adarConvention',
]);

export function diffSourceRecord(
  record: SourceRecordRow,
  patch: SourceRecordPatch,
): RecordChange {
  const current: Record<string, unknown> = {
    displayName: record.display_name,
    hebrewName: record.hebrew_name,
    relationship: record.relationship,
    notes: record.notes,
    customTitle: record.custom_title,
    hebrewMonth: record.hebrew_month,
    hebrewDay: record.hebrew_day,
    originalHebrewYear: record.original_hebrew_year,
    sunsetStatus: record.sunset_status,
    adarConvention: (
      record.calculation_convention as { adarOrdinaryYahrzeitInLeapYear: string }
    ).adarOrdinaryYahrzeitInLeapYear,
    displayModeOverride: record.display_mode_override,
  };

  const changed = Object.entries(patch)
    .filter(([key, value]) => value !== undefined && current[key] !== value)
    .map(([key]) => key);

  return { changed, dateChanged: changed.some((field) => DATE_FIELDS.has(field)) };
}

/**
 * Update a source record.
 *
 * Only the fields present in the patch are written, so a form that renders four
 * fields cannot blank the other six. Returns the row as stored, which the
 * caller needs in order to regenerate occurrences from the real values rather
 * than from what it hoped it wrote.
 */
export async function updateSourceRecord(
  db: Kysely<Database>,
  access: DatasetAccess,
  sourceRecordId: string,
  patch: SourceRecordPatch,
): Promise<SourceRecordRow> {
  // Confirms the record is in this dataset before anything is written.
  const existing = await getSourceRecord(db, access, sourceRecordId);

  const values = {
    ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
    ...(patch.hebrewName !== undefined ? { hebrew_name: patch.hebrewName } : {}),
    ...(patch.relationship !== undefined ? { relationship: patch.relationship } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.customTitle !== undefined ? { custom_title: patch.customTitle } : {}),
    ...(patch.hebrewMonth !== undefined ? { hebrew_month: patch.hebrewMonth } : {}),
    ...(patch.hebrewDay !== undefined ? { hebrew_day: patch.hebrewDay } : {}),
    ...(patch.originalHebrewYear !== undefined
      ? { original_hebrew_year: patch.originalHebrewYear }
      : {}),
    ...(patch.sunsetStatus !== undefined ? { sunset_status: patch.sunsetStatus } : {}),
    ...(patch.displayModeOverride !== undefined
      ? { display_mode_override: patch.displayModeOverride }
      : {}),
    ...(patch.adarConvention !== undefined
      ? {
          calculation_convention: {
            adarOrdinaryYahrzeitInLeapYear: patch.adarConvention,
          },
        }
      : {}),
    updated_at: new Date(),
  };

  if (Object.keys(values).length === 1) return existing;

  return db
    .updateTable('source_records')
    .set(values)
    .where('id', '=', sourceRecordId)
    .where('dataset_id', '=', access.datasetId)
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Delete the occurrences of a record that no longer belong.
 *
 * Used after an edit that moved the Hebrew date: the occurrence key is derived
 * from (record, hebrew year, sequence), so a moved date produces the *same*
 * keys with different Gregorian dates — which is what makes an edit an update
 * rather than a delete and recreate. This exists for the narrower case where a
 * convention change reduces the number of occurrences in a year, e.g.
 * both-Adars to Adar II only, leaving an orphan at sequence 1.
 */
export async function deleteOccurrencesNotIn(
  db: Kysely<Database>,
  access: DatasetAccess,
  params: { sourceRecordId: string; keepOccurrenceKeys: string[] },
): Promise<number> {
  await getSourceRecord(db, access, params.sourceRecordId);

  let query = db
    .deleteFrom('generated_occurrences')
    .where('source_record_id', '=', params.sourceRecordId);

  if (params.keepOccurrenceKeys.length > 0) {
    query = query.where('occurrence_key', 'not in', params.keepOccurrenceKeys);
  }

  const result = await query.executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function setHorizon(
  db: Kysely<Database>,
  access: DatasetAccess,
  params: { sourceRecordId: string; throughHebrewYear: number },
): Promise<void> {
  await db
    .updateTable('source_records')
    .set({ horizon_through_hebrew_year: params.throughHebrewYear, updated_at: new Date() })
    .where('id', '=', params.sourceRecordId)
    .where('dataset_id', '=', access.datasetId)
    .execute();
}

export async function pauseSourceRecord(
  db: Kysely<Database>,
  access: DatasetAccess,
  params: { sourceRecordId: string; active: boolean },
): Promise<void> {
  await db
    .updateTable('source_records')
    .set({ active: params.active, updated_at: new Date() })
    .where('id', '=', params.sourceRecordId)
    .where('dataset_id', '=', access.datasetId)
    .execute();
}

export async function softDeleteSourceRecord(
  db: Kysely<Database>,
  access: DatasetAccess,
  sourceRecordId: string,
): Promise<void> {
  await db
    .updateTable('source_records')
    .set({ deleted_at: new Date(), active: false, updated_at: new Date() })
    .where('id', '=', sourceRecordId)
    .where('dataset_id', '=', access.datasetId)
    .execute();
}

/* ------------------------------------------------------------ occurrences -- */

export interface OccurrenceInput {
  hebrewYear: number;
  sequence: number;
  occurrenceKey: string;
  hebrewMonth: number;
  hebrewDay: number;
  gregorianDate: string;
  calculationVersion: string;
  ruleApplied: string;
  ambiguities: unknown;
  isManualOverride?: boolean;
}

/**
 * Persist occurrences idempotently.
 *
 * `onConflict … doUpdateSet` on the natural key means re-running generation is
 * safe: the same Hebrew date produces the same key, so a repeat write updates
 * rather than duplicating. That is the database-level half of the idempotency
 * guarantee the engine provides on the compute side.
 */
export async function upsertOccurrences(
  db: Kysely<Database>,
  access: DatasetAccess,
  params: { sourceRecordId: string; occurrences: OccurrenceInput[] },
): Promise<GeneratedOccurrenceRow[]> {
  if (params.occurrences.length === 0) return [];
  await getSourceRecord(db, access, params.sourceRecordId);

  return db
    .insertInto('generated_occurrences')
    .values(
      params.occurrences.map((occurrence) => ({
        source_record_id: params.sourceRecordId,
        hebrew_year: occurrence.hebrewYear,
        sequence: occurrence.sequence,
        occurrence_key: occurrence.occurrenceKey,
        hebrew_month: occurrence.hebrewMonth,
        hebrew_day: occurrence.hebrewDay,
        gregorian_date: occurrence.gregorianDate,
        calculation_version: occurrence.calculationVersion,
        rule_applied: occurrence.ruleApplied,
        ambiguities: JSON.stringify(occurrence.ambiguities) as unknown,
        is_manual_override: occurrence.isManualOverride ?? false,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['source_record_id', 'hebrew_year', 'sequence']).doUpdateSet((eb) => ({
        hebrew_month: eb.ref('excluded.hebrew_month'),
        hebrew_day: eb.ref('excluded.hebrew_day'),
        gregorian_date: eb.ref('excluded.gregorian_date'),
        calculation_version: eb.ref('excluded.calculation_version'),
        rule_applied: eb.ref('excluded.rule_applied'),
        ambiguities: eb.ref('excluded.ambiguities'),
        updated_at: new Date(),
      })),
    )
    .returningAll()
    .execute();
}

export async function listOccurrences(
  db: Kysely<Database>,
  access: DatasetAccess,
  params: { sourceRecordId?: string; fromGregorianDate?: string; limit?: number } = {},
): Promise<(GeneratedOccurrenceRow & { dataset_id: string })[]> {
  let query = db
    .selectFrom('generated_occurrences')
    .innerJoin('source_records', 'source_records.id', 'generated_occurrences.source_record_id')
    .selectAll('generated_occurrences')
    .select('source_records.dataset_id as dataset_id')
    .where('source_records.dataset_id', '=', access.datasetId)
    .where('source_records.deleted_at', 'is', null)
    .orderBy('generated_occurrences.gregorian_date');

  if (params.sourceRecordId) {
    query = query.where('generated_occurrences.source_record_id', '=', params.sourceRecordId);
  }
  if (params.fromGregorianDate) {
    query = query.where('generated_occurrences.gregorian_date', '>=', params.fromGregorianDate);
  }
  if (params.limit) query = query.limit(params.limit);

  return query.execute();
}

/* ------------------------------------------------------ destination events -- */

export interface DestinationEventUpsert {
  generatedOccurrenceId: string;
  destinationCalendarId: string;
  destinationType: 'google' | 'ical_feed';
  externalCalendarId: string | null;
  externalEventId: string | null;
  startAt: Date | null;
  endAt: Date | null;
  timezoneId: string;
  locationSnapshot: unknown;
  contentHash: string;
  syncStatus: SyncStatusValue;
}

export async function listDestinationEvents(
  db: Kysely<Database>,
  access: DatasetAccess,
  destinationCalendarId: string,
): Promise<(DestinationEventRow & { occurrence_key: string })[]> {
  return db
    .selectFrom('destination_events')
    .innerJoin(
      'generated_occurrences',
      'generated_occurrences.id',
      'destination_events.generated_occurrence_id',
    )
    .innerJoin('source_records', 'source_records.id', 'generated_occurrences.source_record_id')
    .selectAll('destination_events')
    .select('generated_occurrences.occurrence_key as occurrence_key')
    .where('destination_events.destination_calendar_id', '=', destinationCalendarId)
    .where('source_records.dataset_id', '=', access.datasetId)
    .execute();
}

export async function upsertDestinationEvent(
  db: Kysely<Database>,
  event: DestinationEventUpsert,
): Promise<DestinationEventRow> {
  const values = {
    generated_occurrence_id: event.generatedOccurrenceId,
    destination_calendar_id: event.destinationCalendarId,
    destination_type: event.destinationType,
    external_calendar_id: event.externalCalendarId,
    external_event_id: event.externalEventId,
    start_at: event.startAt,
    end_at: event.endAt,
    timezone_id: event.timezoneId,
    location_snapshot: JSON.stringify(event.locationSnapshot) as unknown,
    content_hash: event.contentHash,
    sync_status: event.syncStatus,
    updated_at: new Date(),
  };
  return db
    .insertInto('destination_events')
    .values(values)
    .onConflict((oc) =>
      oc.columns(['generated_occurrence_id', 'destination_calendar_id']).doUpdateSet(values),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function markEventSynced(
  db: Kysely<Database>,
  params: {
    destinationEventId: string;
    externalEventId: string;
    externalCalendarId: string;
    contentHash: string;
  },
): Promise<void> {
  await db
    .updateTable('destination_events')
    .set({
      sync_status: 'synced',
      external_event_id: params.externalEventId,
      external_calendar_id: params.externalCalendarId,
      content_hash: params.contentHash,
      attempt_count: 0,
      next_attempt_at: null,
      last_error: null,
      last_synced_at: new Date(),
      updated_at: new Date(),
    })
    .where('id', '=', params.destinationEventId)
    .execute();
}

export async function markEventFailed(
  db: Kysely<Database>,
  params: {
    destinationEventId: string;
    error: string;
    nextAttemptAt: Date | null;
    terminal: boolean;
  },
): Promise<void> {
  await db
    .updateTable('destination_events')
    .set({
      sync_status: params.terminal ? 'failed' : 'retry_scheduled',
      attempt_count: sql`attempt_count + 1`,
      next_attempt_at: params.nextAttemptAt,
      // Truncated: an upstream error body can be long, and it is shown to users.
      last_error: params.error.slice(0, 500),
      updated_at: new Date(),
    })
    .where('id', '=', params.destinationEventId)
    .execute();
}

export async function deleteDestinationEventRow(
  db: Kysely<Database>,
  destinationEventId: string,
): Promise<void> {
  await db.deleteFrom('destination_events').where('id', '=', destinationEventId).execute();
}

/* ------------------------------------------------------------ reminders -- */

/**
 * Reminder defaults per PRD 18.1-18.3. Seeded per destination calendar so they
 * are configurable per member, and stored as data so changing them later does
 * not require a deploy.
 */
export const DEFAULT_REMINDERS: Record<SourceRecordTypeValue, number[]> = {
  birthday: [1440, 0],
  personal_yahrzeit: [10_080, 1440, 0],
  famous_yahrzeit: [1440],
};

export async function seedDefaultReminders(
  db: Kysely<Database>,
  destinationCalendarId: string,
): Promise<void> {
  const rows = Object.entries(DEFAULT_REMINDERS).flatMap(([eventType, minutes]) =>
    minutes.map((minutesBeforeStart) => ({
      destination_calendar_id: destinationCalendarId,
      source_record_id: null,
      event_type: eventType as SourceRecordTypeValue,
      minutes_before_start: minutesBeforeStart,
    })),
  );
  await db.insertInto('reminder_rules').values(rows).execute();
}

export async function getReminders(
  db: Kysely<Database>,
  params: {
    destinationCalendarId: string;
    sourceRecordId: string;
    eventType: SourceRecordTypeValue;
  },
): Promise<{ minutesBeforeStart: number; enabled: boolean }[]> {
  // A record-level override replaces the calendar default entirely, rather than
  // merging: "remind me only on the day" must not leave the 7-day default behind.
  const overrides = await db
    .selectFrom('reminder_rules')
    .select(['minutes_before_start', 'enabled'])
    .where('source_record_id', '=', params.sourceRecordId)
    .execute();
  const rows =
    overrides.length > 0
      ? overrides
      : await db
          .selectFrom('reminder_rules')
          .select(['minutes_before_start', 'enabled'])
          .where('destination_calendar_id', '=', params.destinationCalendarId)
          .where('event_type', '=', params.eventType)
          .execute();

  return rows.map((row) => ({
    minutesBeforeStart: row.minutes_before_start,
    enabled: row.enabled,
  }));
}

/* ------------------------------------------------------------- audit log -- */

/*
 * Deliberately not here. The audit log has exactly one writer,
 * `recordAuditEvent` in ./audit.ts, and it accepts only a member of a closed
 * typed union — because a `detail: Record<string, unknown>` parameter is one
 * careless spread away from keeping somebody's name or a token for years.
 */
