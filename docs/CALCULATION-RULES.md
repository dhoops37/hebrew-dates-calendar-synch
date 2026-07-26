# Hebrew anniversary and sunset rules

The specification the engine implements, and the reasoning behind each choice.
This is the document a qualified reviewer should read before the halachic review
required by PRD 35.6.

## Source

The anniversary rules are those in Edward M. Reingold and Nachum Dershowitz,
*Calendrical Calculations*, pp. 111 (birthdays) and 113 (yahrzeits). They are
also what `@hebcal` implements, so "standard calculation rules from the chosen
library" (PRD 17.1) and "the R&D rules" name the same thing.

The engine re-implements them rather than delegating, for three reasons:

1. It must handle a record with **no origin Hebrew year**, which `@hebcal`'s
   functions cannot express — they read leap-ness from that year.
2. It must report *which rule fired* and *what the alternative is*, so the UI can
   warn and offer an override (PRD 5.4, 17.1, 17.2).
3. It must be able to **refuse**. Two yahrzeit rules are undecidable without the
   origin year, and guessing would violate the PRD's own principle.

`test/anniversary.test.ts` differential-tests the engine against `@hebcal` across
20 origin years × 20 target years × every month and several days — over 8,000
comparisons. Any divergence on an input both can handle fails the build.

## The year, in brief

A Hebrew year has 12 months, or 13 in a leap year (7 in every 19). Every month
has a fixed length except two:

| Month | Days |
|---|---|
| Tishrei, Shevat, Nisan, Sivan, Av | 30 |
| Tevet, Iyyar, Tamuz, Elul | 29 |
| **Cheshvan** | **29 or 30** |
| **Kislev** | **29 or 30** |
| Adar (ordinary year) | 29 |
| Adar I (leap year only) | 30 |
| Adar II (leap year only) | 29 |

So a year is 353, 354 or 355 days (383, 384 or 385 when leap). Every edge case
below comes from one of exactly three facts: Cheshvan varies, Kislev varies, and
leap years have an extra Adar.

### Why the month is named, not numbered

Internally Adar and Adar I share month number **12**. The rules branch on
whether the *origin* year was a leap year, which a bare 12 cannot express. The
engine's public API therefore takes `ADAR`, `ADAR_I` or `ADAR_II`, and the
user's choice of which to select is exactly the information the rules need. That
is why PRD 16.1's requirement to offer all three when the year is omitted is
load-bearing, not a UI nicety.

## Birthday rules (p. 111)

Applied in order; the first match wins.

| # | Condition | Result | Rule ID |
|---|---|---|---|
| B1 | Born in **Adar** (ordinary year) or **Adar II** | The last month of the target year: Adar in an ordinary year, Adar II in a leap year | `ADAR_ORDINARY_TO_ADAR_II` / `ADAR_TO_LAST_MONTH_OF_YEAR` |
| B2 | Born **30 Cheshvan**, target Cheshvan has 29 days | **1 Kislev** | `CHESHVAN_30_TO_1_KISLEV` |
| B3 | Born **30 Kislev**, target Kislev has 29 days | **1 Tevet** | `KISLEV_30_TO_1_TEVET` |
| B4 | Born **30 Adar I**, target year is ordinary | **1 Nisan** | `ADAR_I_30_TO_1_NISAN` |
| B5 | Otherwise | Same month number and day | `SAME_MONTH_AND_DAY` |

Note what B5 does for someone born in **Adar I** of a leap year: in an ordinary
target year, month 12 *is* Adar, so the birthday falls in Adar with no special
rule. That is intended.

## Yahrzeit rules (p. 113)

| # | Condition | Result | Rule ID |
|---|---|---|---|
| Y1 | Died **30 Cheshvan** and the **first anniversary year** had a 29-day Cheshvan | The last day of Cheshvan in the target year (29th or 30th) | `CHESHVAN_30_TO_LAST_DAY_OF_CHESHVAN` |
| Y2 | Died **30 Kislev** and the **first anniversary year** had a 29-day Kislev | The last day of Kislev in the target year | `KISLEV_30_TO_LAST_DAY_OF_KISLEV` |
| Y3 | Died in **Adar II** | The last month of the target year | `ADAR_TO_LAST_MONTH_OF_YEAR` |
| Y4 | Died **30 Adar I**, target year is ordinary | **30 Shevat** | `ADAR_I_30_TO_30_SHVAT` |
| Y5 | Died in **Adar** (ordinary year), target year is a leap year | **Both Adars** by default (see below) | `ADAR_ORDINARY_TO_ADAR_I` + `ADAR_ORDINARY_TO_ADAR_II` |
| Y6 | Otherwise the same month and day, falling forward off a 30th that does not exist | 1 Kislev / 1 Tevet | `CHESHVAN_30_TO_1_KISLEV` / `KISLEV_30_TO_1_TEVET` |

**Y1 and Y2 are the reason the Hebrew year of death is required for those
records.** They read the character of the year *after* the death, so the same
Hebrew date of death produces different observances depending on the year. With
no year, the engine returns `needs_user_decision` with code
`YAHRZEIT_30TH_REQUIRES_ORIGIN_YEAR`, and the database rejects the record.

## The two asymmetries, and why they are flagged

The birthday and yahrzeit rules deliberately disagree in two places. Both are
live differences in practice, so the engine attaches an `ambiguity` with the
alternative date every time either fires.

| Origin | Target year | Birthday | Yahrzeit |
|---|---|---|---|
| 10 Adar (ordinary year) | leap | 10 **Adar II** | 10 **Adar I** |
| 30 Adar I | ordinary | **1 Nisan** | **30 Shevat** |

For the first: someone who observes a parent's yahrzeit in Adar I and their own
birthday in Adar II is following the standard rules exactly, and it will look
like a bug. The warning text says so, in the words PRD 17.2 asks for.

### The convention knob, and the default

`adarOrdinaryYahrzeitInLeapYear` is stored per source record and accepts:

| Value | Behaviour |
|---|---|
| **`both`** (default) | Two observances: 10 Adar I *and* 10 Adar II |
| `adar_i` | The standard calendrical rule only |
| `adar_ii` | The practice of many communities only |

`both` is the default because it is a widespread custom and because it is the
only option that cannot cause a yahrzeit to be *missed*: the extra observance is
visible, explained, and removable, whereas a wrong single choice is silent.

This is the one case in the engine where a single Hebrew year yields two
occurrences. It is why `sequence` is part of the occurrence key: **Adar I is
always sequence 0 and Adar II always sequence 1**, so each observance has a
stable identifier and its own destination event. Reordering them would re-key
live calendar events, so a test pins it.

It also means `count` is a number of Hebrew **years**, not of occurrences. A
twenty-year horizon on an Adar yahrzeit produces twenty years and roughly
twenty-seven events; `hebrewYearsGenerated` reports the former.

Birthdays are **not** doubled — only yahrzeits. The standard rule for an Adar
birthday (Adar II) is much less contested.

## Sunset

- **Algorithm**: NOAA solar calculator via `@hebcal/noaa`, accurate to about a
  minute between ±72° latitude.
- **Sunset** is the standard refraction-corrected −0.833° solar altitude.
- **Elevation applied by default.** `use_elevation` is set explicitly on each
  saved location rather than defaulted in code, so what was applied is always
  visible in the calculation snapshot. It matters: Jerusalem at 754 m sets about
  five minutes later than the sea-level figure.

  For the halachic review: whether elevation should affect *shkia* is a genuine
  question, and this default differs from hebcal.com, which publishes sea-level
  times. Both behaviours are covered by tests — the comparisons against published
  tables pin sea level explicitly — so flipping the default is one data change
  plus a recalculation job.
- **Time zone.** Results are returned as RFC 3339 strings carrying the
  location's UTC offset, derived from the IANA database for the *historical*
  date in question. A 1978 New York sunset correctly reports `-04:00`.

### Exact Sunset Mode

For a Hebrew date whose daytime falls on Gregorian day *D*:

```
start = sunset at the location on D − 1
end   = sunset at the location on D
```

The absolute length is always ~24 h, including across daylight-saving
transitions — sunset is set by the sun, not the clock. What changes across a DST
boundary is the *displayed local time*, which jumps by an hour. Any
implementation that computes the end as "start + 24 h in local wall-clock time"
is wrong twice a year, so the engine derives both ends independently and the
test suite asserts the property across a full year.

### Two-Day All-Day Mode

One all-day event covering *D − 1* and *D*. The stored end is
**`D + 1`, exclusive**, because RFC 5545 and the Google Calendar API both treat
an all-day end date as exclusive. The field is named `endDateExclusive` so the
off-by-one cannot be introduced silently.

### Where the sun does not set

Above the polar circles `sunset()` is undefined for part of the year. The engine
returns `{status: 'no_sunset', reason: 'midnight_sun' | 'polar_night'}` rather
than an Invalid Date, and the occurrence carries a `NO_SUNSET` warning with no
timing. The application must not write a timed event in that case; the two-day
all-day representation still works. A halachic convention for such latitudes is
out of MVP scope and should be stated as a non-goal.

## Interpreting a Gregorian date

A Hebrew day runs sunset to sunset, so a Gregorian date maps to **two** Hebrew
dates:

| The user says | Hebrew date |
|---|---|
| Before sunset (daytime) | The Hebrew date of that Gregorian day |
| After sunset (evening) | The **following** Hebrew date |
| Not sure | **Both are returned; nothing is generated** |

The third row is the product's most important refusal. The engine returns a
decision request listing both candidates, and — when a location is known — the
actual sunset time on that date as evidence. For dates before roughly 1950,
that evidence should be presented with a caveat: historical IANA data is good
but the reported time of a birth or death may not be in the zone the database
assumes.

## Versioning

`CALCULATION_VERSION` is stamped on every occurrence. It must be bumped when a
rule changes, when a library upgrade moves sunset output, or when instant
derivation changes. A background job then selects occurrences whose version is
not current and requeues them — recalculation is a job, never a migration, so it
is observable, resumable and rate-limited against the destination API.

## Test coverage

| Area | File |
|---|---|
| Golden dates, leap years, year characteristics, round-trips | `test/hebrewCalendar.test.ts` |
| All Adar cases, Cheshvan 30, Kislev 30, refusals, `@hebcal` differential | `test/anniversary.test.ts` |
| Published sunset times, polar cases, elevation, historical DST | `test/sunset.test.ts` |
| DST transitions in four zones, host-zone independence | `test/timezones.test.ts` |
| Before/after/unknown sunset interpretation | `test/gregorianEntry.test.ts` |
| 20-year horizon, both display modes, overrides, determinism | `test/occurrences.test.ts` |
| Stable IDs, Google ID format, content hashing, reconciliation | `test/ids.test.ts` |
| Titles, descriptions, Hebrew rendering | `test/eventContent.test.ts` |
