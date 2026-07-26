# PRD review — Hebrew Dates v1.0

A critical read of the PRD before production code. Findings are ordered by how
expensive they are to fix later. Everything marked **BLOCKING** changes a data
model or a user-facing promise; everything marked **ADJUST** is a scoping or
sequencing recommendation.

Several findings were confirmed empirically against `@hebcal/core` 6.8.2 rather
than argued from first principles; those are marked **verified**.

---

## 1. Contradictions and gaps in the calculation requirements

### 1.1 BLOCKING — "Original Hebrew year" cannot be optional for every record

*PRD 15.1, 15.2 and 24 make `original_hebrew_year` optional. PRD 17 requires
correct handling of "dates entered without an original year".*

Two of the standard yahrzeit rules depend on the **character of the Hebrew year
immediately after the death**, not on the date of death alone (*Calendrical
Calculations* p. 113, which is what `@hebcal` implements — **verified** by
reading `@hebcal/hdate/anniversary.js`):

> If the date of death is Marcheshvan 30, the anniversary in general depends on
> the first anniversary; if that first anniversary was not Marcheshvan 30, use
> the day before Kislev 1. […] the same for Kislev 30.

So "30 Cheshvan, year unknown" has **two legitimate observance patterns** and no
default that is defensible. The same date of death produces different yahrzeits
depending on the year of death.

**Recommendation.** Make the Hebrew year *conditionally required*:

| Record | Hebrew year | Rationale |
|---|---|---|
| Birthday, any month | optional | No birthday rule reads the origin year, only its leap-ness |
| Yahrzeit, 30 Cheshvan or 30 Kislev | **required** | Rule depends on the following year |
| Yahrzeit, other months | optional | Rules read only the month and day |

The engine implements this: `resolveAnniversary` returns
`needs_user_decision / YAHRZEIT_30TH_REQUIRES_ORIGIN_YEAR` rather than guessing,
consistent with the PRD's own "never silently choose" principle, which the PRD
currently applies only to the sunset question.

### 1.2 BLOCKING — "Adar" is three different user intents, not one month

*PRD 16.1 correctly requires Adar / Adar I / Adar II to be selectable when the
year is omitted, but the data model (PRD 24) stores a single `hebrew_month`.*

Internally, month 12 is Adar in an ordinary year and Adar I in a leap year. The
rules branch on **whether the origin year was a leap year**, which a bare month
number cannot express. Storing `hebrew_month = 12` loses the distinction between
"born in Adar" and "born in Adar I", which resolve differently in leap years.

**Recommendation.** Store the month as a *name* (`ADAR`, `ADAR_I`, `ADAR_II`,
…), not a number, or store the number plus an explicit
`origin_year_is_leap` flag. The schema in `docs/DATA-MODEL.md` uses the name.

### 1.3 BLOCKING — The PRD does not mention that birthday and yahrzeit rules disagree

The standard rules are deliberately asymmetric, and both asymmetries are live
halachic disputes (**verified** against `@hebcal`):

| Origin | Birthday in a leap year | Yahrzeit in a leap year |
|---|---|---|
| 10 Adar (ordinary year) | 10 **Adar II** | 10 **Adar I** |
| 30 Adar I (leap year), ordinary target year | **1 Nisan** | **30 Shevat** |

A user who enters the same Hebrew date for a parent's birthday and yahrzeit will
see two different Gregorian dates. This is correct, and it will generate support
tickets unless it is explained in place.

**Recommendation.** Treat these as first-class "ambiguous case" warnings under
PRD 17.2 rather than silent behaviour, and put the alternative date in the
warning so the override in PRD 17.1.4 is one click. Implemented: every occurrence
carries `ambiguities[]` with `applied`, `alternative` and an explanation.

### 1.4 ADJUST — The unique constraint forbids a custom the PRD anticipates

*PRD 24 specifies `UNIQUE (source_record_id, hebrew_year)` on
`GeneratedOccurrence`. PRD 17.3 anticipates community convention profiles.*

A common custom observes an Adar yahrzeit in **both** Adars of a leap year. That
is two occurrences in one Hebrew year, which the unique constraint forbids. If
this is ever supported, every stored occurrence and every destination event ID
has to be re-keyed.

**Recommendation (cheap now, expensive later).** Add a `sequence SMALLINT NOT
NULL DEFAULT 0` to the key and the identifier derivation today, while leaving
the MVP behaviour at exactly one occurrence per year. The engine already hashes
`sequence` into `occurrenceKey`; the migration includes the column.

### 1.5 BLOCKING — Nothing in the PRD covers latitudes where the sun does not set

**Verified**: at Tromsø (69.6 °N) `Zmanim.sunset()` returns an **Invalid Date**
in midsummer *and* midwinter. Unhandled, that reaches the calendar as
`"Invalid Date"` or throws during serialisation.

**Recommendation.** Detect and classify it (`midnight_sun` / `polar_night`),
refuse to emit a timed event, and steer the user to Two-Day All-Day Mode or a
different calculation location. Implemented; a real halachic convention for
polar latitudes is out of scope for the MVP and should be an explicit non-goal.

### 1.6 ADJUST — Elevation is listed as optional but changes the answer

**Verified**: Jerusalem sunset on 2024-06-20 is 19:47:38 at sea level and
19:52:28 at 754 m — nearly five minutes.

**Recommendation.** Store elevation always, but make *applying* it an explicit
boolean that is part of the calculation snapshot, defaulted to `false`
(sea level), which is what published calendars normally show. Otherwise a later
change to the default silently moves everyone's events. Implemented as
`use_elevation`.

### 1.7 ADJUST — Sunset evidence for old dates is weaker than the UI will imply

For a 1930s birth, the IANA database's historical rules are good but not
perfect, and the *reported* birth time may be in local mean time or an
unrecorded wartime offset. Showing "sunset was 7:42 PM" next to a 1936 date
implies a precision that does not exist.

**Recommendation.** Show the sunset time as *guidance* with a caveat for dates
before ~1950, and keep relying on the user's before/after answer.

---

## 2. Unnecessary MVP complexity

The PRD's own MVP goal list (6.1) and acceptance criteria (36) contain 30 items
covering six subsystems. Several can move without weakening the core promise.

| PRD item | Recommendation | Why |
|---|---|---|
| Famous-yahrzeit library (21), admin interface (33) | **Defer to Phase 5** — already the PRD's own phasing, but it is in the MVP acceptance criteria (36.21-36.23). Remove it from MVP-complete. | An editorial pipeline with sourcing, confidence levels and a review workflow is a second product. It shares almost no code with personal dates. |
| Hebrew UI + full RTL (29) | Keep Hebrew **date rendering** in the MVP; defer the fully translated RTL interface to Phase 5. | Date rendering is where Hebrew actually matters and it is engine-side. A translated UI is a large surface that will churn while the product is still changing. |
| Two destination types at MVP (12.1, 12.2) | Ship Google first; the iCalendar feed is Phase 4 per the PRD's own phasing. Remove 36.3 and 36.25 from MVP-complete. | A private feed brings token rotation, leak handling, cache-control tuning and client-specific refresh behaviour. |
| 50-year `.ics` export (8.5) | Keep, it is cheap — but generate it from the same engine, not a second code path. | It is the shutdown mitigation, and it is ~50 lines once occurrences exist. |
| Analytics (32), error reporting (34) | Keep event names, defer the dashboards. | Instrumentation is cheap; analysis infrastructure is not. |
| Multiple calendar profiles per user | Model it (the FK exists), but expose one profile in the UI. | The schema cost is zero now and high later. |

**Net effect:** MVP becomes *Google Calendar + personal birthdays and yahrzeits,
correct and idempotent*, which is exactly the PRD's stated principle 5.3
("accuracy before breadth").

---

## 3. Security and privacy risks

| # | Risk | PRD status | Recommendation |
|---|---|---|---|
| S1 | **Private feed URL is a bearer credential.** Anyone with the link reads the whole family's dates of death and approximate home location. Calendar clients put it in plaintext config, sync it to backups, and it appears in server logs by default. | Partly covered (30: hash tokens, allow rotation, warn the user) | Also: serve feeds from a **separate hostname** with no cookies; strip the token from all access logs at the proxy, not in application code; set `Cache-Control: private, no-store`; rate-limit per token; expire tokens that have not been fetched in N months. Never put the token in a query string — path only. |
| S2 | **OAuth scope creep.** `calendar` (full) rather than `calendar.app.created` gives the app read/write over every calendar the user owns, and that is what a reviewer will see. | 11.1 says "minimum practical" | Use `https://www.googleapis.com/auth/calendar.app.created`, which restricts the app to calendars it created. It is compatible with the dedicated-calendar default (8.3). "Select an existing calendar" then requires the broader scope — make that an explicit, separately-consented upgrade, not the default path. |
| S3 | **Refresh tokens are long-lived credentials to a user's calendar.** | 11.1 says "encrypted at rest" | Specify *how*: envelope encryption with a KMS-held key, per-record data key, key ID stored alongside the ciphertext so rotation is possible. "Encrypted at rest" satisfied by full-disk encryption alone is not meaningful here. |
| S4 | **The famous-yahrzeit admin interface is an authenticated write path into content that reaches every subscriber's calendar.** | 33 lists the features, 30 requires access logging | Put it behind a separate role, require a second reviewer for `published` transitions, and never let an editorial change rewrite past events (21.6 says this — enforce it in the sync layer, not by convention). |
| S5 | **Cross-tenant leakage is the highest-impact bug class here** — one user seeing another's dates of death. | 30 requires "test authorization boundaries" | Enforce ownership at the query layer (every query filtered by `calendar_profile_id` resolved from the session), and add an automated test that iterates every API route with a second user's IDs. Consider Postgres RLS as a second line of defence. |
| S6 | **PII in error reports and analytics.** Names, relationships and dates of death must never reach a third-party error tracker. | 32 and 34 say the right thing | Enforce with an allowlist serialiser, not a denylist scrubber, and test it. |
| S7 | **Account deletion has three different meanings** (11.3) and one of them deletes an entire Google calendar. | Covered | Require typed confirmation for the destructive option, and log the choice. This is irreversible from the user's side. |

---

## 4. Technical assumptions worth reconsidering

### 4.1 "Google Calendar's API supports deterministic event IDs" — true, with constraints (**verified** against the documented format)

Event IDs must be base32hex (`[a-v0-9]`), 5–1024 characters, and unique
**per calendar including deleted events**. The last part matters: if a user
deletes an event and the app recreates it with the same ID, the insert fails.
The reconciliation loop must treat "409 on insert" as "fetch and update", not as
a fatal error. Implemented in `googleEventId()`; the sync layer is Phase 2.

### 4.2 The 20-year horizon is a synchronisation cost, not just a storage cost

20 years × N records × 1 event each, written through a rate-limited API. For a
user with 30 records that is 600 events on first sync. Google's per-calendar
write throughput is the binding constraint, not the daily quota.

**Recommendation.** Generate all 20 years in the database immediately (cheap,
gives the durability the PRD wants), but sync to Google **nearest-first**: the
next 2 years synchronously so the user sees results, then the remainder on a
queue. Show the horizon as a progress state, which PRD 10.2 already asks for.

### 4.3 The rolling-horizon job is a per-source-record concern, not per-calendar

PRD 19.3 says the job finds "calendars with fewer than 20 complete future Hebrew
years". Records are created at different times, so within one calendar different
records have different horizons.

**Recommendation.** Track `horizon_through_hebrew_year` on the source record and
select on it. Cheap to index, and it makes the job restartable.

### 4.4 `@hebcal/core` v6 is ESM-only and reads the *host* time zone

**Verified**: `new Zmanim(gloc, date, …)` reads `date.getFullYear()`,
`.getMonth()`, `.getDate()` — host-local accessors. Passing an instant parsed
from `"2024-06-20T00:00:00Z"` returns **the previous day's sunset** on any server
west of Greenwich. Confirmed: under `TZ=America/Los_Angeles` that call returns
2024-06-**19**'s sunset.

Also **verified**: `getYahrzeitHD(hyear, obj)` *mutates the object passed in* and
returns the same reference.

**Recommendation.** Never let a `Date` cross the engine boundary as an input, and
never share an object with the library. Both are enforced in the engine, and
`test/timezones.test.ts` runs the engine under five host zones to prove it.
Being ESM-only also rules out Jest without configuration work — hence Vitest.

### 4.5 "Two-Day All-Day Mode" has an off-by-one waiting in it

Both RFC 5545 and the Google Calendar API treat an all-day `end.date` as
**exclusive**. A two-day event covering Monday and Tuesday has
`start=Monday, end=Wednesday`. Getting this wrong produces a visibly one-day
event and is easy to miss in review because it looks right in some clients.
The engine returns `allDay.endDateExclusive` with the name doing the work, and
the property is tested.

### 4.6 Transparency and reminders interact badly on subscribed feeds

PRD 18.4 already flags that clients differ. Concretely: `VALARM` on a subscribed
`.ics` is ignored by Google Calendar and honoured inconsistently by Apple. The
PRD's instruction to "test and document actual supported behaviour" is right;
budget a real device matrix in Phase 4 rather than treating it as a detail.

---

## 5. Wording and product-safety notes

- **PRD 5.6 and 17.2 are the most important sentences in the document.** The
  disclaimer should be in the event *description* (28 does this) and next to any
  flagged occurrence in the UI, not only in onboarding.
- The suggested disclaimer text says "Hebrew Dates is applying the selected
  calendar convention". In the MVP the user has not *selected* anything — there
  is one default. Either say "the standard calendar convention", or ship the
  selection. The engine's warning text uses the former.
- PRD 21.4 "Confidence level" values (`Confirmed`, `Widely accepted`,
  `Disputed`, `Uncertain`) are not orthogonal to `dispute_note`. Keep both, but
  define which combinations are publishable.

---

## 6. Summary of recommended PRD changes

1. Make `original_hebrew_year` conditionally required (1.1).
2. Store the Hebrew month by name, not number (1.2).
3. Document and surface the birthday/yahrzeit rule asymmetry (1.3).
4. Add `sequence` to the occurrence key now (1.4).
5. Add a "no sunset at this latitude" requirement (1.5).
6. Make elevation use an explicit, stored flag (1.6).
7. Move famous yahrzeits, the iCalendar feed and the translated Hebrew UI out of
   the MVP acceptance criteria (2).
8. Specify `calendar.app.created` scope and envelope encryption (S2, S3).
9. Serve calendar feeds from a cookieless host with token-stripped logs (S1).
10. Sync nearest-years-first; track the horizon per source record (4.2, 4.3).
