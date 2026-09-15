/**
 * Kysely types for the Hebrew Dates schema.
 *
 * **The SQL migrations are authoritative, not this file.** These types are a
 * hand-maintained mirror of `db/migrations/*.sql`, kept in step by an
 * integration test that reads the live catalogue and fails if the two drift
 * (`test/integration/schema-parity.test.ts`). That direction matters: the
 * database owns the constraints that encode product rules — an under-specified
 * yahrzeit cannot be inserted, a duplicate external event cannot be registered —
 * and no ORM gets to reinterpret them.
 *
 * Conventions:
 *  - `Generated<T>` marks columns with a database default, so inserts may omit
 *    them and selects always get them.
 *  - `timestamptz` maps to `Date`, which is what `pg` returns.
 *  - `numeric` maps to `string`. Postgres numerics do not fit in a JS number
 *    without loss, and latitude/longitude precision is exactly the thing we
 *    cannot afford to round. Repositories convert at their boundary.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * `timestamptz` with a database default: reads as a `Date`, may be omitted on
 * insert, and may be written explicitly on update.
 *
 * Note this is a `ColumnType`, not `Generated<Date>`. `Generated` only makes the
 * insert optional; it does not let the update accept a `Date`, which every
 * `updated_at` write needs.
 */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/** `timestamptz NOT NULL` with no default: required on insert. */
type TimestampRequired = ColumnType<Date, Date | string, Date | string>;

/** Nullable `timestamptz`. */
type TimestampNullable = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

/** `date` — a calendar day, kept as a string so it never becomes an instant. */
type DateOnly = ColumnType<string, string, string>;
type DateOnlyNullable = ColumnType<string | null, string | null | undefined, string | null>;

export type PreferredLanguage = 'en' | 'he';
export type OwnerKind = 'individual' | 'household' | 'organisation';
export type MemberRole = 'admin' | 'editor' | 'viewer';
export type PauseBehaviour = 'hide_future_events' | 'keep_events';
export type DestinationType = 'google' | 'ical_feed';
export type DisplayModeValue = 'exact_sunset' | 'two_day_all_day';
export type EventVisibilityValue = 'default' | 'private';
export type LocationSourceValue =
  | 'user_selected'
  | 'geocoded'
  | 'timezone_suggestion'
  | 'calendar_timezone_hint';
export type SourceRecordTypeValue = 'birthday' | 'personal_yahrzeit' | 'famous_yahrzeit';
export type HebrewMonthValue =
  | 'TISHREI'
  | 'CHESHVAN'
  | 'KISLEV'
  | 'TEVET'
  | 'SHVAT'
  | 'ADAR'
  | 'ADAR_I'
  | 'ADAR_II'
  | 'NISAN'
  | 'IYYAR'
  | 'SIVAN'
  | 'TAMUZ'
  | 'AV'
  | 'ELUL';
export type SunsetStatusValue = 'before_sunset' | 'after_sunset';
export type SyncStatusValue =
  | 'pending'
  | 'creating'
  | 'synced'
  | 'updating'
  | 'deleting'
  | 'retry_scheduled'
  | 'failed'
  | 'disconnected';
export type ConnectionStatusValue = 'connected' | 'needs_reauth' | 'revoked';
export type JobType =
  | 'initial_sync'
  | 'reconcile'
  | 'extend_horizon'
  | 'recalculate'
  | 'delete_events';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string | null;
  preferred_language: Generated<PreferredLanguage>;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: TimestampNullable;
}

export interface OwnersTable {
  id: Generated<string>;
  kind: OwnerKind;
  name: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OwnerMembersTable {
  owner_id: string;
  user_id: string;
  role: MemberRole;
  joined_at: Timestamp;
}

export interface DatasetsTable {
  id: Generated<string>;
  owner_id: string;
  name: string;
  default_language: Generated<PreferredLanguage>;
  pause_behaviour: Generated<PauseBehaviour>;
  active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DestinationCalendarsTable {
  id: Generated<string>;
  dataset_id: string;
  user_id: string | null;
  name: string;
  destination_type: DestinationType;
  display_mode: Generated<DisplayModeValue>;
  language: Generated<PreferredLanguage>;
  /** The CALENDAR's own zone. A hint for suggestions and display; never a sunset input. */
  calendar_timezone_hint: string | null;
  event_visibility: Generated<EventVisibilityValue>;
  active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CalendarLocationsTable {
  id: Generated<string>;
  destination_calendar_id: string;
  display_name: string;
  country_code: string;
  /** numeric(9,6) — a string, deliberately. See the file header. */
  latitude: string;
  longitude: string;
  elevation_meters: number | null;
  use_elevation: Generated<boolean>;
  /** IANA zone OF THIS PLACE, used to render the calculated instant. */
  timezone_id: string;
  geocoder_place_id: string | null;
  /** Which provider resolved these coordinates; NULL for the built-in catalogue. */
  geocoder: string | null;
  /** What the provider returned, before any tidying. `display_name` is what the user confirmed. */
  geocoder_display_name: string | null;
  source: Generated<LocationSourceValue>;
  /** NULL means suggested-but-unconfirmed. The sync planner refuses those. */
  confirmed_at: TimestampNullable;
  confirmed_by_user_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SourceRecordsTable {
  id: Generated<string>;
  dataset_id: string;
  type: SourceRecordTypeValue;
  display_name: string;
  hebrew_name: string | null;
  relationship: string | null;
  /** Stored by NAME so "Adar" and "Adar I" stay distinguishable. */
  hebrew_month: HebrewMonthValue;
  hebrew_day: number;
  original_hebrew_year: number | null;
  original_gregorian_date: DateOnlyNullable;
  sunset_status: SunsetStatusValue | null;
  calculation_convention: Generated<{ adarOrdinaryYahrzeitInLeapYear: 'both' | 'adar_i' | 'adar_ii' }>;
  custom_title: string | null;
  notes: string | null;
  display_mode_override: DisplayModeValue | null;
  active: Generated<boolean>;
  horizon_through_hebrew_year: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: TimestampNullable;
}

export interface GeneratedOccurrencesTable {
  id: Generated<string>;
  source_record_id: string;
  hebrew_year: number;
  sequence: Generated<number>;
  occurrence_key: string;
  hebrew_month: number;
  hebrew_day: number;
  /** date — the Gregorian day of the Hebrew date's daytime. Location-free. */
  gregorian_date: DateOnly;
  calculation_version: string;
  rule_applied: string;
  ambiguities: Generated<unknown>;
  is_manual_override: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DestinationEventsTable {
  id: Generated<string>;
  generated_occurrence_id: string;
  destination_calendar_id: string;
  destination_type: DestinationType;
  external_calendar_id: string | null;
  external_event_id: string | null;
  start_at: TimestampNullable;
  end_at: TimestampNullable;
  timezone_id: string;
  location_snapshot: unknown;
  content_hash: string;
  sync_status: Generated<SyncStatusValue>;
  attempt_count: Generated<number>;
  next_attempt_at: TimestampNullable;
  last_synced_at: TimestampNullable;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ReminderRulesTable {
  id: Generated<string>;
  destination_calendar_id: string | null;
  source_record_id: string | null;
  event_type: SourceRecordTypeValue | null;
  minutes_before_start: number;
  enabled: Generated<boolean>;
  created_at: Timestamp;
}

export interface SyncJobsTable {
  id: Generated<string>;
  dataset_id: string;
  destination_calendar_id: string | null;
  job_type: JobType;
  status: Generated<JobStatus>;
  attempt_count: Generated<number>;
  scheduled_at: Timestamp;
  started_at: TimestampNullable;
  completed_at: TimestampNullable;
  error_summary: string | null;
  created_at: Timestamp;
}

export interface SessionsTable {
  /** sha256 of the cookie value, not the value itself. */
  id: Buffer;
  user_id: string;
  created_at: Timestamp;
  expires_at: TimestampRequired;
  last_seen_at: Timestamp;
  created_ip_prefix: string | null;
}

export interface OauthStatesTable {
  state_hash: Buffer;
  encrypted_code_verifier: Buffer;
  encryption_key_id: string;
  redirect_path: string | null;
  user_id: string | null;
  created_at: Timestamp;
  expires_at: TimestampRequired;
}

export interface GoogleAccountsTable {
  id: Generated<string>;
  user_id: string;
  google_subject: string;
  email: string | null;
  /** Envelope ciphertext. Plaintext never reaches the database. */
  encrypted_refresh_token: Buffer;
  encryption_key_id: string;
  access_token_expires_at: TimestampNullable;
  granted_scopes: string;
  connection_status: Generated<ConnectionStatusValue>;
  last_error: string | null;
  connected_at: Timestamp;
  updated_at: Timestamp;
}

export interface GoogleCalendarConnectionsTable {
  id: Generated<string>;
  destination_calendar_id: string;
  google_account_id: string;
  google_calendar_id: string | null;
  created_by_app: Generated<boolean>;
  last_sync_at: TimestampNullable;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AuditLogTable {
  id: Generated<number>;
  at: Timestamp;
  actor_user_id: string | null;
  action: string;
  subject_type: string;
  subject_id: string | null;
  detail: Generated<unknown>;
}

export interface RateLimitsTable {
  /** Caller-composed key, e.g. `authStart:203.0.113`. */
  bucket: string;
  window_start: TimestampRequired;
  attempts: Generated<number>;
  updated_at: Timestamp;
}

export interface SchemaMigrationsTable {
  filename: string;
  applied_at: Timestamp;
  checksum: string;
}

export interface Database {
  users: UsersTable;
  owners: OwnersTable;
  owner_members: OwnerMembersTable;
  datasets: DatasetsTable;
  destination_calendars: DestinationCalendarsTable;
  calendar_locations: CalendarLocationsTable;
  source_records: SourceRecordsTable;
  generated_occurrences: GeneratedOccurrencesTable;
  destination_events: DestinationEventsTable;
  reminder_rules: ReminderRulesTable;
  sync_jobs: SyncJobsTable;
  sessions: SessionsTable;
  oauth_states: OauthStatesTable;
  google_accounts: GoogleAccountsTable;
  google_calendar_connections: GoogleCalendarConnectionsTable;
  audit_log: AuditLogTable;
  rate_limits: RateLimitsTable;
  schema_migrations: SchemaMigrationsTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type Dataset = Selectable<DatasetsTable>;
export type DestinationCalendarRow = Selectable<DestinationCalendarsTable>;
export type CalendarLocationRow = Selectable<CalendarLocationsTable>;
export type NewCalendarLocation = Insertable<CalendarLocationsTable>;
export type SourceRecordRow = Selectable<SourceRecordsTable>;
export type NewSourceRecord = Insertable<SourceRecordsTable>;
export type GeneratedOccurrenceRow = Selectable<GeneratedOccurrencesTable>;
export type DestinationEventRow = Selectable<DestinationEventsTable>;
export type DestinationEventUpdate = Updateable<DestinationEventsTable>;
export type SyncJobRow = Selectable<SyncJobsTable>;
export type GoogleAccountRow = Selectable<GoogleAccountsTable>;
export type GoogleCalendarConnectionRow = Selectable<GoogleCalendarConnectionsTable>;
