# Hebrew Dates

Enter a Hebrew date once and keep seeing it on the correct Gregorian date every
year — in the calendar you already use.

**Status: Phase 2 — Google Calendar sync works end to end.** Sign in with
Google, confirm your location, add a Hebrew date, and a dedicated "Hebrew Dates"
calendar is created in your Google account with real sunset-to-sunset events in
it. Free, and a gift to Klal Yisrael.

The calculation engine came first and is unchanged: the instruction was to get
the calculations right before writing to anyone's calendar, and that is still
the order the codebase is built in.

Not yet wired up: famous yahrzeits, the Apple/iCalendar subscription feed, the
Hebrew interface, and family sharing. The schema and the engine support all
four.

---

## Quick start

```bash
pnpm install
pnpm test        # 803 tests; database suites skip without TEST_DATABASE_URL
pnpm dev         # http://localhost:3000
```

The calculator works with no configuration at all. For calendar syncing you
need a database, a Google OAuth client and an encryption key — see
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), which lists every console step.

```bash
cp apps/web/.env.example apps/web/.env.local   # fill it in
pnpm db:migrate                                 # apply the schema
pnpm db:status                                  # check what is applied
```

Without signing in, the calculator lets you:

- pick a calculation location (coordinates + IANA time zone),
- enter a Hebrew birthday or yahrzeit, or a Gregorian date plus a
  before/after-sunset answer,
- preview the next 20 Gregorian occurrences,
- see the exact sunset-to-sunset start and end times,
- switch to the two-day all-day display, and
- **download 50 years as an `.ics` file and import it into a real calendar** —
  no account, no OAuth, no database.

The `.ics` route is the fastest way to check the output against your own
calendar and your own knowledge:

```bash
curl -o david.ics 'http://localhost:3000/api/export.ics?locationId=seed:jerusalem\
&type=birthday&displayName=David&entryMode=hebrew&hebrewMonth=NISAN&hebrewDay=10&count=50'
```

Dates where the calendar convention is disputed are flagged rather than decided
silently, and dates that cannot be resolved without more information are
refused rather than guessed.

## Layout

```
pure — no network, no database, no credentials:
  packages/engine/           the calculation domain: Hebrew dates and sunset
  packages/sync/             reconciliation planning: desired vs actual → actions
  packages/google-calendar/  Google Calendar event payloads
  packages/ical/             RFC 5545 rendering (backup export + subscription feed)

one dependency each, and nothing else:
  packages/db/               Kysely over the SQL schema; the SQL is authoritative
  packages/crypto/           envelope encryption for stored tokens, Google Cloud KMS
  packages/google-client/    OAuth + Calendar over fetch, with failure classification

composition:
  packages/service/          the use cases — the only package that knows about all
  apps/web/                  Next.js UI, auth routes, dashboard, cron endpoint

db/migrations/             reviewed SQL, verified against Postgres 16
db/tests/                  constraint checks readable in psql
docs/                      review, decisions, architecture, data model, rules, roadmap
```

The first four packages are pure, so the riskiest logic in the product — the
anniversary rules, the reconciliation decision table, and the exact shape of what
gets written to someone's calendar — is tested exhaustively in about two seconds.

The next three each know about exactly one external thing: `db` knows Postgres
but not Google, `crypto` knows KMS but not what it is protecting, and
`google-client` knows Google but not what a Hebrew date is.

## Documents

| Document | What it covers |
|---|---|
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Product decisions taken, and what each one changed in the code or schema |
| [`docs/PRD-REVIEW.md`](docs/PRD-REVIEW.md) | Contradictions, security risks and scope recommendations, with the empirical findings behind them |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The stack, the sync model, token encryption, and the OAuth scopes |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Every Neon, Google Cloud and Vercel console step, in order |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | Schema, constraints that encode product rules, and the migration plan |
| [`docs/CALCULATION-RULES.md`](docs/CALCULATION-RULES.md) | Every anniversary rule, the two asymmetries, and sunset handling |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases 1–6 broken into issues with exit criteria |

## The engine

```ts
import { generateOccurrences, getSeedLocation } from '@hebrew-dates/engine';

const result = generateOccurrences({
  sourceRecordId: 'record-1',
  type: 'birthday',
  displayName: 'David',
  origin: { month: 'NISAN', day: 10 },      // month named, not numbered
  location: getSeedLocation('seed:jerusalem')!,
  displayMode: 'exact_sunset',
  count: 20,
});

if (result.status === 'needs_user_decision') {
  // The engine will not guess. Ask the question it returned.
} else {
  result.occurrences[0].timing?.startIso; // 2027-04-16T19:08:12+03:00
}
```

Three invariants the engine holds, each with tests:

1. **No `Date` crosses the boundary as an input**, and no output depends on the
   host time zone. Calendar days are `{year, month, day}`; instants are RFC 3339
   strings carrying the location's offset.
2. **Nothing ambiguous is decided silently.** Unknown sunset status and
   under-specified yahrzeits return a decision request; disputed conventions
   return the applied date *and* the alternative.
3. **Output is deterministic.** Same input, same occurrence keys and content
   hashes — which is what makes synchronisation idempotent.
4. **Sunset comes from a place, never from a time zone.** The destination
   calendar's own zone is a display hint; latitude and longitude are the
   calculation. A location suggested from a zone must be confirmed before
   anything is written.

## What the app promises about your Google account

`calendar.app.created` is the only Calendar permission requested. It grants
access **solely to calendars this application created** — so Hebrew Dates cannot
read your other calendars, cannot see your meetings, and cannot modify anything
it did not make. A calendar it did not create is reported to it as 404: it
cannot even be enumerated. A test asserts the broader `calendar`,
`calendar.events` and `calendar.readonly` scopes are never requested.

Events are written `transparency: transparent`, so a yahrzeit never makes you
look busy, and `visibility: default`, so your own calendar sharing settings
decide who sees the details.

Refresh tokens are envelope-encrypted: a fresh AES-256-GCM data key per secret,
wrapped by a Google Cloud KMS key, with the key version stored beside the
ciphertext so rotation never requires reading a token back. Access tokens are
never persisted at all.

## Testing

```bash
pnpm test                                     # skips the database suites

export TEST_DATABASE_URL='postgres://user@localhost:5432/postgres'
pnpm test                                     # all 803
```

The integration suites run against a real PostgreSQL 16 — each file creates and
drops its own throwaway database — because the properties they prove are
Postgres's: CHECK constraints that encode product rules, `FOR UPDATE SKIP
LOCKED`, partial unique indexes, cascade behaviour. A mock would assert that our
beliefs about the schema are self-consistent, which is not the same as true.

Google is a `fetch`-level double that is faithful about the four behaviours the
code depends on: no refresh token without `prompt=consent`, event IDs reserved
forever after deletion, foreign calendars reported 404 rather than 403, and 403
covering both quota and permission.

Coverage includes the golden-date set, leap years, every Adar case, 30 Cheshvan and
30 Kislev, sunset against independently published times for nine locations,
daylight-saving transitions in four zones, host-time-zone independence, polar
latitudes, stable identifiers and content hashing. The iCalendar suite covers
RFC 5545 line folding on octet boundaries (Hebrew is multi-byte), text escaping,
the exclusive all-day end date, alarm durations and UID stability.

The suite runs under `TZ=America/Los_Angeles` deliberately: a UTC-only test run
hides an entire class of date bugs.

## Disclaimer

Hebrew Dates provides standard calendar calculations. It does not issue halachic
rulings. Where customs differ, the affected dates are flagged with an
explanation and an alternative; follow your family custom or consult your rabbi.
