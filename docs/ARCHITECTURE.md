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

## Decisions, now all made

All six are decided. Each row records what was chosen and what reversing it
would cost, because that is the part that is easy to forget once something is
working.

| # | Decision | Chosen | Why, and what it costs to change later |
|---|---|---|---|
| D1 | **Runtime and hosting** | ✅ Next.js 15 (App Router) on **Vercel**, PostgreSQL on **Neon** | The workload is request/response plus a small amount of scheduled work. Reversible: the engine and the sync layer are plain TypeScript with no platform coupling, and `packages/service` takes a `ServiceContext` rather than reading globals. |
| D2 | **Background jobs** | ✅ Postgres-backed `sync_jobs` with `FOR UPDATE SKIP LOCKED`, driven by **Vercel Cron** every 15 minutes | No Redis for a workload measured in thousands of writes a day, and `sync_jobs` was already the audit trail. Moving to a real queue later is a worker-side change; the table stays. The claim is deliberately **one statement** (`WITH … UPDATE … RETURNING`), so its row locks live and die inside a single implicit transaction and it is therefore safe on Neon's **pooled** endpoint, which pins a server connection per transaction. Splitting it in two would break that silently. The migration runner is the part that genuinely needs the **direct** endpoint, because its advisory lock is held across statements — `createDb({ requireDirectConnection: true })` asserts it there. |
| D3 | **ORM / migrations** | ✅ Plain SQL migrations with **Kysely** as the typed query layer. No Prisma. | The schema's constraints encode product rules an ORM would reinterpret. `packages/db/src/schema.ts` is a hand-maintained mirror of the SQL, and `schema-parity.test.ts` parses those types with the TypeScript compiler and diffs them against `information_schema` in both directions, so drift fails a test. |
| D4 | **Auth** | ✅ Google OAuth handled directly, `calendar.app.created` only, plus `openid` and `userinfo.email` for identity | Auth libraries make token *storage* opaque, and encrypted refresh tokens with rotation is precisely the part that must not be opaque. Consequence: "use an existing calendar" is not offered, and cannot be — the scope forbids it. |
| D5 | **Geocoding** | ✅ **OpenStreetMap Nominatim** for search, with the 22-location catalogue as an offline fallback, and `tz-lookup` for the IANA zone | No API key and no billing account, which is what made it the one that could ship. Costs of changing: `GeocodingProvider` is a two-method interface and `CompositeGeocoder` already merges two implementations, so a paid provider is an added file, not a rewrite. The catalogue is kept rather than deleted because it carries **elevation** — 754 m at Jerusalem moves sunset by minutes — and because a geocoder outage must not block the location step. The zone is derived from the confirmed coordinates by an offline shapefile lookup, never from the browser and never accepted from the client. |
| D6 | **Test strategy for Google** | ✅ A high-fidelity `fetch`-level double, plus one live smoke account when credentials exist. No live API in CI. | The double is faithful about the four behaviours the code depends on: no refresh token without `prompt=consent`, event IDs reserved forever after deletion, foreign calendars reported 404 not 403, and 403 covering both quota and permission. Live-API CI is flaky and burns quota. |

---

## Token encryption

Application-layer **envelope encryption** with Google Cloud KMS, in the same GCP
project as the Calendar OAuth client.

A fresh 256-bit data key encrypts each secret locally with AES-256-GCM, and only
that 32-byte key is sent to KMS to be wrapped. The refresh token never leaves
the process. That keeps the KMS call small and cheap, and it keeps the blast
radius of a KMS misconfiguration to "tokens cannot be read" rather than "tokens
were disclosed".

**Rotation works without reading any plaintext back.** KMS reports which crypto
key *version* performed an encryption, and that version name is what goes into
`encryption_key_id`. Decryption addresses the crypto *key*, and KMS finds the
right version from the ciphertext — so a record sealed before a rotation stays
readable with no migration, and the stale ones are found with one indexed query:

```sql
SELECT id FROM google_accounts WHERE encryption_key_id <> $current;
```

Re-wrapping happens lazily on the token read path, so rotation completes as
accounts are used, with no batch job and no window where a record is unreadable.

`KMS_KEY_NAME` naming a *version* is refused outright: pinning writes to a
version would make rotating the key a silent no-op.

The AES additional-authenticated-data binds each ciphertext to its own row — a
purpose plus a subject, length-prefixed so the split cannot be shifted. Without
it, a ciphertext lifted from one `google_accounts` row into another would decrypt
cleanly and one user's calendar would be written with another user's token.

`LocalKeyManager` exists so the whole OAuth path can be built and tested before
a KMS key exists. It refuses to construct in production, checking `VERCEL_ENV`
as well as `NODE_ENV` because a Vercel preview also runs with
`NODE_ENV=production`. `resolveKeyManager()` is the only place that chooses
between the two.

---

## Google OAuth scopes and verification

Requested, and nothing else:

| Scope | Why |
|---|---|
| `openid` | identity, so an account can exist |
| `https://www.googleapis.com/auth/userinfo.email` | the account's email address |
| `https://www.googleapis.com/auth/calendar.app.created` | read/write **only** on calendars this application created |

Deliberately **not** requested: `calendar`, `calendar.events`,
`calendar.readonly`, `calendar.calendarlist`, `profile`. A test in
`packages/google-client` asserts the three broad calendar scopes never appear in
an authorization URL.

`calendar.app.created` is what makes the dedicated-calendar design a security
property and not just a convention: the application cannot read the user's other
calendars, cannot see their meetings, and cannot modify anything it did not
make. A calendar it did not create is reported as 404, not 403 — it cannot even
be enumerated.

**Verification.** How Google classifies `calendar.app.created`, and therefore
what verification is required and how long it takes, must be read from the
Google Cloud Console for this specific project. This document deliberately does
not state a classification or a duration: both change, and both are visible in
the Console's OAuth consent screen page under the scope list. The OAuth flow is
built and tested now precisely so that verification is not a blocker to
development — the app works against a test OAuth client with the project in
"Testing" mode and a small list of test users.

---

## Package layout

```
                                                          pure, no I/O:
packages/engine/           @hebrew-dates/engine           Hebrew dates and sunset
packages/sync/             @hebrew-dates/sync             reconciliation planning
packages/google-calendar/  @hebrew-dates/google-calendar  Google event payloads
packages/ical/             @hebrew-dates/ical             RFC 5545 rendering

                                                          one dependency each:
packages/db/               @hebrew-dates/db               Kysely over the SQL schema
packages/crypto/           @hebrew-dates/crypto           envelope encryption + KMS
packages/google-client/    @hebrew-dates/google-client    OAuth + Calendar over fetch

                                                          composition:
packages/service/          @hebrew-dates/service          the use cases
apps/web/                  @hebrew-dates/web              Next.js UI, routes, cron

db/migrations/             plain SQL, applied in order — the authoritative schema
db/tests/                  constraint verification by hand, in psql
docs/                      this file and its siblings
```

The first four packages have **no network, no database, no credentials.** The
riskiest logic in the product — the anniversary rules, the reconciliation
decision table, and the exact shape of what gets written to someone's calendar —
is all pure, so it is tested exhaustively in about two seconds.

The next three each depend on exactly one external thing and nothing else:
`db` knows Postgres but not Google, `crypto` knows KMS but not what it is
protecting, `google-client` knows Google but not what a Hebrew date is.

`packages/service` is the only package that knows about all of them. It takes a
`ServiceContext` — database, key manager, OAuth config, clock, calendar-client
factory — rather than reading module-level globals, which is what lets the whole
flow be tested end to end against a real PostgreSQL and a Google double with no
environment variables at all.

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
| OAuth tokens | `crypto` + `db` | Envelope-encrypted; never in the engine, never logged |
| OAuth and Calendar HTTP | `google-client` | `fetch`-level, with failure classification |
| Composition of all of it | `service` | The only package that knows about every other |
| Rate limiting and retries | `google-client` + `service/sync.ts` | Classification decides *whether*; backoff decides *when* |
| Rate limiting of *our own* endpoints | `db/rate-limit.ts` | One atomic upsert against `rate_limits`. In Postgres, not memory: Vercel runs many instances, so an in-process counter is per-instance and therefore not a limit |
| What may be written to the audit log | `db/audit.ts` | A closed discriminated union plus a per-action key allow-list. The log cannot be reached with a free-form object, so a future caller cannot pass a name or a token through it |
| Refusing to guess a Hebrew date | `engine` **and** the `source_records` CHECK constraint | The engine refuses, and `unresolved_sunset_entry_cannot_be_active` means an unanswered record cannot be active — so the refusal survives a code path written later that forgot about it |

---

## Prototype-stage simplifications (deliberate, and their exit criteria)

| Simplification | Exit criterion |
|---|---|
| ~~Location catalogue is a hard-coded list of 22 cities~~ | ✅ Done: Nominatim search with the catalogue as an offline fallback. What remains is that Nominatim has no SLA — the exit criterion for that is a paid provider behind the same `GeocodingProvider` interface, when usage justifies the bill. |
| ~~No database~~ | ✅ Done: Neon + Kysely, with the SQL authoritative. |
| ~~No auth~~ | ✅ Done: Google OAuth with PKCE, sessions in Postgres. |
| Engine imports are extensionless and resolved by the bundler | If the worker needs to run the engine under plain Node ESM, add a build step. The migration CLI already names its own imports with `.ts` for Node's type stripping. |
| Hand-written CSS, no component library | When the UI grows past the prototype screens. |
| The dashboard is one destination calendar per user | Family management (several members' calendars from one dataset) is designed for in the schema and the engine but not exposed in the UI. |
| Reconciliation compares our rows against the engine, not against a live read of Google | Add a periodic `events.list` sweep filtered on `privateExtendedProperty` to find events the app lost track of. `listAllManagedEvents` exists for it and reports an incomplete page walk, so a truncated list can never drive a delete. |
| Famous yahrzeits, the Apple/iCalendar subscription feed and the Hebrew UI are not wired up | Later phases. The engine and the `ical` package already render them. |
