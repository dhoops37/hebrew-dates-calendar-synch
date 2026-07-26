/**
 * Thin, explicit wrapper over @hebcal's Hebrew-calendar primitives.
 *
 * Everything here is total and side-effect free. The wrapper exists so that the
 * rest of the engine never touches a `Date` or a bare month number, and so that
 * swapping the underlying library later touches one file.
 */
import { HDate } from '@hebcal/core';
import {
  HEBREW_MONTH_NUMBER,
  type CivilDate,
  type HebrewDate,
  type HebrewMonthName,
  type HebrewMonthNumber,
} from './types';

/** Months of an ordinary year, in calendar order starting from Tishrei. */
export const ORDINARY_YEAR_MONTHS: HebrewMonthName[] = [
  'TISHREI',
  'CHESHVAN',
  'KISLEV',
  'TEVET',
  'SHVAT',
  'ADAR',
  'NISAN',
  'IYYAR',
  'SIVAN',
  'TAMUZ',
  'AV',
  'ELUL',
];

/** Months of a leap year, in calendar order starting from Tishrei. */
export const LEAP_YEAR_MONTHS: HebrewMonthName[] = [
  'TISHREI',
  'CHESHVAN',
  'KISLEV',
  'TEVET',
  'SHVAT',
  'ADAR_I',
  'ADAR_II',
  'NISAN',
  'IYYAR',
  'SIVAN',
  'TAMUZ',
  'AV',
  'ELUL',
];

export function isLeapYear(hebrewYear: number): boolean {
  return HDate.isLeapYear(hebrewYear);
}

export function monthsInYear(hebrewYear: number): 12 | 13 {
  return isLeapYear(hebrewYear) ? 13 : 12;
}

/** The last month of the Hebrew year: Adar (12) or Adar II (13). */
export function lastMonthOfYear(hebrewYear: number): HebrewMonthNumber {
  return monthsInYear(hebrewYear) as HebrewMonthNumber;
}

export function daysInMonth(month: HebrewMonthNumber, hebrewYear: number): number {
  return HDate.daysInMonth(month, hebrewYear);
}

export function daysInYear(hebrewYear: number): number {
  return HDate.daysInYear(hebrewYear);
}

/** True when Cheshvan has 30 days in this year. */
export function isLongCheshvan(hebrewYear: number): boolean {
  return daysInMonth(HEBREW_MONTH_NUMBER.CHESHVAN, hebrewYear) === 30;
}

/** True when Kislev has 29 days in this year. */
export function isShortKislev(hebrewYear: number): boolean {
  return daysInMonth(HEBREW_MONTH_NUMBER.KISLEV, hebrewYear) === 29;
}

/**
 * Resolve a user-facing month name to the month number it occupies in a given
 * year. `ADAR` and `ADAR_I` both map to 12; the caller keeps the name around
 * when the distinction matters.
 */
export function monthNumberForName(name: HebrewMonthName): HebrewMonthNumber {
  if (name === 'ADAR') return HEBREW_MONTH_NUMBER.ADAR_I;
  return HEBREW_MONTH_NUMBER[name];
}

/**
 * Whether a month name implies its origin year was a leap year.
 * `ADAR_I` / `ADAR_II` only exist in leap years; `ADAR` only in ordinary years.
 * For every other month the answer is unknown, and no rule depends on it.
 */
export function originYearLeapnessImpliedBy(name: HebrewMonthName): boolean | undefined {
  if (name === 'ADAR') return false;
  if (name === 'ADAR_I' || name === 'ADAR_II') return true;
  return undefined;
}

/** Name a (month number, year) pair the way a user would read it. */
export function monthNameFor(month: HebrewMonthNumber, hebrewYear: number): HebrewMonthName {
  if (month === HEBREW_MONTH_NUMBER.ADAR_I) {
    return isLeapYear(hebrewYear) ? 'ADAR_I' : 'ADAR';
  }
  if (month === HEBREW_MONTH_NUMBER.ADAR_II) return 'ADAR_II';
  const entry = (Object.keys(HEBREW_MONTH_NUMBER) as (keyof typeof HEBREW_MONTH_NUMBER)[]).find(
    (key) => HEBREW_MONTH_NUMBER[key] === month,
  );
  /* c8 ignore next */
  if (!entry) throw new RangeError(`Unknown Hebrew month number ${month}`);
  return entry as HebrewMonthName;
}

/** Months available for selection in a given year, or for an unknown year. */
export function selectableMonths(hebrewYear?: number): HebrewMonthName[] {
  if (hebrewYear === undefined) {
    // With no year, the user must be able to say Adar, Adar I or Adar II,
    // because that choice is what tells the engine whether the origin year was
    // a leap year (PRD 16.1).
    return [...ORDINARY_YEAR_MONTHS, 'ADAR_I', 'ADAR_II'];
  }
  return isLeapYear(hebrewYear) ? [...LEAP_YEAR_MONTHS] : [...ORDINARY_YEAR_MONTHS];
}

/** Validate a Hebrew date that is claimed to exist. */
export function hebrewDateExists(date: HebrewDate): boolean {
  if (date.day < 1 || !Number.isInteger(date.day)) return false;
  if (date.month === HEBREW_MONTH_NUMBER.ADAR_II && !isLeapYear(date.year)) return false;
  if (date.month < 1 || date.month > monthsInYear(date.year)) return false;
  return date.day <= daysInMonth(date.month, date.year);
}

/**
 * Rata Die (fixed day number). Used for ordering and for date arithmetic,
 * so that no comparison ever routes through a `Date`.
 */
export function hebrewToAbsolute(date: HebrewDate): number {
  return new HDate(date.day, date.month, date.year).abs();
}

export function absoluteToHebrew(abs: number): HebrewDate {
  const hd = new HDate(abs);
  return { year: hd.getFullYear(), month: hd.getMonth() as HebrewMonthNumber, day: hd.getDate() };
}

export function civilToAbsolute(date: CivilDate): number {
  // `new Date(y, m, d)` uses local components, and HDate reads them back with
  // getFullYear/getMonth/getDate, so this round-trips under any server zone.
  // Years 0-99 would be shifted into 1900-1999 by the Date constructor, which
  // is irrelevant here but guarded anyway.
  const d = new Date(date.year, date.month - 1, date.day);
  d.setFullYear(date.year);
  return new HDate(d).abs();
}

export function absoluteToCivil(abs: number): CivilDate {
  const greg = new HDate(abs).greg();
  return { year: greg.getFullYear(), month: greg.getMonth() + 1, day: greg.getDate() };
}

export function hebrewToCivil(date: HebrewDate): CivilDate {
  return absoluteToCivil(hebrewToAbsolute(date));
}

export function civilToHebrew(date: CivilDate): HebrewDate {
  return absoluteToHebrew(civilToAbsolute(date));
}

export function addDaysToCivil(date: CivilDate, days: number): CivilDate {
  return absoluteToCivil(civilToAbsolute(date) + days);
}

/** ISO-8601 calendar-day string, e.g. "2024-04-16". */
export function formatCivilDate(date: CivilDate): string {
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');
  return `${date.year < 0 ? '-' : ''}${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

/** Day of week for a civil date, 0 = Sunday. */
export function civilDayOfWeek(date: CivilDate): number {
  return new HDate(civilToAbsolute(date)).getDay();
}
