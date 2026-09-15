/**
 * Read models for the dashboard.
 *
 * Separate from the use cases because the questions are different: a use case
 * asks "what should change", a read model asks "what should the user be told".
 * In particular a sync status has to be *legible* — "waiting to retry, next
 * attempt in 4 minutes" rather than `retry_scheduled`.
 */
import {
  getLocation,
  listRecentJobs,
  listSourceRecords,
  type DatasetAccess,
  type SourceRecordRow,
  type SyncJobRow,
} from '@hebrew-dates/db';
import { formatHebrewDateEnglish, type HebrewMonthNumber } from '@hebrew-dates/engine';
import type { ServiceContext } from './context';
import { connectionHealth } from './tokens';

export interface UpcomingOccurrence {
  occurrenceKey: string;
  sourceRecordId: string;
  displayName: string;
  type: SourceRecordRow['type'];
  hebrewYear: number;
  hebrewDateLabel: string;
  /** The Gregorian day the Hebrew date's daytime falls on, as text. */
  gregorianDate: string;
  syncStatus: string;
  syncStatusLabel: string;
  externalEventId: string | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
}

export interface DashboardView {
  google: Awaited<ReturnType<typeof connectionHealth>>;
  location:
    | {
        displayName: string;
        timezoneId: string;
        confirmed: boolean;
        source: string;
      }
    | undefined;
  calendar: { googleCalendarId: string | null; created: boolean };
  records: {
    id: string;
    displayName: string;
    type: SourceRecordRow['type'];
    hebrewDateLabel: string;
    active: boolean;
    horizonThroughHebrewYear: number | null;
  }[];
  upcoming: UpcomingOccurrence[];
  counts: { records: number; occurrences: number; synced: number; pending: number; failed: number };
  recentJobs: SyncJobRow[];
}

/** Human-readable sync status. The dashboard must not show enum values. */
export function syncStatusLabel(status: string, nextAttemptAt: Date | null, now: Date): string {
  switch (status) {
    case 'synced':
      return 'In your calendar';
    case 'pending':
      return 'Waiting to be added';
    case 'creating':
      return 'Being added';
    case 'updating':
      return 'Being updated';
    case 'deleting':
      return 'Being removed';
    case 'retry_scheduled': {
      if (!nextAttemptAt) return 'Waiting to retry';
      const minutes = Math.max(1, Math.round((nextAttemptAt.getTime() - now.getTime()) / 60_000));
      return `Waiting to retry (about ${minutes} minute${minutes === 1 ? '' : 's'})`;
    }
    case 'failed':
      return 'Could not be added';
    case 'disconnected':
      return 'Paused — reconnect Google Calendar';
    default:
      return status;
  }
}

export async function dashboardView(
  context: ServiceContext,
  access: DatasetAccess,
  params: { userId: string; destinationCalendarId: string; upcomingLimit?: number },
): Promise<DashboardView> {
  const now = context.now();

  const [google, locationRow, connection, records, recentJobs] = await Promise.all([
    connectionHealth(context, params.userId),
    getLocation(context.db, access, params.destinationCalendarId),
    context.db
      .selectFrom('google_calendar_connections')
      .select('google_calendar_id')
      .where('destination_calendar_id', '=', params.destinationCalendarId)
      .executeTakeFirst(),
    listSourceRecords(context.db, access),
    listRecentJobs(context.db, { datasetId: access.datasetId, limit: 5 }),
  ]);

  const upcomingRows = await context.db
    .selectFrom('generated_occurrences')
    .innerJoin('source_records', 'source_records.id', 'generated_occurrences.source_record_id')
    .leftJoin('destination_events', (join) =>
      join
        .onRef(
          'destination_events.generated_occurrence_id',
          '=',
          'generated_occurrences.id',
        )
        .on('destination_events.destination_calendar_id', '=', params.destinationCalendarId),
    )
    .select([
      'generated_occurrences.occurrence_key as occurrence_key',
      'generated_occurrences.source_record_id as source_record_id',
      'generated_occurrences.hebrew_year as hebrew_year',
      'generated_occurrences.hebrew_month as hebrew_month',
      'generated_occurrences.hebrew_day as hebrew_day',
      'generated_occurrences.gregorian_date as gregorian_date',
      'source_records.display_name as display_name',
      'source_records.type as type',
      'destination_events.sync_status as sync_status',
      'destination_events.external_event_id as external_event_id',
      'destination_events.last_error as last_error',
      'destination_events.next_attempt_at as next_attempt_at',
    ])
    .where('source_records.dataset_id', '=', access.datasetId)
    .where('source_records.deleted_at', 'is', null)
    // Today's occurrence is still upcoming until its own sunset, so the
    // boundary is the calendar day rather than the instant.
    .where('generated_occurrences.gregorian_date', '>=', isoDay(now))
    .orderBy('generated_occurrences.gregorian_date')
    .limit(params.upcomingLimit ?? 25)
    .execute();

  const counts = await context.db
    .selectFrom('destination_events')
    .innerJoin(
      'generated_occurrences',
      'generated_occurrences.id',
      'destination_events.generated_occurrence_id',
    )
    .innerJoin('source_records', 'source_records.id', 'generated_occurrences.source_record_id')
    .select((eb) => [
      eb.fn.countAll().as('total'),
      eb.fn
        .count<number>('destination_events.id')
        .filterWhere('destination_events.sync_status', '=', 'synced')
        .as('synced'),
      eb.fn
        .count<number>('destination_events.id')
        .filterWhere('destination_events.sync_status', 'in', [
          'pending',
          'creating',
          'updating',
          'retry_scheduled',
        ])
        .as('pending'),
      eb.fn
        .count<number>('destination_events.id')
        .filterWhere('destination_events.sync_status', '=', 'failed')
        .as('failed'),
    ])
    .where('destination_events.destination_calendar_id', '=', params.destinationCalendarId)
    .where('source_records.dataset_id', '=', access.datasetId)
    .executeTakeFirst();

  return {
    google,
    location: locationRow
      ? {
          displayName: locationRow.display_name,
          timezoneId: locationRow.timezone_id,
          confirmed: locationRow.confirmed_at !== null,
          source: locationRow.source,
        }
      : undefined,
    calendar: {
      googleCalendarId: connection?.google_calendar_id ?? null,
      created: Boolean(connection?.google_calendar_id),
    },
    records: records.map((record) => ({
      id: record.id,
      displayName: record.display_name,
      type: record.type,
      hebrewDateLabel: formatHebrewDateEnglish({
        year: record.original_hebrew_year ?? 0,
        month: monthNumberFromName(record.hebrew_month),
        day: record.hebrew_day,
      }),
      active: record.active,
      horizonThroughHebrewYear: record.horizon_through_hebrew_year,
    })),
    upcoming: upcomingRows.map((row) => ({
      occurrenceKey: row.occurrence_key,
      sourceRecordId: row.source_record_id,
      displayName: row.display_name,
      type: row.type,
      hebrewYear: row.hebrew_year,
      hebrewDateLabel: formatHebrewDateEnglish({
        year: row.hebrew_year,
        month: row.hebrew_month as HebrewMonthNumber,
        day: row.hebrew_day,
      }),
      gregorianDate: row.gregorian_date,
      // No destination_events row yet means the sync has not reached it.
      syncStatus: row.sync_status ?? 'pending',
      syncStatusLabel: syncStatusLabel(row.sync_status ?? 'pending', row.next_attempt_at, now),
      externalEventId: row.external_event_id,
      lastError: row.last_error,
      nextAttemptAt: row.next_attempt_at,
    })),
    counts: {
      records: records.length,
      occurrences: Number(counts?.total ?? 0),
      synced: Number(counts?.synced ?? 0),
      pending: Number(counts?.pending ?? 0),
      failed: Number(counts?.failed ?? 0),
    },
    recentJobs,
  };
}

/** Today, as a `date` literal in UTC. Matches how the column is stored. */
function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Hebrew month name to number.
 *
 * 'ADAR' maps to 12, the ordinary-year Adar. The distinction matters for
 * calculation and is preserved in the stored name; here it only affects a
 * label, so the ordinary-year reading is the right default.
 */
function monthNumberFromName(name: string): HebrewMonthNumber {
  const numbers: Record<string, number> = {
    NISAN: 1,
    IYYAR: 2,
    SIVAN: 3,
    TAMUZ: 4,
    AV: 5,
    ELUL: 6,
    TISHREI: 7,
    CHESHVAN: 8,
    KISLEV: 9,
    TEVET: 10,
    SHVAT: 11,
    ADAR: 12,
    ADAR_I: 12,
    ADAR_II: 13,
  };
  return (numbers[name] ?? 7) as HebrewMonthNumber;
}
