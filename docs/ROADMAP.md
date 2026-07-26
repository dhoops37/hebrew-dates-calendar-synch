# Phased plan and issue backlog

Phases follow PRD 37, with the scope changes argued in `PRD-REVIEW.md` §2. Each
phase has an exit criterion that is checkable, not a feeling.

| Phase | Outcome | Exit criterion |
|---|---|---|
| **1. Calculation prototype** ✅ | Tested engine + a UI that previews occurrences | 200+ engine tests green; a user can select a location, enter a date, preview 20 occurrences and switch display modes |
| **2. Google Calendar MVP** | Persisted records, real Google sync | A record created in the UI appears correctly in Google Calendar and survives a re-sync without duplicating |
| **3. Reliability** | Background jobs, reconciliation, deletion, export | Kill the worker mid-sync; the next run converges with no duplicates and no lost events |
| **4. Apple subscription** | Private iCalendar feed | The feed validates against RFC 5545 and renders correctly on the tested device matrix |
| **5. Famous yahrzeits** | Curated library + editorial workflow | No record publishable without a source; a correction propagates to future events only |
| **6. Family and locale** | Sharing, multiple calendars, Hebrew UI | A second family member sees the calendar; the Hebrew interface is usable RTL |

**MVP-complete = Phases 1–3.** Phases 4 and 5 are in the PRD's MVP acceptance
criteria; moving them out is recommendation §2 of the review.

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

---

## Phase 2 — Google Calendar MVP

### #16 — Provision PostgreSQL and apply `0001_init.sql`
**Depends on:** architecture decision D1, D3
Apply the reviewed migration, wire a typed query layer, add a smoke test that
inserts and reads back one profile. Confirm the three CHECK constraints reject
the inputs they are meant to reject — particularly the under-specified yahrzeit.

**Done when:** migrations run in CI against a throwaway database and the
constraint tests pass.

### #17 — Google OAuth with `calendar.app.created`
Authorisation code flow with PKCE, state validation, HTTP-only session cookie.
Refresh tokens envelope-encrypted with a KMS-held key; `encryption_key_id`
stored beside the ciphertext. Nothing token-shaped may reach a log.

**Done when:** connect, disconnect and re-connect all work; a revoked grant
surfaces as `connection_status = 'needs_reauth'` rather than a 500; a log grep
for the token prefix finds nothing.
**Risk:** OAuth verification for calendar scopes takes weeks. Start the review
submission at the beginning of this phase, not the end.

### #18 — Calendar profile and location
Create/select a dedicated "Hebrew Dates" calendar; save a location with its IANA
zone. Show the resolved location before saving (PRD 13.3).

**Done when:** a profile has exactly one location and one destination, and
changing the location offers recalculation.

### #19 — Source record CRUD
Create, edit, pause, resume, delete, duplicate. Conditional validation for the
Hebrew year. The "I am not sure" path blocks generation until resolved.

**Done when:** the engine's `needs_user_decision` responses render as a choice
the user can resolve, and an unresolved record generates nothing.

### #20 — Persist generated occurrences
Call the engine on save, write 20 years, store `occurrence_key`, `content_hash`,
`rule_applied`, `ambiguities` and the location snapshot. Set
`horizon_through_hebrew_year`.

**Done when:** re-saving an unchanged record produces zero row updates.

### #21 — Google Calendar adapter
`packages/google-calendar`: insert/patch/delete with deterministic IDs,
transparency `transparent`, per-event reminder overrides, occurrence and source
IDs in private extended properties. 409 on insert means "exists" — fetch and
compare, never create a second event.

**Done when:** contract tests cover create, update, delete, 409, 403 revoked,
404 deleted calendar and 429 rate-limited.

### #22 — Nearest-first synchronisation
Sync the next two Hebrew years synchronously so the user sees results, queue the
rest. Show horizon progress (PRD 10.2).

**Done when:** a 30-record account completes its first sync without exceeding
Google's per-calendar write rate.

### #23 — Reminders
Defaults per PRD 18.1–18.3, configurable per profile and per record. "At event
start" means calculated sunset in Exact Sunset Mode.

### #24 — Dashboard
Upcoming ten, my dates, calendar status, sync status, years generated. Flagged
occurrences visibly marked with their explanation.

### #25 — Authorisation boundary test suite
Every route, authenticated as user B, with user A's IDs. Nothing returns 200.
**This is a Phase 2 deliverable, not a Phase 3 one** — it is cheapest to write
while there are ten routes rather than forty.

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
