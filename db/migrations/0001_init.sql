-- 0001_init.sql — core schema for Hebrew Dates
--
-- NOT YET APPLIED. This file is the Phase 2 starting point, reviewed as part of
-- the Phase 1 design deliverable. See docs/DATA-MODEL.md for the reasoning
-- behind each divergence from PRD section 24.
--
-- Conventions:
--   * timestamptz everywhere; the application never stores naive timestamps
--   * text + CHECK rather than enums, so adding a value is not a table rewrite
--   * every dataset-scoped table cascades from datasets; every member-scoped
--     table cascades from destination_calendars

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email

-- ---------------------------------------------------------------- identity --

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  display_name       text,
  preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'he')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

-- The owner of a dataset. A person, a family, or an organisation - never a bare
-- user_id, so that a synagogue tier does not need a migration later.
CREATE TABLE owners (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('individual', 'household', 'organisation')),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Who may see and edit an owner's dataset. One row per person per owner.
CREATE TABLE owner_members (
  owner_id  uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, user_id)
);

CREATE INDEX owner_members_user_idx ON owner_members (user_id);

-- A dataset: the set of Hebrew dates a family or organisation maintains
-- together. It has NO location and NO destination of its own - those belong to
-- the destination calendars that consume it, because several members in several
-- cities can share one dataset (decision #18).
CREATE TABLE datasets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name             text NOT NULL,
  default_language text NOT NULL DEFAULT 'en' CHECK (default_language IN ('en', 'he')),
  -- What pausing a source record does to its already-synced future events.
  -- Default: hide them (remove from destinations, keep the rows).
  pause_behaviour  text NOT NULL DEFAULT 'hide_future_events'
                     CHECK (pause_behaviour IN ('hide_future_events', 'keep_events')),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX datasets_owner_idx ON datasets (owner_id);

-- One member's calendar, fed by a dataset. This is where location, display mode
-- and visibility live, because they differ per member: a sibling in Melbourne
-- and a sibling in New York share the dates but not the sunsets.
CREATE TABLE destination_calendars (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id            uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  -- Which member this calendar belongs to. Null for a shared calendar that the
  -- owner maintains on everyone's behalf.
  user_id               uuid REFERENCES users(id) ON DELETE SET NULL,
  name                  text NOT NULL,
  destination_type      text NOT NULL CHECK (destination_type IN ('google', 'ical_feed')),
  display_mode          text NOT NULL DEFAULT 'exact_sunset'
                          CHECK (display_mode IN ('exact_sunset', 'two_day_all_day')),
  language              text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'he')),
  -- Dates of death on a calendar that might be shared or shown at work is a real
  -- privacy risk, so events default to private.
  event_visibility      text NOT NULL DEFAULT 'private'
                          CHECK (event_visibility IN ('private', 'calendar_default')),
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX destination_calendars_dataset_idx ON destination_calendars (dataset_id)
  WHERE active;

-- ---------------------------------------------------------------- location --

-- Latitude and longitude are useless without the IANA zone: the zone cannot be
-- derived from coordinates at run time and is required to render a sunset
-- instant as a wall-clock time. use_elevation is stored because applying
-- elevation moves sunset by minutes and must be reproducible.
-- One location per destination calendar, not per dataset: that is the whole
-- point of the split.
CREATE TABLE calendar_locations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_calendar_id  uuid NOT NULL UNIQUE
                             REFERENCES destination_calendars(id) ON DELETE CASCADE,
  display_name        text NOT NULL,
  country_code        char(2) NOT NULL,
  latitude            numeric(9, 6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude           numeric(9, 6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  elevation_meters    integer,
  -- Product decision: apply elevation. Stored explicitly rather than assumed, so
  -- the calculation is reproducible from the row alone.
  use_elevation       boolean NOT NULL DEFAULT true,
  timezone_id         text NOT NULL,
  geocoder_place_id   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------- source records --

CREATE TABLE source_records (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id                  uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  type                        text NOT NULL
                                CHECK (type IN ('birthday', 'personal_yahrzeit', 'famous_yahrzeit')),
  display_name                text NOT NULL,
  hebrew_name                 text,
  relationship                text,

  -- The month is stored by NAME, not number. Month 12 is "Adar" in an ordinary
  -- year and "Adar I" in a leap year, and the anniversary rules branch on which
  -- the user meant. A number cannot express that.
  hebrew_month                text NOT NULL CHECK (hebrew_month IN (
                                'TISHREI', 'CHESHVAN', 'KISLEV', 'TEVET', 'SHVAT',
                                'ADAR', 'ADAR_I', 'ADAR_II',
                                'NISAN', 'IYYAR', 'SIVAN', 'TAMUZ', 'AV', 'ELUL')),
  hebrew_day                  smallint NOT NULL CHECK (hebrew_day BETWEEN 1 AND 30),
  original_hebrew_year        integer CHECK (original_hebrew_year IS NULL OR original_hebrew_year > 0),
  original_gregorian_date     date,
  sunset_status               text CHECK (sunset_status IN ('before_sunset', 'after_sunset')),

  -- Default: observe an Adar yahrzeit in BOTH Adars of a leap year. This is the
  -- one convention that yields two occurrences in a single Hebrew year, which is
  -- what generated_occurrences.sequence exists for.
  calculation_convention      jsonb NOT NULL
                                DEFAULT '{"adarOrdinaryYahrzeitInLeapYear":"both"}'::jsonb,
  custom_title                text,
  notes                       text,
  display_mode_override       text CHECK (display_mode_override IN ('exact_sunset', 'two_day_all_day')),  -- applies to every destination
  active                      boolean NOT NULL DEFAULT true,

  -- Highest Hebrew year materialised so far. The rolling-horizon job selects on
  -- this, so it must be per record rather than per calendar.
  horizon_through_hebrew_year integer,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz,

  -- A Gregorian-entered date must state which side of sunset it fell on.
  -- This is "never silently choose a Hebrew date", expressed as a constraint.
  CONSTRAINT gregorian_entry_needs_sunset_status
    CHECK (original_gregorian_date IS NULL OR sunset_status IS NOT NULL),

  -- A yahrzeit on the 30th of Cheshvan or Kislev cannot be calculated without
  -- the Hebrew year of death: the rule depends on the character of the
  -- following year. See docs/CALCULATION-RULES.md, rules Y1 and Y2.
  CONSTRAINT yahrzeit_30th_needs_origin_year
    CHECK (
      type = 'birthday'
      OR hebrew_day <> 30
      OR hebrew_month NOT IN ('CHESHVAN', 'KISLEV')
      OR original_hebrew_year IS NOT NULL
    ),

  -- Adar I and Adar II exist only in leap years; plain Adar only in ordinary
  -- years. The application validates this against the stated year; the database
  -- guards the shape.
  CONSTRAINT adar_ii_has_no_30th
    CHECK (NOT (hebrew_month IN ('ADAR', 'ADAR_II', 'IYYAR', 'TAMUZ', 'ELUL', 'TEVET')
                AND hebrew_day = 30))
);

CREATE INDEX source_records_dataset_idx ON source_records (dataset_id)
  WHERE deleted_at IS NULL;
CREATE INDEX source_records_horizon_idx ON source_records (horizon_through_hebrew_year)
  WHERE active AND deleted_at IS NULL;

-- ---------------------------------------------------- generated occurrences --

-- One materialised instance per Hebrew year, per observance. Deliberately NOT a
-- recurrence rule: a Hebrew date lands on a different Gregorian date every year.
--
-- This table is LOCATION-FREE. One family dataset can feed several members'
-- calendars in different cities, and the Hebrew date they observe is the same
-- one; only the sunset window differs. So times, time zone and the location
-- snapshot live on destination_events, and the Hebrew-date reasoning is stored
-- exactly once. See docs/DATA-MODEL.md section 5.
CREATE TABLE generated_occurrences (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_record_id    uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  hebrew_year         integer NOT NULL,

  -- Reserved for a future convention that observes one date twice in a Hebrew
  -- year (e.g. both Adars). Always 0 today. Present now so that supporting it
  -- later does not re-key every stored event.
  sequence            smallint NOT NULL DEFAULT 0,

  -- sha256(source_record_id, hebrew_year, sequence), computed by the engine.
  -- This is the idempotency anchor; the Google event ID derives from it.
  occurrence_key      char(32) NOT NULL UNIQUE,

  hebrew_month        smallint NOT NULL CHECK (hebrew_month BETWEEN 1 AND 13),
  hebrew_day          smallint NOT NULL CHECK (hebrew_day BETWEEN 1 AND 30),

  -- The Gregorian day the Hebrew date's daytime falls on. Location-independent:
  -- a Hebrew date lands on the same Gregorian day everywhere. Only the sunset
  -- *times* differ by location, and those live on destination_events.
  gregorian_date      date NOT NULL,

  calculation_version text NOT NULL,
  rule_applied        text NOT NULL,
  ambiguities         jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_manual_override  boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT occurrence_unique_per_year UNIQUE (source_record_id, hebrew_year, sequence)
);

CREATE INDEX occurrences_upcoming_idx ON generated_occurrences (gregorian_date);
CREATE INDEX occurrences_stale_idx ON generated_occurrences (calculation_version);

-- ------------------------------------------------------- destination events --

-- One occurrence as it exists in ONE member's calendar. This is where location
-- lands: the sunset window, the time zone and the rendered content all depend on
-- where that member is.
CREATE TABLE destination_events (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_occurrence_id uuid NOT NULL REFERENCES generated_occurrences(id) ON DELETE CASCADE,
  destination_calendar_id uuid NOT NULL REFERENCES destination_calendars(id) ON DELETE CASCADE,
  destination_type        text NOT NULL CHECK (destination_type IN ('google', 'ical_feed')),
  external_calendar_id    text,
  external_event_id       text,

  -- Sunset-to-sunset window at THIS destination's location. Null where the sun
  -- does not set there on these dates, in which case the event must fall back to
  -- the all-day representation rather than being written with an invalid time.
  start_at                timestamptz,
  end_at                  timestamptz,
  timezone_id             text NOT NULL,
  -- The location exactly as used, so a later location change is detectable
  -- without reasoning about history.
  location_snapshot       jsonb NOT NULL,

  -- Hash of the content last successfully written. Reconciliation compares this
  -- with the freshly computed hash: equal means skip the write entirely.
  content_hash            char(32) NOT NULL,

  sync_status             text NOT NULL DEFAULT 'pending' CHECK (sync_status IN (
                            'pending', 'creating', 'synced', 'updating',
                            'deleting', 'retry_scheduled', 'failed', 'disconnected')),
  attempt_count           smallint NOT NULL DEFAULT 0,
  next_attempt_at         timestamptz,
  last_synced_at          timestamptz,
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- One event per occurrence per member's calendar. Keyed by the destination
  -- calendar, not by destination *type*, so a family of four legitimately has
  -- four events for one anniversary.
  CONSTRAINT one_event_per_occurrence_per_destination
    UNIQUE (generated_occurrence_id, destination_calendar_id),

  CONSTRAINT timing_is_all_or_nothing CHECK ((start_at IS NULL) = (end_at IS NULL)),
  CONSTRAINT timing_is_ordered CHECK (start_at IS NULL OR start_at < end_at)
);

CREATE INDEX destination_events_calendar_idx
  ON destination_events (destination_calendar_id, start_at);

-- Last line of defence against duplicate calendar events: even a logic bug
-- cannot register two rows pointing at the same external event.
CREATE UNIQUE INDEX destination_events_external_idx
  ON destination_events (external_calendar_id, external_event_id)
  WHERE external_event_id IS NOT NULL;

-- The worker's only hot query.
CREATE INDEX destination_events_work_idx
  ON destination_events (sync_status, next_attempt_at)
  WHERE sync_status IN ('pending', 'retry_scheduled', 'updating', 'deleting');

-- --------------------------------------------------------------- reminders --

-- Reminders are a per-member preference: siblings can want different notice on
-- the same yahrzeit.
CREATE TABLE reminder_rules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_calendar_id uuid REFERENCES destination_calendars(id) ON DELETE CASCADE,
  source_record_id        uuid REFERENCES source_records(id) ON DELETE CASCADE,
  event_type           text CHECK (event_type IN ('birthday', 'personal_yahrzeit', 'famous_yahrzeit')),
  minutes_before_start    integer NOT NULL CHECK (minutes_before_start >= 0),
  enabled                 boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),

  -- A rule is either a calendar default or a record override, never both.
  CONSTRAINT reminder_scope_is_exclusive
    CHECK ((destination_calendar_id IS NULL) <> (source_record_id IS NULL))
);

-- -------------------------------------------------------------- sync jobs --

CREATE TABLE sync_jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id              uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  -- Null for a job that spans every destination of the dataset.
  destination_calendar_id uuid REFERENCES destination_calendars(id) ON DELETE CASCADE,
  job_type            text NOT NULL CHECK (job_type IN (
                        'initial_sync', 'reconcile', 'extend_horizon',
                        'recalculate', 'delete_events')),
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN (
                        'queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt_count       smallint NOT NULL DEFAULT 0,
  scheduled_at        timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  error_summary       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Claimed with SELECT ... FOR UPDATE SKIP LOCKED; see docs/ARCHITECTURE.md D2.
CREATE INDEX sync_jobs_claim_idx ON sync_jobs (status, scheduled_at)
  WHERE status = 'queued';
CREATE INDEX sync_jobs_dataset_idx ON sync_jobs (dataset_id, created_at DESC);

COMMIT;
