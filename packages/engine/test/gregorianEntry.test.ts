/**
 * "Never silently choose a Hebrew date when the user does not know whether the
 * event happened before or after sunset." (PRD 16.3, and the explicit
 * instruction to the coding agent.)
 */
import { describe, expect, it } from 'vitest';
import {
  hebrewDateForDaytimeOf,
  hebrewDateForEveningOf,
  interpretGregorianEntry,
} from '../src/gregorianEntry';
import { getSeedLocation } from '../src/locations';
import { HEBREW_MONTH_NUMBER } from '../src/types';

const newYork = getSeedLocation('seed:new-york')!;

describe('before and after sunset give different Hebrew dates', () => {
  // 22 April 2024 was 14 Nisan 5784 by day; the evening of that day began
  // 15 Nisan 5784, the first seder.
  const gregorianDate = { year: 2024, month: 4, day: 22 };

  it('maps the daytime to the Hebrew date of that Gregorian day', () => {
    expect(hebrewDateForDaytimeOf(gregorianDate).hebrewDate).toEqual({
      year: 5784,
      month: HEBREW_MONTH_NUMBER.NISAN,
      day: 14,
    });
  });

  it('maps the evening to the following Hebrew date', () => {
    expect(hebrewDateForEveningOf(gregorianDate).hebrewDate).toEqual({
      year: 5784,
      month: HEBREW_MONTH_NUMBER.NISAN,
      day: 15,
    });
  });

  it('resolves "before sunset" to the daytime Hebrew date', () => {
    const result = interpretGregorianEntry({ gregorianDate, sunsetStatus: 'before_sunset' });
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.interpretation.hebrewDate.day).toBe(14);
  });

  it('resolves "after sunset" to the following Hebrew date', () => {
    const result = interpretGregorianEntry({ gregorianDate, sunsetStatus: 'after_sunset' });
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.interpretation.hebrewDate.day).toBe(15);
  });
});

describe('unknown sunset status', () => {
  const gregorianDate = { year: 2024, month: 4, day: 22 };

  it('refuses to choose and returns both candidates', () => {
    const result = interpretGregorianEntry({ gregorianDate, sunsetStatus: 'unknown' });
    expect(result.status).toBe('needs_user_decision');
    if (result.status !== 'needs_user_decision') return;
    expect(result.code).toBe('UNKNOWN_SUNSET_STATUS');
    expect(result.options.map((option) => option.id)).toEqual(['before_sunset', 'after_sunset']);
    expect(result.options[0]?.value.hebrewDate.day).toBe(14);
    expect(result.options[1]?.value.hebrewDate.day).toBe(15);
    expect(result.options[0]?.label).toContain('14 Nisan');
    expect(result.options[1]?.label).toContain('15 Nisan');
  });

  it('offers the actual sunset time as evidence when a location is known', () => {
    const result = interpretGregorianEntry({
      gregorianDate,
      sunsetStatus: 'unknown',
      location: newYork,
    });
    expect(result.status).toBe('needs_user_decision');
    if (result.status !== 'needs_user_decision') return;
    expect(result.explanation).toMatch(/Sunset at the selected location .* was 2024-04-22T19:4\d/);
  });

  it('suggests where the answer might be found', () => {
    const result = interpretGregorianEntry({ gregorianDate, sunsetStatus: 'unknown' });
    if (result.status !== 'needs_user_decision') throw new Error('expected a decision request');
    expect(result.explanation).toMatch(/certificate|relative/i);
  });
});

describe('the two candidates always differ by exactly one Hebrew day', () => {
  it('holds across a year, including month and year boundaries', () => {
    for (let day = 0; day < 400; day++) {
      const date = new Date(Date.UTC(2024, 0, 1) + day * 86_400_000);
      const gregorianDate = {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      };
      const before = hebrewDateForDaytimeOf(gregorianDate).hebrewDate;
      const after = hebrewDateForEveningOf(gregorianDate).hebrewDate;
      const sameMonth = after.year === before.year && after.month === before.month;
      expect(sameMonth ? after.day === before.day + 1 : after.day === 1).toBe(true);
    }
  });
});

describe('sunset evidence for a historical date', () => {
  it('reports the sunset that applied on the day itself', () => {
    const result = interpretGregorianEntry({
      gregorianDate: { year: 1978, month: 5, day: 12 },
      sunsetStatus: 'before_sunset',
      location: newYork,
    });
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.sunsetOnEnteredDate?.status).toBe('ok');
    if (result.sunsetOnEnteredDate?.status !== 'ok') return;
    expect(result.sunsetOnEnteredDate.iso).toMatch(/^1978-05-12T20:0\d:\d\d-04:00$/);
  });
});
