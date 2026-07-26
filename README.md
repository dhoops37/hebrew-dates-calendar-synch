# Hebrew Dates

Enter a Hebrew date once and keep seeing it on the correct Gregorian date every
year — in the calendar you already use.

**Status: Phase 1 — calculation prototype.** The Hebrew-date and sunset engine
is implemented and tested. There is a working preview UI. There is no database,
no authentication and no calendar integration yet, by design: the PRD's
instruction is to get the calculations right before writing to anyone's
calendar.

---

## Quick start

```bash
pnpm install
pnpm test        # 203 engine tests, ~2s
pnpm dev         # http://localhost:3000
```

The prototype lets you:

- pick a calculation location (coordinates + IANA time zone),
- enter a Hebrew birthday or yahrzeit, or a Gregorian date plus a
  before/after-sunset answer,
- preview the next 20 Gregorian occurrences,
- see the exact sunset-to-sunset start and end times, and
- switch to the two-day all-day display.

Dates where the calendar convention is disputed are flagged rather than decided
silently, and dates that cannot be resolved without more information are
refused rather than guessed.

## Layout

```
packages/engine/   the calculation domain — no HTTP, no React, no database
apps/web/          Next.js prototype UI and preview API
db/migrations/     reviewed SQL for Phase 2 (not yet applied)
docs/              review, architecture, data model, calculation rules, roadmap
```

## Documents

| Document | What it covers |
|---|---|
| [`docs/PRD-REVIEW.md`](docs/PRD-REVIEW.md) | Contradictions, security risks and scope recommendations, with the empirical findings behind them |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The stack, the sync model, and the decisions awaiting sign-off before Phase 2 |
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

## Testing

```bash
pnpm test
```

Covers the golden-date set, leap years, every Adar case, 30 Cheshvan and
30 Kislev, sunset against independently published times for nine locations,
daylight-saving transitions in four zones, host-time-zone independence, polar
latitudes, stable identifiers and content hashing.

The suite runs under `TZ=America/Los_Angeles` deliberately: a UTC-only test run
hides an entire class of date bugs.

## Disclaimer

Hebrew Dates provides standard calendar calculations. It does not issue halachic
rulings. Where customs differ, the affected dates are flagged with an
explanation and an alternative; follow your family custom or consult your rabbi.
