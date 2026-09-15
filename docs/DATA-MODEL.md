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

An **owner** holds a dataset. It is a person, a family or an organisation — never
a bare `user_id`, so that a synagogue tier (decision #19) needs no migration.

```
users
  id, email (citext unique), display_name, preferred_language, timestamps

owners                               -- who holds a dataset
  id       uuid pk
  kind     text not null             -- 'individual' | 'household' | 'organisation'
  name     text not null

owner_members                        -- who may see and edit it
  owner_id, user_id  composite pk
  role     text not null             -- 'admin' | 'editor' | 'viewer'

datasets                             -- the shared set of Hebrew dates
  id               uuid pk
  owner_id         uuid not null → owners(id)
  name             text not null
  default_language text not null default 'en'
  pause_behaviour  text not null default 'hide_future_events'
  active           boolean not null default true

destination_calendars                -- ONE MEMBER'S calendar, fed by a dataset
  id                     uuid pk
  dataset_id             uuid not null → datasets(id)
  user_id                uuid → users(id)   -- null for a shared calendar
  name                   text not null
  destination_type       text not null      -- 'google' | 'ical_feed'
  display_mode           text not null default 'exact_sunset'
  language               text not null default 'en'
  calendar_timezone_hint text               -- the CALENDAR's own zone: a hint only
  event_visibility       text not null default 'default'   -- Google's vocabulary
  active                 boolean not null default true
```

Two fields there carry product decisions worth restating:

- `calendar_timezone_hint` is the destination calendar's own IANA zone, as
  reported by Google's `calendars.get`. It seeds a location *suggestion* and
  supplies `timeZone` on a timed event. **It is never an input to a sunset
  calculation** — that comes from `calendar_locations.latitude/longitude`. A
  separate column, not a reused one, so the two cannot be confused.
- `event_visibility` defaults to `'default'`, Google's own value, meaning the
  event inherits the calendar's visibility and **calendar-level sharing decides
  who sees the details**. Events stay `transparency: transparent` regardless.

Note what a `dataset` does **not** have: a location or a destination. Those are
properties of each member's calendar, because members can be in different cities
(decision #18). See §5.

### Location — one per destination calendar, not per dataset

```
calendar_locations
  id                      uuid pk
  destination_calendar_id uuid not null unique → destination_calendars(id) on delete cascade
  display_name        text not null
  country_code        char(2) not null
  latitude            numeric(9,6) not null           -- check -90..90
  longitude           numeric(9,6) not null           -- check -180..180
  elevation_meters    integer
  use_elevation       boolean not null default true   -- ADDED, see §3.3
  timezone_id         text not null                   -- IANA zone OF THIS PLACE
  geocoder_place_id   text
  source              text not null default 'user_selected'
                        -- 'user_selected'|'geocoded'|'timezone_suggestion'|'calendar_timezone_hint'
  confirmed_at        timestamptz                     -- NULL = suggested, not confirmed
  confirmed_by_user_id uuid → users(id)
  created_at, updated_at

  CHECK (confirmed_at IS NULL OR confirmed_by_user_id IS NOT NULL)
  INDEX (destination_calendar_id) WHERE confirmed_at IS NULL   -- the planner's gate
```

`latitude` and `longitude` are the sunset inputs; `timezone_id` says how to
render the result. `confirmed_at` NULL means the location is a *suggestion* — the
sync planner refuses to write events for such a destination, so a guess derived
from a time zone can never silently become a calculation. The confirmation
records who made it, so it is auditable rather than a boolean that might have
been defaulted.

One current location per destination calendar. The MVP keeps one row and updates
it, recording the change in `sync_jobs` so the recalculation is auditable.

### Connections and feeds

```
google_calendar_connections
  id                        uuid pk
  destination_calendar_id   uuid not null unique → destination_calendars(id)
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
  destination_calendar_id uuid not null → destination_calendars(id)
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
  dataset_id              uuid not null → datasets(id)
  type                    text not null            -- 'birthday'|'personal_yahrzeit'|'famous_yahrzeit'
  display_name            text not null
  hebrew_name             text
  relationship            text
  hebrew_month            text not null            -- CHANGED: name, not number. See §3.1
  hebrew_day              smallint not null        -- check 1..30
  original_hebrew_year    integer                  -- conditionally required, see §3.2
  original_gregorian_date date
  sunset_status           text                     -- 'before_sunset'|'after_sunset'|null
  calculation_convention  jsonb not null default '{"adarOrdinaryYahrzeitInLeapYear":"both"}'
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

### Generated occurrences — what the engine computed, **location-free**

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
  calculation_version  text not null
  rule_applied         text not null                  -- ADDED: which documented rule fired
  ambiguities          jsonb not null default '[]'    -- ADDED: what needs review
  is_manual_override   boolean not null default false
  created_at, updated_at

  UNIQUE (source_record_id, hebrew_year, sequence)
  INDEX  (gregorian_date)                             -- "upcoming" dashboard query
  INDEX  (calculation_version)                        -- find stale rows to requeue
```

There are **no times here, and no location**. A Hebrew date falls on the same
Gregorian day everywhere on earth; only the sunset window differs. Keeping this
table location-free is what lets one dataset serve a family across several cities
while the Hebrew-date reasoning is stored exactly once (§5).

### Destination events — what actually exists in a calendar

```
destination_events
  id                       uuid pk
  generated_occurrence_id  uuid not null → generated_occurrences(id) on delete cascade
  destination_calendar_id  uuid not null → destination_calendars(id) on delete cascade
  destination_type         text not null              -- 'google' | 'ical_feed'
  external_calendar_id     text
  external_event_id        text
  start_at                 timestamptz                -- MOVED HERE: sunset at THIS location
  end_at                   timestamptz                -- null where the sun does not set
  timezone_id              text not null              -- MOVED HERE
  location_snapshot        jsonb not null             -- MOVED HERE
  content_hash             char(32) not null          -- hash last successfully written
  sync_status              text not null              -- see PRD 27
  attempt_count            smallint not null default 0
  next_attempt_at          timestamptz                -- ADDED: backoff scheduling
  last_synced_at           timestamptz
  last_error               text
  created_at, updated_at

  UNIQUE (generated_occurrence_id, destination_calendar_id)   -- CHANGED, see §5
  UNIQUE (external_calendar_id, external_event_id) WHERE external_event_id IS NOT NULL
  CHECK  ((start_at IS NULL) = (end_at IS NULL))
  CHECK  (start_at IS NULL OR start_at < end_at)
  INDEX  (sync_status, next_attempt_at)               -- the worker's only hot query
  INDEX  (destination_calendar_id, start_at)          -- one member's upcoming events
```

The second unique index is the last line of defence against duplicates: even a
logic bug cannot register two rows pointing at one Google event.

### Reminders, famous people, jobs

```
reminder_rules            (destination_calendar_id | source_record_id, minutes_before_start, enabled)
                          -- per member: siblings can want different notice
famous_people             (per PRD 21.3, plus editorial_status and confidence_level)
famous_person_sources     (per PRD 21.5 — a person cannot be published with zero rows here)
famous_subscriptions      (dataset_id, famous_person_id, active, reminder_override)
sync_jobs                 (dataset_id, destination_calendar_id?, job_type, status,
                           attempt_count, scheduled_at, started_at, completed_at,
                           error_summary)
audit_log                 (ADDED: actor, action, subject_type, subject_id, at)
```

`audit_log` exists because PRD 30 requires logging administrative access to
famous-yahrzeit records and PRD 33 requires change history.

## 3. Divergences from PRD 24, with reasons

| # | Change | Reason |
|---|---|---|
| 3.1 | `source_records.hebrew_month` stores a **name**, not a number | Month 12 is Adar in an ordinary year and Adar I in a leap year, and the anniversary rules branch on which the user meant. A number loses that. `PRD-REVIEW.md` §1.2 |
| 3.2 | `original_hebrew_year` is conditionally required by CHECK constraint | Two yahrzeit rules depend on the character of the year after the death. §1.1 |
| 3.3 | `use_elevation` added to locations, **defaulting to true** | Elevation moves Jerusalem sunset by ~5 minutes; whether it was applied must be part of the reproducible calculation snapshot. §1.6, decision #8 |
| 3.4 | `horizon_through_hebrew_year` on the source record | The rolling-horizon job needs a per-record, indexable predicate. §4.3 |
| 3.5 | `sequence` added to the occurrence key | **Now in use**, not merely reserved: the default convention observes an Adar yahrzeit in both Adars, so a leap year holds two occurrences. Adar I is always sequence 0. §1.4, decision #4 |
| 3.6 | `occurrence_key` and `content_hash` are stored, not derived | They are the idempotency contract; storing them makes a mismatch detectable rather than merely unlikely |
| 3.7 | `rule_applied` and `ambiguities` stored per occurrence | PRD 5.4 promises the user can see "the rule used for unusual Hebrew-calendar cases". That requires persisting it. |
| 3.8 | `encryption_key_id` on the Google connection | Envelope encryption is only useful if keys can be rotated |
| 3.9 | `next_attempt_at` on destination events | PRD 27's backoff needs a schedulable column, not just a status |
| 3.10 | `calendar_timezone_hint` on destination calendars, separate from the location's zone | A time zone is not a place; `America/New_York` spans more than half an hour of sunset difference. Decision #11 |
| 3.11 | `source`, `confirmed_at`, `confirmed_by_user_id` on locations | A suggestion must not become a calculation without the user saying so. Decision #11 |
| 3.12 | `event_visibility` defaults to `'default'` and uses Google's vocabulary | Calendar-level sharing governs who sees details; a shared family calendar is the point. Decision #12 |

## 4. Migration plan

Plain, ordered, forward-only SQL. Each file is idempotent at the statement level
(`IF NOT EXISTS` where the dialect allows) and reversible by an explicit `down`
file only where reversal is safe.

| Migration | Contents | Phase |
|---|---|---|
| `0001_init.sql` | `users`, `owners`, `owner_members`, `datasets`, `destination_calendars`, `calendar_locations`, `source_records`, `generated_occurrences`, `destination_events`, `reminder_rules`, `sync_jobs`, all constraints and indexes. **Applies cleanly against PostgreSQL 16; `db/tests/constraints.sql` verifies all 17 product rules it encodes.** | 2 |
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

## 5. The family-dataset change (decision #18)

One family dataset must populate several members' individual calendars, and
those members may be in different cities. That breaks the current assumption of
one location per dataset, and it is far cheaper to restructure before any real
events exist.

**What breaks.** `generated_occurrences` currently stores sunset instants and a
location snapshot, because there is one location per calendar. Two members in two
cities need two different sunset windows for what is still *one* anniversary.

**The fix: separate what depends on location from what does not.**

| Layer | Holds | Location-dependent? |
|---|---|---|
| `source_records` | what the user entered | no |
| `generated_occurrences` | Hebrew date, Gregorian date, `rule_applied`, `ambiguities`, `sequence` | **no** |
| `destination_calendars` *(new)* | one member's calendar: destination type, location, display mode, reminders, visibility | — |
| `destination_events` | `start_at`, `end_at`, title, description, `content_hash`, external event ID | **yes** |

So `start_at`, `end_at`, `timezone_id` and `location_snapshot` move from
`generated_occurrences` to `destination_events`, and `calendar_locations` hangs
off `destination_calendars` rather than off the profile. A family of four in four
cities then has **one** set of occurrences and four sets of events, and the
Hebrew-date reasoning happens exactly once.

Two further consequences:

- `destination_events` is keyed `UNIQUE (generated_occurrence_id,
  destination_calendar_id)` rather than by `destination_type`, so one occurrence
  can legitimately reach several calendars.
- The dataset owner must be an **entity**, not a `user_id`, so that decision #19
  (synagogues and organisations) does not require another migration. A household
  and an organisation are both owners; membership is a join table.

**Engine consequence**, scheduled as the next change:

```ts
// today — fuses the two concerns
generateOccurrences({ origin, location, displayMode, count }) → Occurrence[]

// next  — split, so one dataset serves many destinations
resolveOccurrences({ origin, count })                 → HebrewOccurrence[]
renderForDestination(occurrence, destinationCalendar)  → DestinationEvent
```

No rule changes are involved: `resolveAnniversary` is already
location-independent and `sunsetOn` is already separate. It is a re-seam of
`occurrences.ts`, which is why it belongs before Phase 2 persistence, not after.

## 6. Authorisation

Every row above is reachable from exactly one `datasets.id`, and access to a
dataset is a lookup in `owner_members` for the session's user. Every query filters
on a dataset resolved that way — never on an ID taken from the request path
without the check. Two enforcement layers:

1. A single `assertDatasetAccess(session, datasetId, minimumRole)` helper that
   every route calls before touching data, with a test that fails the build if a
   route handler reads a dataset-scoped table without it. Roles matter now that
   datasets are shared: a `viewer` must not be able to edit a source record that
   would change another member's calendar.
2. Postgres row-level security as defence in depth, with the session's user ID
   set per transaction.

PRD 30 asks for authorisation-boundary tests; the concrete form is a suite that
takes every route, authenticates as user B, and passes user A's IDs. Nothing
should return 200.
