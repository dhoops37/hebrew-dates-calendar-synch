# Architecture

## The one-paragraph version

A Next.js application over PostgreSQL, with the Hebrew-date and sunset
calculations extracted into a dependency-free TypeScript package that knows
nothing about HTTP, React, the database or calendar providers. The database is
the source of truth; Google Calendar and any iCalendar feed are *destinations*
that a reconciler drives towards a desired state computed by the engine. Every
future occurrence is materialised as its own row with its own deterministic
identifier, because a Hebrew date is not a Gregorian recurrence rule.

---

## Decisions that need sign-off before Phase 2

These are called out separately because they are expensive to reverse. Nothing
in Phase 1 depends on them. D4 is now **decided**; the rest still await sign-off.

| # | Decision | Recommendation | Why, and what it costs to change later |
|---|---|---|---|
| D1 | **Runtime and hosting** | Next.js 15 (App Router) on Vercel, PostgreSQL on a managed host (Supabase or Neon) | The PRD recommends Next.js and the workload is request/response plus a small amount of background work. Reversible: the engine and the sync layer are plain TypeScript. |
| D2 | **Background jobs** | Start with **Postgres-backed jobs** (`sync_jobs` table + `SELECT … FOR UPDATE SKIP LOCKED`) driven by a scheduled invocation. Add a dedicated queue only if throughput demands it. | Avoids running Redis for a workload measured in thousands of writes a day. The `SyncJob` table is in the PRD already. Moving to a real queue later is a worker-side change; the table stays as the audit log. |
| D3 | **ORM / migrations** | Plain SQL migrations, applied in order, with a thin typed query layer (`postgres.js` or Kysely). | The schema has strong constraints (partial unique indexes, generated columns, check constraints) that ORMs express poorly, and the migration plan is a deliverable in its own right. Prisma is the alternative if the team prefers it; it would change `db/` only. |
| D4 | **Auth** | ✅ **Decided:** Google OAuth handled directly with the narrow `calendar.app.created` scope, plus email magic link for feed-only accounts. | Auth libraries make token *storage* opaque, and encrypted refresh tokens with rotation is precisely the part that must not be opaque. The narrow scope means the app can only touch calendars it created, which matches the dedicated-calendar default and is a far gentler consent screen. Consequence: "use an existing calendar" is not offered. |
| D5 | **Geocoding** | `LocationProvider` interface (already in the engine); start with the built-in catalogue, add a provider when city coverage demands it. | Deferring the vendor choice costs nothing because the seam exists. |
| D6 | **Test strategy for Google** | Contract tests against a recorded fixture set plus one live smoke account. No live API in CI. | Live-API CI is flaky and burns quota. |

---

## Package layout

```
packages/engine/           @hebrew-dates/engine           pure calculation, no I/O
packages/sync/             @hebrew-dates/sync             reconciliation planning, pure
packages/google-calendar/  @hebrew-dates/google-calendar  Google event payloads, pure
packages/ical/             @hebrew-dates/ical             RFC 5545 rendering, no I/O
apps/web/                  @hebrew-dates/web              Next.js UI + API routes
db/migrations/             plain SQL, applied in order
db/tests/                  constraint verification for the migrations
docs/                      this file and its siblings
```

Note what all four packages have in common: **no network, no database, no
credentials.** The riskiest logic in the product — the anniversary rules, the
reconciliation decision table, and the exact shape of what gets written to
someone's calendar — is all pure, so it is tested exhaustively in about two
seconds. What remains for Phase 2 is an executor: something that takes a plan and
a payload and performs HTTP.

### The two layers inside the engine

```
source record
  │  resolveOccurrences()          location-free
  ▼
HebrewOccurrence[]                 Hebrew date, Gregorian day, rule, ambiguities
  │  renderForDestination()        per member's calendar
  ▼
DestinationEvent[]                 sunset window, title, hash, external event ID
```

One family dataset, several members' calendars in different cities: the Hebrew
dates are resolved once and shared; only the times differ. `generateOccurrences`
composes the two for the common single-calendar case.

Later phases add, without disturbing the above:

```
packages/google-client/     the HTTP executor: OAuth, insert/patch/delete, 409 handling
apps/worker/                background jobs (Phase 3)
```

### Why the engine is a separate package rather than a folder

Three concrete reasons, not tidiness:

1. **It has no dependencies to leak.** Its only runtime dependency is
   `@hebcal/core`. A package boundary makes it impossible for a React import or
   a database call to end up inside a calculation by accident.
2. **It is the thing under test.** 244 tests run against it in ~2 s with no
   database, no network and no server. That speed is what makes a golden-date
   suite worth having.
3. **It is reusable by the worker and the feed generator**, which are separate
   processes that must produce byte-identical output to the web app. Shared
   code is the only way to guarantee that; a shared *hash* over that code's
   output is how we detect it if it ever stops being true.

### The rule the boundary enforces

> No `Date` crosses the engine's public boundary as an input, and no engine
> output depends on the host's time zone.

A JavaScript `Date` is an instant; a calendar day is not. Conflating them is the
single most common source of off-by-one-day calendar bugs, and it is invisible
on a UTC development machine. The engine takes `CivilDate = {year, month, day}`
and returns instants as RFC 3339 strings carrying the location's offset. The
test suite runs under `TZ=America/Los_Angeles` and additionally re-runs key
paths under five host zones.

---

## Data flow

```
                    ┌──────────────────────────────────────────┐
   user input  ───► │  API route  (Next.js, Node runtime)       │
                    │    validate → persist source record       │
                    └───────────────┬──────────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────────┐
                    │  @hebrew-dates/engine                     │
                    │    resolveAnniversary  (rules + warnings) │
                    │    resolveOccurrences  (20 Hebrew years,  │
                    │                         location-free)    │
                    │    renderForDestination (sunset, content,  │
                    │                          hash, event ID)   │
                    └───────────────┬──────────────────────────┘
                                    │  deterministic, pure
                    ┌───────────────▼──────────────────────────┐
                    │  PostgreSQL — the source of truth         │
                    │    source_records / generated_occurrences │
                    │    destination_events (per destination)   │
                    └───────────────┬──────────────────────────┘
                                    │
                 ┌──────────────────┴───────────────────┐
                 ▼                                      ▼
       ┌───────────────────┐                 ┌────────────────────┐
       │ Google adapter    │                 │ iCalendar feed     │
       │ create/update/del │                 │ rendered on read   │
       └───────────────────┘                 └────────────────────┘
```

The engine is called on **both** sides of a change: once to compute the desired
state when something is saved, and again by the reconciler to verify that the
destination matches. Because it is deterministic, "recompute and compare hashes"
is a valid convergence check.

---

## Synchronisation model

Three properties, in priority order.

**1. Idempotent.** Every occurrence has a key derived from
`sha256(source_record_id, hebrew_year, sequence)`. The Google event ID is
derived from that key. A retry after an ambiguous timeout addresses the same
event; a duplicate insert returns 409, which the reconciler treats as "exists,
fetch and compare", not as an error.

**2. Convergent, not event-sourced.** `planSync()` in `@hebrew-dates/sync`
computes the desired set, reads the actual set, and returns the difference as a
list of typed actions. A missed webhook, a crashed worker or a manual edit in
Google all heal on the next run; nothing depends on having observed every
intermediate state.

The decision table, in full:

| Desired | Stored | Result |
|---|---|---|
| yes | absent | **create** (`missing_in_destination`) |
| yes | row, no external ID | **create** (`previous_attempt_incomplete`) |
| yes | hash differs | **update** (`content_changed`) |
| yes | hash matches, `synced` | **noop** (`already_synced`) |
| yes | hash matches, mid-write status | **update** (`previous_attempt_incomplete`) |
| yes | `failed` / `retry_scheduled`, backoff elapsed | **update** (`retry_after_failure`) |
| yes | `failed`, backoff not elapsed | **skip**, non-blocking |
| yes | attempts ≥ limit | **skip**, blocking |
| yes | event already ended | **noop** (`past_event_preserved`) |
| no | row with external ID, future | **delete** (`no_longer_desired`) |
| no | row with external ID, past | **noop** (`past_event_preserved`) |
| no | row never written | **noop** |

Whole-destination blocks are evaluated first, so a blocked calendar yields an
explainable plan with zero writes rather than a half-applied one:

- **unconfirmed calculation location** — a wrong location is a wrong sunset every
  year, and it would look authoritative;
- **revoked or unauthorised connection**, or a **deleted destination calendar**;
- **dedicated calendar not created yet**.

Actions are ordered nearest-first and capped by `maxWrites`, so a large first
sync respects the provider's per-calendar write rate and a truncated pass still
leaves the years the user is about to need. `hasMoreWork` tells the caller to
come back.

**3. Bounded retries.** Exponential backoff for transient failures; immediate
stop plus a user-visible connection warning for revoked authorisation, a deleted
destination calendar, or a permanent validation error. PRD 27's state machine is
implemented as a status column plus `attempt_count` and `next_attempt_at`.

### What is deliberately *not* used

- **No `RRULE`.** A Hebrew anniversary drifts 11–19 days a year against the
  Gregorian calendar and lands on a different date each time. Any recurrence
  rule would be wrong within a year. This is the product's whole reason to
  exist, and there is a test asserting the Gregorian dates are not repeatable.
- **No reliance on Google as storage.** Events carry the occurrence ID in
  private extended properties for forensics, but the database is authoritative.
- **No bidirectional sync.** Edits happen in Hebrew Dates. A destination edit is
  overwritten on the next reconcile, which is what PRD 19.1 specifies.

---

## Where each PRD concern lives

| Concern | Home | Notes |
|---|---|---|
| Hebrew calendar rules | `engine/anniversary.ts` | Named rules, warnings, refusals |
| Sunset, time zones, polar cases | `engine/sunset.ts` | NOAA via `@hebcal/noaa` |
| Titles and descriptions | `engine/eventContent.ts` | In the engine because the content hash covers it |
| Stable IDs and hashing | `engine/ids.ts` | Shared by every destination |
| Occurrence generation | `engine/occurrences.ts` | The only place both modes are computed |
| Validation of user input | API route + engine | Engine throws `InvalidOriginError` for impossible dates |
| OAuth tokens | `db` + KMS envelope encryption | Never in the engine, never logged |
| Rate limiting and retries | worker (Phase 3) | Engine has no concept of failure |

---

## Prototype-stage simplifications (deliberate, and their exit criteria)

| Simplification | Exit criterion |
|---|---|
| Location catalogue is a hard-coded list in the engine | Replaced by a `LocationProvider` backed by a geocoder when city coverage is inadequate (Phase 2) |
| No database; the preview API is stateless | Phase 2, first thing |
| Engine imports are extensionless and resolved by the bundler | If the worker needs to run the engine under plain Node ESM, add a `tsup`/`tsc` build step |
| Hand-written CSS, no component library | When the UI grows past the prototype screens |
| No auth | Phase 2 |
