/**
 * Hebrew-date display formatting.
 *
 * PRD 29 requires three date-display settings: transliterated English only,
 * Hebrew only, or both. Names entered by users are never transliterated.
 */
import { HDate, Locale, gematriya } from '@hebcal/core';
import type { HebrewDate, HebrewMonthName } from './types';
import { monthNameFor } from './hebrewCalendar';

export type HebrewDateDisplayStyle = 'en' | 'he' | 'both';

/** English transliteration used in titles and descriptions. */
const ENGLISH_MONTH_LABEL: Record<HebrewMonthName, string> = {
  NISAN: 'Nisan',
  IYYAR: 'Iyyar',
  SIVAN: 'Sivan',
  TAMUZ: 'Tamuz',
  AV: 'Av',
  ELUL: 'Elul',
  TISHREI: 'Tishrei',
  CHESHVAN: 'Cheshvan',
  KISLEV: 'Kislev',
  TEVET: 'Tevet',
  SHVAT: 'Shevat',
  ADAR: 'Adar',
  ADAR_I: 'Adar I',
  ADAR_II: 'Adar II',
};

/** @hebcal locale keys, which differ from this engine's month names. */
const HEBCAL_MONTH_KEY: Record<HebrewMonthName, string> = {
  NISAN: 'Nisan',
  IYYAR: 'Iyyar',
  SIVAN: 'Sivan',
  TAMUZ: 'Tamuz',
  AV: 'Av',
  ELUL: 'Elul',
  TISHREI: 'Tishrei',
  CHESHVAN: 'Cheshvan',
  KISLEV: 'Kislev',
  TEVET: 'Tevet',
  SHVAT: "Sh'vat",
  ADAR: 'Adar',
  ADAR_I: 'Adar I',
  ADAR_II: 'Adar II',
};

export function englishMonthLabel(name: HebrewMonthName): string {
  return ENGLISH_MONTH_LABEL[name];
}

export function hebrewMonthLabel(name: HebrewMonthName, stripNikkud = true): string {
  const label = Locale.gettext(HEBCAL_MONTH_KEY[name], stripNikkud ? 'he-x-NoNikud' : 'he');
  return typeof label === 'string' ? label : ENGLISH_MONTH_LABEL[name];
}

/** "10 Nisan" or, with the year, "10 Nisan 5785". */
export function formatHebrewDateEnglish(date: HebrewDate, includeYear = false): string {
  const name = monthNameFor(date.month, date.year);
  return includeYear
    ? `${date.day} ${ENGLISH_MONTH_LABEL[name]} ${date.year}`
    : `${date.day} ${ENGLISH_MONTH_LABEL[name]}`;
}

/** "י׳ בניסן" or, with the year, "י׳ בניסן תשפ״ה". */
export function formatHebrewDateHebrew(date: HebrewDate, includeYear = false): string {
  const name = monthNameFor(date.month, date.year);
  const month = hebrewMonthLabel(name);
  // Hebrew renders the month with a "ב" prefix ("of"), except for the two Adars
  // of a leap year, which are conventionally written without it.
  const prefixed = name === 'ADAR_I' || name === 'ADAR_II' ? month : `ב${month}`;
  const day = gematriya(date.day);
  return includeYear ? `${day} ${prefixed} ${gematriya(date.year % 1000)}` : `${day} ${prefixed}`;
}

export function formatHebrewDate(
  date: HebrewDate,
  style: HebrewDateDisplayStyle = 'en',
  includeYear = false,
): string {
  switch (style) {
    case 'he':
      return formatHebrewDateHebrew(date, includeYear);
    case 'both':
      return `${formatHebrewDateHebrew(date, includeYear)} / ${formatHebrewDateEnglish(date, includeYear)}`;
    default:
      return formatHebrewDateEnglish(date, includeYear);
  }
}

export interface HebrewDateLabels {
  en: string;
  he: string;
  enWithYear: string;
  heWithYear: string;
  monthName: HebrewMonthName;
}

export function hebrewDateLabels(date: HebrewDate): HebrewDateLabels {
  return {
    en: formatHebrewDateEnglish(date),
    he: formatHebrewDateHebrew(date),
    enWithYear: formatHebrewDateEnglish(date, true),
    heWithYear: formatHebrewDateHebrew(date, true),
    monthName: monthNameFor(date.month, date.year),
  };
}

/** Hebrew year in gematriya, e.g. 5785 -> תשפ״ה. */
export function formatHebrewYear(year: number): string {
  return gematriya(year % 1000);
}

/** The Hebrew date of a civil day, rendered by @hebcal, for cross-checking. */
export function renderReference(date: HebrewDate): string {
  return new HDate(date.day, date.month, date.year).render('en');
}
