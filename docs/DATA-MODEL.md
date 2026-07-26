# Data model and migration plan

The schema follows PRD 24 with the changes argued in `PRD-REVIEW.md`. Every
divergence is listed in §3 with its reason.

## 1. Design rules

1. **The database is the source of truth.** A destination event is a *projection*
   with a foreign key back to the occurrence that produced it. Losing Google
   access loses nothing.
2. **Every occurrence is addressable.** `(source_record_id, hebrew_year,
   sequence)` is unique, and `occurrence_key` is a deterministic hash of exactly
   those three things. The key is computed in the engine, not in SQL, so the
   worker, the web app and the feed generator all agree.
3. **Snapshots, not joins, for anything a calculation depended on.** An
   occurrence stores the location and the calculation version it was computed
   with. When the location changes, the difference is detectable without
   reasoning about history.
4. **Soft-delete where the PRD promises "past events are preserved"**
   (`deleted_at`), hard-delete nothing that a calendar event points at.
5. **Nothing sensitive is stored in plaintext.** OAuth tokens are envelope
   encrypted; feed tokens are stored only as a hash.

## 2. Tables

### Identity and ownership

```
users
  id                  uuid pk
  email               citext unique not null
  display_name        text
  preferred_language  text not null default 'en'     -- 'en' | 'he'
  created_at          timestamptz not null default now()
  updated_at          timestamptz not null default now()
  deleted_at          timestamptz

calendar_profiles                    -- one "Hebrew Dates calendar"
  id                  uuid pk
  owner_user_id       uuid not null → users(id)
  name                text not null
  destination_type    text not null                  -- 'google' | 'ical_feed'
  display_mode        text not null default 'exact_sunset'
  default_language    text not null default 'en'
  active              boolean not null default true
  created_at, updated_at
```

Every subsequent table hangs off `calendar_profiles`, so authorisation is a
single ownership check resolved from the session. See §5.

### Location

```
calendar_locations
  id                  uuid pk
  calendar_profile_id uuid not null → calendar_profiles(id) on delete cascade
  display_name        text not null
  country_code        char(2) not null
  latitude            numeric(9,6) not null           -- check -90..90
  longitude           numeric(9,6) not null           -- check -180..180
  elevation_meters    integer
  use_elevation       boolean not null default false  -- ADDED, see §3.3
  timezone_id         text not null                   -- IANA, e.g. Asia/Jerusalem
  geocoder_place_id   text
  created_at, updated_at
```

One current location per profile, enforced by a partial unique index on
`(calendar_profile_id) WHERE superseded_at IS NULL` if history is kept; the MVP
keeps one row and updates it, recording the change in `sync_jobs`.

### Connections and feeds

```
google_calendar_connections
  id                        uuid pk
  calendar_profile_id       uuid not null unique → calendar_profiles(id)
  google_account_id         text not null
  google_calendar_id        text
  encrypted_access_token    bytea not null
  encrypted_refresh_token   bytea not null
  encryption_key_id         text not null            -- ADDED: KMS key, for rotation
  token_expiry              timestamptz
  scope                     text not null
  connection_status         text not null            -- 'connected'|'needs_reauth'|'revoked'
  last_sync_at              timestamptz
  last_error                text
  created_at, updated_at

calendar_feeds
  id                  uuid pk
  calendar_profile_id uuid not null → calendar_profiles(id)
  token_hash          bytea not null unique          -- sha256 of a 256-bit token
  token_prefix        char(8) not null               -- ADDED: for support lookup without the token
  revoked_at          timestamptz
  last_accessed_at    timestamptz
  created_at          timestamptz not null default now()
```

The token itself is shown to the user exactly once and never stored.

### Source records — what the user entered

```
source_records
  id                      uuid pk
  calendar_profile_id     uuid not null → calendar_profiles(id)
  type                    text not null            -- 'birthday'|'personal_yahrzeit'|'famous_yahrzeit'
  display_name            text not null
  hebrew_name             text
  relationship            text
  hebrew_month            text not null            -- CHANGED: name, not number. See §3.1
  hebrew_day              smallint not null        -- check 1..30
  original_hebrew_year    integer                  -- conditionally required, see §3.2
  original_gregorian_date date
  sunset_status           text                     -- 'before_sunset'|'after_sunset'|null
  calculation_convention  jsonb not null default '{"adarOrdinaryYahrzeitInLeapYear":"adar_i"}'
  custom_title            text
  notes                   text
  display_mode_override   text
  famous_person_id        uuid → famous_people(id) -- only for type='famous_yahrzeit'
  active                  boolean not null default true
  horizon_through_hebrew_year integer              -- ADDED, see §3.4
  created_at, updated_at, deleted_at
```

Constraints that carry real meaning:

```sql
-- A Gregorian-entered date must say which side of sunset it was on.
CHECK (original_gregorian_date IS NULL OR sunset_status IN ('before_sunset','after_sunset'))

-- A yahrzeit on the 30th of a variable-length month needs the Hebrew year.
CHECK (
  type = 'birthday'
  OR hebrew_day <> 30
  OR hebrew_month NOT IN ('CHESHVAN','KISLEV')
  OR original_hebrew_year IS NOT NULL
)

-- The month name must be one the engine understands.
CHECK (hebrew_month IN ('TISHREI','CHESHVAN','KISLEV','TEVET','SHVAT','ADAR',
                        'ADAR_I','ADAR_II','NISAN','IYYAR','SIVAN','TAMUZ','AV','ELUL'))
```

The second constraint is the database-level expression of "never silently choose
a Hebrew date": an under-specified yahrzeit cannot be persisted at all.

### Generated occurrences — what the engine computed

```
generated_occurrences
  id                   uuid pk
  source_record_id     uuid not null → source_records(id) on delete cascade
  hebrew_year          integer not null
  sequence             smallint not null default 0    -- ADDED, see §3.5
  occurrence_key       char(32) not null unique       -- ADDED: engine-computed
  hebrew_month         smallint not null              -- resolved month NUMBER (1..13)
  hebrew_day           smallint not null
  gregorian_date       date not null                  -- daytime of the Hebrew date
  start_at             timestamptz                    -- null where the sun does not set
  end_at               timestamptz
  timezone_id          text not null
  location_snapshot    jsonb not null
  calculation_version  text not null
  rule_applied         text not null                  -- ADDED: which documented rule fired
  ambiguities          jsonb not null default '[]'    -- ADDED: what needs review
  is_manual_override   boolean not null default false
  content_hash         char(32) not null              -- ADDED: drives reconciliation
  created_at, updated_at

  UNIQUE (source_record_id, hebrew_year, sequence)
  CHECK  ((start_at IS NULL) = (end_at IS NULL))
  INDEX  (gregorian_date)                             -- "upcoming" dashboard query
  INDEX  (source_record_id, hebrew_year)
```

### Destination events — what actually exists in a calendar

```
destination_events
  id                       uuid pk
  generated_occurrence_id  uuid not null → generated_occurrences(id) on delete cascade
  destination_type         text not null              -- 'google' | 'ical_feed'
  external_calendar_id     text
  external_event_id        text
  content_hash             char(32) not null          -- hash last successfully written
  sync_status              text not null              -- see PRD 27
  attempt_count            smallint not null default 0
  next_attempt_at          timestamptz                -- ADDED: backoff scheduling
  last_synced_at           timestamptz
  last_error               text
  created_at, updated_at

  UNIQUE (generated_occurrence_id, destination_type)
  UNIQUE (external_calendar_id, external_event_id) WHERE external_event_id IS NOT NULL
  INDEX  (sync_status, next_attempt_at)               -- the worker's only hot query
```

The second unique index is the last line of defence against duplicates: even a
logic bug cannot register two rows pointing at one Google event.

### Reminders, famous people, jobs

```
reminder_rules            (calendar_profile_id | source_record_id, minutes_before_start, enabled)
famous_people             (per PRD 21.3, plus editorial_status and confidence_level)
famous_person_sources     (per PRD 21.5 — a person cannot be published with zero rows here)
famous_subscriptions      (calendar_profile_id, famous_person_id, active, reminder_override)
sync_jobs                 (calendar_profile_id, job_type, status, attempt_count,
                           scheduled_at, started_at, completed_at, error_summary)
audit_log                 (ADDED: actor, action, subject_type, subject_id, at)
```

`audit_log` exists because PRD 30 requires logging administrative access to
famous-yahrzeit records and PRD 33 requires change history.

## 3. Divergences from PRD 24, with reasons

| # | Change | Reason |
|---|---|---|
| 3.1 | `source_records.hebrew_month` stores a **name**, not a number | Month 12 is Adar in an ordinary year and Adar I in a leap year, and the anniversary rules branch on which the user meant. A number loses that. `PRD-REVIEW.md` §1.2 |
| 3.2 | `original_hebrew_year` is conditionally required by CHECK constraint | Two yahrzeit rules depend on the character of the year after the death. §1.1 |
| 3.3 | `use_elevation` added to locations | Elevation moves Jerusalem sunset by ~5 minutes; whether it was applied must be part of the reproducible calculation snapshot. §1.6 |
| 3.4 | `horizon_through_hebrew_year` on the source record | The rolling-horizon job needs a per-record, indexable predicate. §4.3 |
| 3.5 | `sequence` added to the occurrence key | Leaves room for a convention that observes a date twice in one Hebrew year without re-keying every event. §1.4 |
| 3.6 | `occurrence_key` and `content_hash` are stored, not derived | They are the idempotency contract; storing them makes a mismatch detectable rather than merely unlikely |
| 3.7 | `rule_applied` and `ambiguities` stored per occurrence | PRD 5.4 promises the user can see "the rule used for unusual Hebrew-calendar cases". That requires persisting it. |
| 3.8 | `encryption_key_id` on the Google connection | Envelope encryption is only useful if keys can be rotated |
| 3.9 | `next_attempt_at` on destination events | PRD 27's backoff needs a schedulable column, not just a status |

## 4. Migration plan

Plain, ordered, forward-only SQL. Each file is idempotent at the statement level
(`IF NOT EXISTS` where the dialect allows) and reversible by an explicit `down`
file only where reversal is safe.

| Migration | Contents | Phase |
|---|---|---|
| `0001_init.sql` | `users`, `calendar_profiles`, `calendar_locations`, `source_records`, `generated_occurrences`, `destination_events`, `reminder_rules`, `sync_jobs`, all constraints and indexes | 2 |
| `0002_google_connections.sql` | `google_calendar_connections`, `audit_log` | 2 |
| `0003_feeds.sql` | `calendar_feeds` | 4 |
| `0004_famous.sql` | `famous_people`, `famous_person_sources`, `famous_subscriptions` | 5 |

Rules the project holds itself to:

1. **A migration never rewrites `generated_occurrences` content.** Recalculation
   is a *job*, not a migration, so it is observable, resumable and rate-limited
   against Google. A migration may bump `calculation_version` on rows to *mark*
   them stale; the worker does the rest.
2. **Adding a column is separate from backfilling it.** Deploy the column with a
   default, backfill in batches, then add the `NOT NULL` in a third migration.
3. **The engine's `CALCULATION_VERSION` is the trigger for recalculation, not a
   schema version.** Occurrences store the version that produced them; a job
   selects `WHERE calculation_version <> $current` and requeues.
4. **No `DROP COLUMN` in the same release that stops writing it.** Two releases,
   minimum, so a rollback does not lose data.

## 5. Authorisation

Every row above is reachable from exactly one `calendar_profiles.id`, and every
query in the application filters on a profile resolved from the session — never
on an ID taken from the request path without that check. Two enforcement layers:

1. A single `assertProfileAccess(session, profileId)` helper that every route
   calls before touching data, with a test that fails the build if a route
   handler reads a profile-scoped table without it.
2. Postgres row-level security as defence in depth, with the session's user ID
   set per transaction.

PRD 30 asks for authorisation-boundary tests; the concrete form is a suite that
takes every route, authenticates as user B, and passes user A's IDs. Nothing
should return 200.
