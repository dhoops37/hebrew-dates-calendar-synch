/**
 * Core domain types for the Hebrew Dates calculation engine.
 *
 * Design rules enforced by these types:
 *
 * 1. No JavaScript `Date` ever crosses the public boundary of the engine as an
 *    *input*. A `Date` is an instant, not a calendar day, and interpreting one
 *    as a calendar day silently depends on the server's local time zone.
 *    Calendar days are `CivilDate`; instants are epoch milliseconds plus an
 *    explicit IANA zone.
 * 2. A Hebrew month is never represented by a bare number at the boundary.
 *    Month 12 means "Adar" in an ordinary year and "Adar I" in a leap year,
 *    and that distinction changes the anniversary rule. Callers name the month.
 * 3. Anything the engine cannot decide without a halachic choice is returned as
 *    a decision request, never guessed.
 */

/** A calendar day with no time and no zone. Month is 1-based. */
export interface CivilDate {
  year: number;
  /** 1 = January */
  month: number;
  day: number;
}

/** Hebrew month numbers as used internally by @hebcal (Nisan = 1). */
export const HEBREW_MONTH_NUMBER = {
  NISAN: 1,
  IYYAR: 2,
  SIVAN: 3,
  TAMUZ: 4,
  AV: 5,
  ELUL: 6,
  TISHREI: 7,
  CHESHVAN: 8,
  KISLEV: 9,
  TEVET: 10,
  SHVAT: 11,
  /** Adar in an ordinary year; Adar I in a leap year. */
  ADAR_I: 12,
  /** Only exists in a leap year. */
  ADAR_II: 13,
} as const;

export type HebrewMonthNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

/**
 * How a user names a Hebrew month. `ADAR`, `ADAR_I` and `ADAR_II` are three
 * distinct user intents even though `ADAR` and `ADAR_I` share month number 12:
 *
 * - `ADAR`    - "Adar" in an ordinary (12-month) year.
 * - `ADAR_I`  - the first Adar of a leap year.
 * - `ADAR_II` - the second Adar of a leap year.
 *
 * The anniversary rules branch on this, which is why the engine requires the
 * user to pick one rather than inferring it.
 */
export type HebrewMonthName =
  | 'NISAN'
  | 'IYYAR'
  | 'SIVAN'
  | 'TAMUZ'
  | 'AV'
  | 'ELUL'
  | 'TISHREI'
  | 'CHESHVAN'
  | 'KISLEV'
  | 'TEVET'
  | 'SHVAT'
  | 'ADAR'
  | 'ADAR_I'
  | 'ADAR_II';

/** A fully determined Hebrew date. */
export interface HebrewDate {
  year: number;
  month: HebrewMonthNumber;
  day: number;
}

/**
 * The Hebrew date a record originates from, as the user described it.
 * `year` is optional for birthdays; see `anniversary.ts` for the cases where a
 * yahrzeit genuinely cannot be resolved without it.
 */
export interface AnniversaryOrigin {
  month: HebrewMonthName;
  /** 1..30 */
  day: number;
  /** Hebrew year of birth / death, when known. */
  year?: number;
}

export type AnniversaryKind = 'birthday' | 'yahrzeit';

export type SourceRecordType = 'birthday' | 'personal_yahrzeit' | 'famous_yahrzeit';

export type DisplayMode = 'exact_sunset' | 'two_day_all_day';

/** Whether a Gregorian-entered event happened before or after that day's sunset. */
export type SunsetStatus = 'before_sunset' | 'after_sunset' | 'unknown';

/**
 * A saved calculation location. Latitude/longitude alone are not enough:
 * rendering a sunset instant as a wall-clock time requires the IANA zone,
 * and the zone cannot be derived reliably from coordinates at run time.
 */
export interface CalculationLocation {
  /** Stable identifier from whichever location provider produced this record. */
  id: string;
  /** Human-readable place name, e.g. "Beit Shemesh, Jerusalem District". */
  displayName: string;
  /** ISO 3166-1 alpha-2. */
  countryCode: string;
  latitude: number;
  longitude: number;
  /** IANA time zone identifier, e.g. "Asia/Jerusalem". */
  timezoneId: string;
  /** Metres above sea level. Recorded even when unused, so results are reproducible. */
  elevationMeters?: number;
  /**
   * Whether elevation was applied to the sunset calculation. Defaults to false
   * (sea-level sunset), which is what published Jewish calendars normally show.
   * Elevation can move sunset by several minutes, so this is part of the
   * calculation snapshot rather than a display preference.
   */
  useElevation?: boolean;
  /** Provider place ID, when the location came from a geocoder. */
  geocoderPlaceId?: string;
}

/** Result of a sunset calculation for one civil day at one location. */
export type SunsetResult =
  | {
      status: 'ok';
      /** RFC 3339 timestamp with the location's UTC offset, e.g. 2024-04-16T19:12:31+03:00 */
      iso: string;
      epochMs: number;
      /** e.g. "+03:00" */
      utcOffset: string;
      timezoneId: string;
    }
  | {
      status: 'no_sunset';
      timezoneId: string;
      /** The sun stays above the horizon all day, or below it all day. */
      reason: 'midnight_sun' | 'polar_night';
    };

/**
 * A halachic or calendrical choice the engine refuses to make silently.
 * Every one of these is surfaced to the user with both candidate dates.
 */
export type AmbiguityCode =
  /** Born/died in Adar of an ordinary year; the target year is a leap year. */
  | 'ADAR_ORDINARY_IN_LEAP_YEAR'
  /** Origin day is the 30th of a month that has only 29 days in the target year. */
  | 'MISSING_30TH_DAY'
  /** Origin is 30 Adar I; the target year is ordinary and has no such day. */
  | 'ADAR_I_30_IN_ORDINARY_YEAR';

export interface Ambiguity {
  code: AmbiguityCode;
  /** The date this engine used, given the selected convention. */
  applied: HebrewDate;
  /** The most commonly cited alternative, offered to the user as an override. */
  alternative?: HebrewDate;
  /** Plain-language explanation, shown next to the affected occurrence. */
  explanation: string;
}

/** Identifies which documented rule produced a resolved date. */
export type RuleId =
  | 'SAME_MONTH_AND_DAY'
  | 'ADAR_TO_LAST_MONTH_OF_YEAR'
  | 'ADAR_ORDINARY_TO_ADAR_I'
  | 'ADAR_ORDINARY_TO_ADAR_II'
  | 'ADAR_I_30_TO_1_NISAN'
  | 'ADAR_I_30_TO_30_SHVAT'
  | 'CHESHVAN_30_TO_1_KISLEV'
  | 'KISLEV_30_TO_1_TEVET'
  | 'CHESHVAN_30_TO_LAST_DAY_OF_CHESHVAN'
  | 'KISLEV_30_TO_LAST_DAY_OF_KISLEV';

/**
 * Named conventions stored per source record. The MVP ships one default set;
 * the shape exists now so that changing a convention later is a data change
 * rather than a schema migration.
 */
export interface CalculationConventions {
  /**
   * A yahrzeit for someone who died in Adar of an ordinary year, observed in a
   * leap year. The standard calendrical rule (Reingold & Dershowitz) places it
   * in Adar I. Many communities observe Adar II, and some observe both.
   * "both" is deliberately not offered in the MVP - see docs/DATA-MODEL.md.
   */
  adarOrdinaryYahrzeitInLeapYear: 'adar_i' | 'adar_ii';
}

export const DEFAULT_CONVENTIONS: CalculationConventions = {
  adarOrdinaryYahrzeitInLeapYear: 'adar_i',
};

/** Why the engine stopped and asked the user instead of choosing. */
export type DecisionCode =
  /** A Gregorian date was entered without saying whether it was before sunset. */
  | 'UNKNOWN_SUNSET_STATUS'
  /**
   * A yahrzeit on 30 Cheshvan or 30 Kislev whose observance depends on the
   * character of the year after the death, which needs the Hebrew year.
   */
  | 'YAHRZEIT_30TH_REQUIRES_ORIGIN_YEAR';

export interface DecisionOption<T> {
  id: string;
  label: string;
  value: T;
}

export interface DecisionRequired<T = unknown> {
  status: 'needs_user_decision';
  code: DecisionCode;
  question: string;
  explanation: string;
  options: DecisionOption<T>[];
}
