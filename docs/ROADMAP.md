# Phased plan and issue backlog

Phases follow PRD 37, with the scope changes argued in `PRD-REVIEW.md` §2. Each
phase has an exit criterion that is checkable, not a feeling.

| Phase | Outcome | Exit criterion |
|---|---|---|
| **1. Calculation prototype** ✅ | Tested engine + a UI that previews occurrences | 200+ engine tests green; a user can select a location, enter a date, preview 20 occurrences and switch display modes |
| **2. Google Calendar MVP** ✅ | Persisted records, real Google sync | ✅ A record created in the UI appears correctly in Google Calendar and survives a re-sync without duplicating |
| **3. Reliability** | Background jobs, reconciliation, deletion, export | Kill the worker mid-sync; the next run converges with no duplicates and no lost events |
| **4. Apple subscription** | Private iCalendar feed | The feed validates against RFC 5545 and renders correctly on the tested device matrix |
| **5. Famous yahrzeits** | Curated library + editorial workflow | No record publishable without a source; a correction propagates to future events only |
| **6. Family and locale** | Sharing, multiple calendars, Hebrew UI | A second family member sees the calendar; the Hebrew interface is usable RTL |

**All PRD features are in scope** (decision #1). The phases are the *delivery
order*, not a scope reduction: each one ships something usable, and the ordering
puts calculation correctness and idempotent synchronisation before breadth, per
the PRD's own principle 5.3. Phase 6 additionally carries the family-dataset work
that decision #18 promoted from "future version" to required.

---

## Phase 1 — Calculation prototype ✅ delivered

- [x] `#1` Workspace scaffolding: pnpm workspaces, TypeScript, Vitest
- [x] `#2` Engine domain types; no `Date` at the boundary
- [x] `#3` Hebrew calendar primitives, month naming, validation
- [x] `#4` Anniversary rule engine with named rules and ambiguity reporting
- [x] `#5` Refusal path for undecidable yahrzeits
- [x] `#6` Sunset engine with IANA zones and polar handling
- [x] `#7` Gregorian entry and the before/after/unknown sunset flow
- [x] `#8` Occurrence generation, both display modes
- [x] `#9` Stable IDs, Google event IDs, content hashing
- [x] `#10` Event titles and descriptions
- [x] `#11` Seed location catalogue behind a `LocationProvider` interface
- [x] `#12` Golden-date fixture set and year-characteristic table
- [x] `#13` Test suites for every PRD 35.1 bullet the engine covers
- [x] `#14` Next.js preview prototype
- [x] `#15` PRD review, architecture, schema and rules documentation

### Delivered early, because it needs no infrastructure and no credentials

- [x] `#32` (from Phase 3) **50-year `.ics` export.** `packages/ical` renders
  occurrences to RFC 5545, and `/api/export.ics` serves a downloadable file.
  Pulled forward because it lets a real calendar client be tested before any
  OAuth grant exists, and because the same renderer becomes the Phase 4
  subscription feed. Validated against an independent iCalendar parser as well
  as its own 29 tests.

- [x] **Family-dataset refactor** (decision #18). `resolveOccurrences` produces
  location-free Hebrew occurrences; `renderForDestination` renders each one for a
  particular member's calendar. One dataset now feeds several members in several
  cities: same Hebrew dates and keys, different sunset windows, event IDs and
  hashes. `generateOccurrences` is a thin composition of the two, asserted to be
  byte-identical to calling them directly. 21 new tests.
- [x] **Schema restructured and verified against real PostgreSQL 16.**
  `owners` / `owner_members` / `datasets` / `destination_calendars` replace the
  single `calendar_profiles`; times and location snapshots moved from
  `generated_occurrences` to `destination_events`. `db/tests/constraints.sql`
  proves all 17 product rules the schema encodes, including that one occurrence
  legitimately has two events in two zones while a duplicate in one member's
  calendar is rejected.

- [x] **Location and calendar time zone made explicitly separate** (decision
  #11). Sunset comes only from the destination's saved coordinates + IANA zone;
  the calendar's own zone is a hint and a display setting. Suggested locations
  must be confirmed, and the planner refuses unconfirmed ones.
- [x] **Event visibility changed to `default`** (decision #12), keeping
  `transparency: transparent`. Calendar-level sharing governs who sees details.

- [x] **`@hebrew-dates/sync` — reconciliation planner.** `planSync(desired,
  actual)` → typed `create | update | delete | noop | skip` actions. Pure: no
  network, no database. Handles interrupted runs, retries with backoff, attempt
  limits, past-event preservation, nearest-first ordering, write budgets, and
  whole-destination blocks. **53 tests.**
- [x] **`@hebrew-dates/google-calendar` — event payload mapper.**
  `toGoogleEvent(event)` → a Google `Event` resource. Encodes the deterministic
  ID, `transparency: transparent`, `visibility: default`, the timed-vs-all-day
  choice, the exclusive all-day end date, reminder overrides with Google's
  limits, and queryable provenance in `extendedProperties.private`.
  **40 tests.**

### Next: needs decisions (see docs/DECISIONS.md §5)

- [ ] **Postgres provisioning + typed query layer** — blocked on D1/D3.
- [ ] **`@hebrew-dates/google-client`** — the HTTP executor: OAuth with
  `calendar.app.created`, insert/patch/delete, 409-means-exists handling, 403
  and 404 classification, rate-limit backoff. This is the first code in the
  project that needs a credential.

---

## Phase 2 — Google Calendar MVP ✅ core flow delivered

The stop condition was: sign in → confirm location → add a Hebrew date → a
dedicated Google calendar is created → real events are synchronised. That works,
and is covered by 46 integration tests against a real PostgreSQL, real
AES-256-GCM encryption, and a `fetch`-level Google double.

- [x] `#16` Provision PostgreSQL and apply the migrations
- [x] `#17` Google OAuth with `calendar.app.created`
- [x] `#18` Dataset, destination calendar and location
- [x] `#19` Source record CRUD *(create, pause, soft-delete; edit and duplicate in the UI remain)*
- [x] `#20` Persist generated occurrences
- [x] `#21` Google Calendar adapter
- [x] `#22` Nearest-first synchronisation
- [x] `#23` Reminders
- [x] `#24` Dashboard *(minimum viable; see the gaps below)*
- [x] `#25` Authorisation boundary test suite

### #16 — Provision PostgreSQL and apply the migrations ✅
Neon; `db/migrations/0001_init.sql` and `0002_auth_and_google.sql` applied by
`pnpm db:migrate`, which refuses a pooled endpoint and reports what is applied.
The runner is immutable-by-checksum, rolls a failing file back cleanly, and
serialises concurrent runners on a pinned connection.

**Done:** 40 constraint checks and 59 schema-parity assertions pass against
PostgreSQL 16, and the suite skips rather than fails without a database.

### #17 — Google OAuth with `calendar.app.created` ✅
Authorisation code flow with PKCE S256, single-use `state` consumed from the
database, HTTP-only session cookie. Refresh tokens envelope-encrypted with a
KMS-wrapped data key; `encryption_key_id` stored beside the ciphertext and
re-wrapped lazily on the read path. Access tokens are never persisted.

**Done:** connect, disconnect and reconnect all work; a revoked grant surfaces
as `connection_status = 'needs_reauth'` and stops that account's pending events
rather than retrying; nothing token-shaped is logged, and the audit log records
scopes only.

**On the verification risk:** the flow is built and tested against a test OAuth
client so verification is not a blocker to development. What Google requires,
and how long it takes, must be read from the Console for this project rather
than assumed — see ARCHITECTURE.md.

### #18 — Dataset, destination calendar and location ✅
Sign-in creates the owner, membership, dataset and first destination calendar in
one transaction. `ensureGoogleCalendar` creates the dedicated calendar and is
idempotent, verifying an existing one rather than creating a second; if the user
deleted it in Google, the connection is cleared and the events recreated.

A location is stored with its IANA zone, kept separate from the calendar's own
zone, and is not acted on until confirmed.

**Done:** one location per destination (enforced by a unique constraint), and an
unconfirmed one blocks the whole plan with `location_not_confirmed`.

### #19 — Source record CRUD ✅ *(partially exposed)*
Create, pause, resume and soft-delete are implemented and tested. The engine's
`needs_user_decision` refusal is carried through as a typed error rather than
resolved by a default.

**Remaining:** edit and duplicate are not in the dashboard yet, and the
`needs_user_decision` response does not yet render as a choice the user can
resolve — it currently surfaces as an explanatory error.

### #20 — Persist generated occurrences ✅
`upsertOccurrences` writes on the natural key `(source_record_id, hebrew_year,
sequence)`, storing `occurrence_key`, `rule_applied`, `ambiguities` and
`calculation_version`. `horizon_through_hebrew_year` is maintained.

**Done:** re-saving an unchanged record updates in place and the sync issues no
Google calls at all — the content-hash comparison happens before any network
access.

### #21 — Google Calendar adapter ✅
`packages/google-client` over `fetch`. Insert/patch/delete with deterministic
IDs, `transparency: transparent`, per-event reminder overrides, and provenance
in private extended properties. A 409 on insert means "exists", never an error.

**Done:** 114 tests cover create, update, delete, 409 duplicate, 403 revoked,
403 rate-limited, 404 deleted calendar, 429, 500 and network failure.

### #22 — Nearest-first synchronisation ✅
Two Hebrew years synchronously, the remaining eighteen queued. Nearest-first
ordering and the `maxWrites` budget are preserved; `hasMoreWork` requeues in
seconds rather than with backoff.

**Done:** a truncated pass provably keeps the earliest dates, asserted against
the full ordered list.

### #23 — Reminders ✅
Defaults per PRD 18.1–18.3, seeded per destination calendar as data. A
per-record override replaces the calendar default entirely.

### #24 — Dashboard ✅
Connect Google, search for and confirm a location, create the calendar, add a
date by Hebrew or English date, answer the sunset question when there is one,
see upcoming occurrences with a legible sync status, edit, pause, delete, see
recent background work, disconnect.

**Remaining:** flagged occurrences are counted but their explanations are not
rendered beside them; no horizon progress bar.

### #25 — Authorisation boundary test suite ✅
`packages/db/test/integration/tenancy.test.ts` attempts every dataset-scoped
read and write as tenant B using tenant A's real IDs, plus the same at the
service layer. Every attempt fails, and fails as "Not found" rather than
"Forbidden", since distinguishing the two is itself a disclosure.

### Deliberately out of scope for this phase

Per the Phase 2 brief: famous yahrzeits, Apple/iCalendar subscription
management, the Hebrew UI, and polished family management. The schema and the
engine support all four; none is exposed.

---

## Phase 2.5 — Ready for a real private deployment ✅ delivered

Not in the original plan. Five things stood between the built application and
actually using it, and none of them was a feature. See `docs/DECISIONS.md` §6
for the reasoning; briefly:

### #24a — The sunset question ✅
"I'm not sure whether it was before or after sunset" no longer surfaces as an
error. The user gets both candidate Hebrew dates, the calculated local sunset at
their confirmed location, why it matters, and where to find out — and must
choose before anything is generated. The refusal to guess moved from a thrown
error into a CHECK constraint, so it now survives code written later.

### #24b — Edit and delete ✅
Editing regenerates and reconciles, patching existing Google events rather than
recreating them, so hand-added reminders survive and nobody is re-notified about
twenty years at once. Deleting states how many future events go and how many
past ones stay, from the same counts it then acts on, and preserves the past per
the existing policy.

### #24c — Real location search ✅
Nominatim, with the 22-city catalogue kept as an offline fallback and for its
elevation data. The user confirms a resolved place before it becomes a
calculation location, the IANA zone is derived server-side from the confirmed
coordinates, and a time zone alone is still never a calculation location.

### #24d — Rate limiting on `/auth/google/start` ✅
Fixed window in Postgres, not in memory, because Vercel runs many instances.
Sign-in, callback and place search are all limited.

### #24e — A typed audit API ✅
`recordAudit(db, { details: Record<string, unknown> })` is gone. A closed union
of fifteen event shapes, a per-action key allow-list, and a value guard against
credential shapes. A future caller cannot accidentally log a name, a
relationship, a pair of coordinates, an OAuth token or a feed secret — the log
takes no free-form object at all.

### Still deferred, on purpose
**Workload Identity Federation.** The KMS service-account key in a Vercel
environment variable is acceptable for a private beta with one operator. WIF
removes the one secret here that cannot be rotated by rotating something else,
and it is a gate before *public* launch, not before personal use.

---

## Phase 3 — Reliability

### #26 — Job runner
`SELECT … FOR UPDATE SKIP LOCKED` over `sync_jobs`, with a scheduled trigger.
Jobs must be idempotent and safe to kill at any point.

### #27 — Reconciler
Compute desired state, diff against `destination_events`, issue the difference,
record the outcome. Runs on schedule, on "Sync now", on source change, on
location change, on reconnect, and after any failed write.

**Done when:** killing the worker mid-run and restarting converges with no
duplicates and no lost events, verified by a test that does exactly that.

### #28 — Rolling 20-year horizon
Select records where `horizon_through_hebrew_year` is within 20 years of the
current Hebrew year; generate and sync the missing years.

### #29 — Retry and backoff
Exponential backoff via `next_attempt_at`. Terminal states for revoked auth,
deleted calendar and permanent validation errors, each with an actionable
user-facing warning.

### #30 — Recalculation on `CALCULATION_VERSION` change
Select stale occurrences, regenerate, requeue only what actually changed hash.
Past occurrences untouched by default.

### #31 — Account deletion
The three PRD 11.3 options, with typed confirmation for the destructive one and
an audit-log entry.

### #32 — 50-year `.ics` export
Generated by the same engine and the same content builder as live sync.

### #33 — Error reporting and monitoring
Allowlist serialiser for report payloads — never names, dates of death or feed
URLs. Structured logs, error tracker, alerts on sync failure rate.

---

## Phase 4 — Apple subscription support

### #34 — Feed tokens
256-bit token, stored only as a hash plus an 8-character prefix for support
lookup. Path-based, never a query string.

### #35 — Dynamic `.ics` feed
Rendered from stored occurrences. `Cache-Control: private, no-store`; served
from a cookieless hostname; token stripped from access logs at the proxy.

### #36 — Rotation and revocation
One click to rotate; the old token stops working immediately.

### #37 — Device matrix
PRD 12.4's list, including how each client handles `VALARM` on a subscription
and how often it refreshes. Document what actually happens; promise nothing else.

---

## Phase 5 — Famous yahrzeits

### #38 — Editorial schema and admin interface
Draft → under review → published → archived. Publication blocked without at
least one source row. Every administrative action audit-logged.

### #39 — Search, subscriptions, confidence display
Alternative spellings and Hebrew names. Disputed and uncertain records show
their explanation before subscription.

### #40 — Correction workflow
An editorial date change updates future occurrences only; past events change
only on an explicit administrative action. Subscribers are notified of material
changes.

---

## Phase 6 — Family and localisation

### #41 — Guided Google sharing, feed sharing warnings
### #42 — Multiple calendar profiles per account
### #43 — Hebrew interface and full RTL
### #44 — Convention profiles (PRD 17.3), including the `sequence` work needed to observe both Adars

---

## Cross-cutting, do not defer

- **Golden-date suite runs on every change to the engine.** Already wired.
- **Halachic review before public beta** (PRD 35.6): Adar birthdays, Adar
  yahrzeits, missing-30th behaviour, and the wording of every warning. Give the
  reviewer `docs/CALCULATION-RULES.md` and the flagged-year output.
- **No PII in analytics or error payloads**, enforced by an allowlist and tested.
  ✅ Done for the audit log, which was the hardest case because it is the one
  table deliberately outside the usual deletion paths: `packages/db/src/audit.ts`
  is a closed union plus an allow-list plus a credential-shape guard, with 28
  tests. The same discipline still needs applying to error reporting when #33
  lands.
- **Workload Identity Federation before public launch.** Not before personal or
  private-beta use; see Phase 2.5.
