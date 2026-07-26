/**
 * Event titles, descriptions and Hebrew-date formatting (PRD 28 and 29).
 */
import { describe, expect, it } from 'vitest';
import { eventDescription, eventTitle, type EventContentInput } from '../src/eventContent';
import {
  formatHebrewDate,
  formatHebrewDateEnglish,
  formatHebrewDateHebrew,
  formatHebrewYear,
  hebrewDateLabels,
} from '../src/format';
import { HEBREW_MONTH_NUMBER } from '../src/types';

const base: EventContentInput = {
  type: 'birthday',
  displayName: 'David',
  hebrewDate: { year: 5786, month: HEBREW_MONTH_NUMBER.NISAN, day: 10 },
  displayMode: 'exact_sunset',
  locationDisplayName: 'Beit Shemesh, Jerusalem District, Israel',
  startIso: '2026-03-27T18:52:00+03:00',
  endIso: '2026-03-28T18:53:00+03:00',
  startDate: '2026-03-27',
  endDate: '2026-03-28',
};

describe('titles', () => {
  it('formats a birthday', () => {
    expect(eventTitle(base)).toBe("David's Hebrew Birthday — 10 Nisan");
  });

  it('formats a personal yahrzeit with the memorial-candle mark', () => {
    const title = eventTitle({ ...base, type: 'personal_yahrzeit', displayName: 'Sarah' });
    expect(title).toBe('\u{1F56F} Yahrzeit: Sarah — 10 Nisan');
  });

  it('formats a famous yahrzeit', () => {
    const title = eventTitle({ ...base, type: 'famous_yahrzeit', displayName: 'The Rambam' });
    expect(title).toBe('\u{1F56F} The Rambam — Yahrzeit');
  });

  it('prefers a custom title when the user set one', () => {
    expect(eventTitle({ ...base, customTitle: 'Saba’s birthday' })).toBe('Saba’s birthday');
  });

  it('can render the Hebrew date in Hebrew', () => {
    const title = eventTitle({ ...base, language: 'he' });
    expect(title).toContain('בניסן');
  });
});

describe('descriptions', () => {
  it('states the Hebrew date, both sunsets, the location and the mode', () => {
    const description = eventDescription(base);
    expect(description).toContain('Hebrew date: 10 Nisan 5786');
    expect(description).toContain('Begins: 2026-03-27T18:52:00+03:00 (local sunset)');
    expect(description).toContain('Ends: 2026-03-28T18:53:00+03:00 (local sunset)');
    expect(description).toContain('Calculation location: Beit Shemesh');
    expect(description).toContain('Display mode: Exact sunset times');
  });

  it('describes the sunset boundaries in all-day mode, where there are no times', () => {
    const description = eventDescription({
      ...base,
      displayMode: 'two_day_all_day',
      startIso: null,
      endIso: null,
    });
    expect(description).toContain('Begins at sunset on 2026-03-27');
    expect(description).toContain('until sunset on 2026-03-28');
    expect(description).toContain('Display mode: Across both calendar days');
  });

  it('always carries the halachic disclaimer (PRD 5.6)', () => {
    expect(eventDescription(base)).toMatch(/consult your rabbi/i);
    expect(eventDescription(base)).toContain('Managed by Hebrew Dates.');
  });

  it('includes user notes when present', () => {
    expect(eventDescription({ ...base, notes: 'Light a candle at home' })).toContain(
      'Light a candle at home',
    );
  });
});

describe('Hebrew-date display settings (PRD 29)', () => {
  const date = { year: 5786, month: HEBREW_MONTH_NUMBER.NISAN, day: 10 };

  it('renders English transliteration', () => {
    expect(formatHebrewDateEnglish(date)).toBe('10 Nisan');
    expect(formatHebrewDateEnglish(date, true)).toBe('10 Nisan 5786');
  });

  it('renders Hebrew with gematriya', () => {
    expect(formatHebrewDateHebrew(date)).toBe('י׳ בניסן');
    expect(formatHebrewDateHebrew(date, true)).toContain('תשפ');
  });

  it('renders both', () => {
    expect(formatHebrewDate(date, 'both')).toBe('י׳ בניסן / 10 Nisan');
  });

  it('names the two Adars correctly for the year in question', () => {
    const adarOrdinary = { year: 5786, month: HEBREW_MONTH_NUMBER.ADAR_I, day: 10 };
    const adarFirst = { year: 5787, month: HEBREW_MONTH_NUMBER.ADAR_I, day: 10 };
    const adarSecond = { year: 5787, month: HEBREW_MONTH_NUMBER.ADAR_II, day: 10 };
    expect(formatHebrewDateEnglish(adarOrdinary)).toBe('10 Adar');
    expect(formatHebrewDateEnglish(adarFirst)).toBe('10 Adar I');
    expect(formatHebrewDateEnglish(adarSecond)).toBe('10 Adar II');
  });

  it('formats the Hebrew year in gematriya', () => {
    expect(formatHebrewYear(5786)).toBe('תשפ״ו');
  });

  it('provides every label variant on an occurrence', () => {
    const labels = hebrewDateLabels(date);
    expect(labels.en).toBe('10 Nisan');
    expect(labels.enWithYear).toBe('10 Nisan 5786');
    expect(labels.monthName).toBe('NISAN');
    expect(labels.he).toContain('ניסן');
  });
});
