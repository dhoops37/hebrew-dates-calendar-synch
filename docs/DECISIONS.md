# Product decisions

Answers given on 2026-07-26, with what each one changes. "Built" means it is in
the code and tested; "next" means it is specified and scheduled; "later" means
recorded so the schema leaves room for it.

| # | Decision | Status |
|---|---|---|
| 1 | **All PRD features are in scope.** Phases stay as the *delivery order*, not a scope cut. | Roadmap updated |
| 2 | **English-speaking users first.** | Hebrew date rendering stays in the engine; the translated RTL interface moves later in the order |
| 3 | No fixed launch date. | Google OAuth verification still starts early — it is the longest lead time |
| 4 | **A yahrzeit in Adar is observed in *both* Adars of a leap year, by default.** | **Built** |
| 5 | Build the both-Adars machinery now rather than reserving it. | **Built** |
| 6 | Sunset-to-sunset by location is the default; the two-day all-day mode stays configurable. | Already built; no nightfall variant |
| 7 | No burial-date field. Yahrzeit is entered as the date of death. | Dropped from the schema |
| 8 | **Elevation is applied by default.** | **Built** |
| 9 | Gregorian anniversaries: keep the back end able to express them, keep the front end Hebrew-only. | `SourceRecordType` stays open; no UI |
| 10 | No separate daytime event — use reminders. | No change |
| 11 | **Location comes from the calendar's own time zone, or is auto-detected at setup, and is always changeable.** | **Built** (browser zone); calendar zone in Phase 2 |
| 12 | Event visibility is an option; personal calendars are the expected case. | Next: `visibility` on the calendar, default private |
| 13 | Pausing a record **hides** future events by default. | Next: schema default |
| 14 | No halachic reviewer yet; several rabbis to approach. | `CALCULATION-RULES.md` is the review packet |
| 15 | **Narrow OAuth scope agreed: `calendar.app.created`.** The app can only touch calendars it created itself. | Decided; Phase 2 implements it |
| 16 | **One editor** for the famous-yahrzeit library. | Editorial workflow simplifies: no second-reviewer gate |
| 17 | **Free, with donations.** Possible later tier: Torah from the tzaddik whose yahrzeit it is. | No paywall in the schema; `famous_people` gains a content relation later |
| 18 | **One family dataset feeding several members' own calendars.** | **Built** — see §2 |
| 19 | A paid synagogue/organisation tier is plausible. | **Built**: `owners.kind` is individual / household / organisation from day one |

---

## 1. What #4, #5, #8 and #11 changed in the code

### Both Adars (#4, #5)

`CalculationConventions.adarOrdinaryYahrzeitInLeapYear` now accepts
`'both' | 'adar_i' | 'adar_ii'`, and **`both` is the default**. When a yahrzeit
in Adar of an ordinary year falls in a leap year, the engine emits **two**
occurrences:

```
5787 seq 0   10 Adar I    2027-02-17   ADAR_ORDINARY_TO_ADAR_I
5787 seq 1   10 Adar II   2027-03-19   ADAR_ORDINARY_TO_ADAR_II
5788 seq 0   10 Adar      2028-03-08   SAME_MONTH_AND_DAY
```

Consequences, all handled:

- **`count` now means Hebrew *years*, not occurrences.** A twenty-year horizon on
  an Adar yahrzeit is 20 years and ~27 events. `hebrewYearsGenerated` is reported
  separately, and it is the number the dashboard shows and the rolling-horizon
  job checks.
- **`sequence` is load-bearing.** Adar I is always 0 and Adar II always 1, and
  the occurrence key hashes it, so the pair gets stable, distinct identifiers and
  distinct Google event IDs. Changing that ordering later would re-key live
  calendar events, so there is a test pinning it.
- **The two are distinguishable in the calendar**: titles read "10 Adar I" and
  "10 Adar II" because the title carries the resolved Hebrew date.
- **Birthdays are not doubled** — only yahrzeits. The standard rule for an Adar
  birthday (Adar II) is far less contested. Say the word if you want both there
  too; it is a one-line change plus tests.
- Switching a record to a single Adar removes the extra event cleanly, because
  the reconciler deletes destination events with no matching occurrence.

### Elevation on (#8)

`useElevation: true` is now set **explicitly on every seed location** rather than
defaulted in code, so what was applied is always visible in the calculation
snapshot. Jerusalem's sunset is now 19:52 rather than 19:47 on 20 June 2024.

Worth raising with your rabbis: whether to apply elevation to *shkia* is a real
question, and this default differs from hebcal.com, which publishes sea-level
times. The tests that compare against published tables now pin sea level
explicitly, so both behaviours stay covered. Flipping it is one data change plus
a recalculation job.

### Location auto-detection (#11)

The prototype pre-selects a location from the browser's IANA time zone and says
so, with the resolved place name visible and changeable. `suggestLocationForTimezone`
falls back to the same region rather than guessing wildly, and returns nothing
rather than a wrong answer.

Your preferred source — the destination calendar's own zone — is better and
arrives in Phase 2: Google's `calendars.get` returns `timeZone`, so once an
account is connected that value takes precedence over the browser. Note that a
time zone is not a location: `America/New_York` spans enough longitude for sunset
to differ by roughly half an hour, so this can only ever be a *suggestion* with
a visible, changeable result. It never silently decides.

---

## 2. The family dataset (#18, #19) — built

One family dataset now populates several members' individual calendars, each of
which may be in a different city.

**The problem it fixed.** An occurrence used to store its own sunset times and
location snapshot, because there was exactly one location per calendar. Two
members in two cities need two different sunset windows for what is still *one*
anniversary.

**The fix: split what is location-independent from what is not.**

| Layer | Holds | Depends on location? |
|---|---|---|
| `source_records` | what the user entered | no |
| `generated_occurrences` | Hebrew date, Gregorian date, rule applied, ambiguities | **no** |
| `destination_calendars` | one member's calendar: destination, location, display mode, reminders | — |
| `destination_events` | start/end instants, title, description, content hash, external event ID | **yes** |

Sunset times moved from the occurrence to the destination event. A family of four
in four cities has one set of occurrences and four sets of events, and the
Hebrew-date reasoning happens exactly once.

This also answers #19: `owners.kind` is `individual | household | organisation`
from day one, and membership is a join table, so a synagogue is just a dataset
whose owner is an organisation. No migration needed later.

**The engine API:**

```ts
// location-free: Hebrew dates, Gregorian days, rules, ambiguities
resolveOccurrences({ sourceRecordId, type, origin, count, from })
  → HebrewOccurrence[]

// per destination: sunset window, title, description, content hash, event ID
renderForDestination(occurrence, record, destinationCalendar) → DestinationEvent
renderForDestinations(occurrences, record, destinations)      → Map<id, DestinationEvent[]>

// the single-calendar case, composed from the two above
generateOccurrences({ ... })  → DestinationEvent[]
```

No rules changed: `resolveAnniversary` was already location-independent and
`sunsetOn` was already separate. `generateOccurrences` is now a thin composition
of the two rather than a third implementation, and a test asserts the two paths
produce byte-identical output.

**What is now guaranteed by tests** (`test/destinations.test.ts`, 21 tests):

- occurrences carry no times, no time zone and no location at all;
- three siblings in Jerusalem, New York and Melbourne get the **same** Hebrew
  dates and the **same** occurrence keys;
- with **different** sunset windows, different external event IDs and different
  content hashes, so each calendar reconciles independently;
- each member keeps their own display mode, language and visibility;
- a member above the Arctic Circle gets a no-sunset warning while the others get
  exact times — same Hebrew date, same key;
- an ambiguity (such as both Adars) reaches every member, because it is a
  property of the date rather than of the place.

**And by the database** (`db/tests/constraints.sql`, verified against
PostgreSQL 16): one occurrence legitimately has two destination events in two
zones, while a second event for the same occurrence in the *same* member's
calendar is rejected, as is any two rows pointing at one external event.

---

## 3. Question 15, restated plainly

Google offers several permission levels for Calendar. Two matter here:

- **`calendar`** — read and write **every** calendar in the account. The consent
  screen says roughly *"Hebrew Dates wants to see, edit, share and permanently
  delete all the calendars you can access."* That wording costs installs, and it
  is more power than this app needs.
- **`calendar.app.created`** — read and write **only calendars this app itself
  created**. The app can create a "Hebrew Dates" calendar and manage it fully,
  and it cannot touch the user's work calendar even by accident.

My recommendation is `calendar.app.created`, because it exactly matches the
PRD's recommended default of a dedicated calendar (8.3), and it is a much easier
consent screen for a product handling dates of death.

**The trade-off:** the PRD also allows "use an existing calendar instead" (8.3).
That is impossible under the narrow scope — writing to a calendar the app did not
create requires the broad `calendar` scope.

So the choice is:

1. **Dedicated calendar only** (recommended). Narrow scope, gentle consent
   screen, no ability to damage anything else. The user can still share that
   calendar with family, and it still shows up in Apple Calendar via their Google
   account.
2. **Also allow existing calendars.** Requires the broad scope for everyone, or a
   second consent step that most users never take.

Nothing is blocked on this until Phase 2 begins the OAuth work, but it does need
deciding before the Google verification submission, since the requested scopes
are part of that review.
