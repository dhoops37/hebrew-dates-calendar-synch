import { describe, expect, it } from 'vitest';
import {
  ORDINARY_YEAR_MONTHS,
  LEAP_YEAR_MONTHS,
  absoluteToCivil,
  civilToAbsolute,
  civilToHebrew,
  daysInMonth,
  daysInYear,
  formatCivilDate,
  hebrewDateExists,
  hebrewToAbsolute,
  hebrewToCivil,
  isLeapYear,
  isLongCheshvan,
  isShortKislev,
  lastMonthOfYear,
  monthNameFor,
  monthNumberForName,
  monthsInYear,
  selectableMonths,
} from '../src/hebrewCalendar';
import { HEBREW_MONTH_NUMBER, type HebrewMonthNumber } from '../src/types';
import { GOLDEN_DATES, YEAR_CHARACTERISTICS } from './fixtures/golden-dates';

describe('golden-date set (PRD 35.2)', () => {
  it.each(GOLDEN_DATES)(
    'Hebrew $hebrew.year-$hebrew.month-$hebrew.day is $gregorian [$source]',
    ({ hebrew, gregorian }) => {
      const civil = hebrewToCivil({
        year: hebrew.year,
        month: hebrew.month as HebrewMonthNumber,
        day: hebrew.day,
      });
      expect(formatCivilDate(civil)).toBe(gregorian);
    },
  );

  it.each(GOLDEN_DATES)(
    '$gregorian converts back to Hebrew $hebrew.year-$hebrew.month-$hebrew.day [$source]',
    ({ hebrew, gregorian }) => {
      const [year, month, day] = gregorian.split('-').map(Number) as [number, number, number];
      expect(civilToHebrew({ year, month, day })).toEqual({
        year: hebrew.year,
        month: hebrew.month,
        day: hebrew.day,
      });
    },
  );

  it('has at least fifteen independently verifiable anchor rows', () => {
    // Guards against the set silently degrading into pure self-snapshots.
    expect(GOLDEN_DATES.filter((row) => row.source === 'anchor').length).toBeGreaterThanOrEqual(15);
  });
});

describe('leap years', () => {
  it('follows the 19-year Metonic cycle: years 3, 6, 8, 11, 14, 17 and 19', () => {
    const leapPositions = new Set([3, 6, 8, 11, 14, 17, 19]);
    for (let year = 5700; year <= 5900; year++) {
      const positionInCycle = ((year % 19) + 19) % 19 || 19;
      expect(isLeapYear(year), `year ${year} (position ${positionInCycle})`).toBe(
        leapPositions.has(positionInCycle),
      );
    }
  });

  it('gives leap years thirteen months and ordinary years twelve', () => {
    for (let year = 5780; year <= 5820; year++) {
      expect(monthsInYear(year)).toBe(isLeapYear(year) ? 13 : 12);
      expect(lastMonthOfYear(year)).toBe(isLeapYear(year) ? 13 : 12);
    }
  });

  it('has seven leap years in every 19-year window', () => {
    for (let start = 5700; start <= 5880; start++) {
      const leapCount = Array.from({ length: 19 }, (_, i) => start + i).filter(isLeapYear).length;
      expect(leapCount).toBe(7);
    }
  });
});

describe('year characteristics: Cheshvan, Kislev and year length', () => {
  it.each(YEAR_CHARACTERISTICS)(
    'year $year: leap=$isLeap cheshvan=$cheshvanDays kislev=$kislevDays days=$daysInYear',
    (characteristic) => {
      expect(isLeapYear(characteristic.year)).toBe(characteristic.isLeap);
      expect(monthsInYear(characteristic.year)).toBe(characteristic.monthsInYear);
      expect(daysInMonth(HEBREW_MONTH_NUMBER.CHESHVAN, characteristic.year)).toBe(
        characteristic.cheshvanDays,
      );
      expect(daysInMonth(HEBREW_MONTH_NUMBER.KISLEV, characteristic.year)).toBe(
        characteristic.kislevDays,
      );
      expect(daysInYear(characteristic.year)).toBe(characteristic.daysInYear);
    },
  );

  it('only ever produces the six legal year lengths', () => {
    const legal = new Set([353, 354, 355, 383, 384, 385]);
    for (let year = 5600; year <= 6000; year++) {
      expect(legal.has(daysInYear(year)), `year ${year} has ${daysInYear(year)} days`).toBe(true);
    }
  });

  it('derives year length from the Cheshvan and Kislev variations alone', () => {
    for (let year = 5700; year <= 5900; year++) {
      const base = isLeapYear(year) ? 383 : 353;
      const extra = (isLongCheshvan(year) ? 1 : 0) + (isShortKislev(year) ? 0 : 1);
      expect(daysInYear(year)).toBe(base + extra);
    }
  });

  it('keeps every other month at its fixed length', () => {
    const fixed: Array<[HebrewMonthNumber, number]> = [
      [HEBREW_MONTH_NUMBER.NISAN, 30],
      [HEBREW_MONTH_NUMBER.IYYAR, 29],
      [HEBREW_MONTH_NUMBER.SIVAN, 30],
      [HEBREW_MONTH_NUMBER.TAMUZ, 29],
      [HEBREW_MONTH_NUMBER.AV, 30],
      [HEBREW_MONTH_NUMBER.ELUL, 29],
      [HEBREW_MONTH_NUMBER.TISHREI, 30],
      [HEBREW_MONTH_NUMBER.TEVET, 29],
      [HEBREW_MONTH_NUMBER.SHVAT, 30],
    ];
    for (let year = 5780; year <= 5820; year++) {
      for (const [month, length] of fixed) {
        expect(daysInMonth(month, year), `month ${month} of ${year}`).toBe(length);
      }
      // Adar I is always 30 days, Adar II always 29, and in an ordinary year
      // the single Adar has 29 days.
      expect(daysInMonth(HEBREW_MONTH_NUMBER.ADAR_I, year)).toBe(isLeapYear(year) ? 30 : 29);
      if (isLeapYear(year)) {
        expect(daysInMonth(HEBREW_MONTH_NUMBER.ADAR_II, year)).toBe(29);
      }
    }
  });
});

describe('month naming', () => {
  it('reads month 12 as Adar in an ordinary year and Adar I in a leap year', () => {
    expect(monthNameFor(HEBREW_MONTH_NUMBER.ADAR_I, 5785)).toBe('ADAR');
    expect(monthNameFor(HEBREW_MONTH_NUMBER.ADAR_I, 5784)).toBe('ADAR_I');
    expect(monthNameFor(HEBREW_MONTH_NUMBER.ADAR_II, 5784)).toBe('ADAR_II');
  });

  it('maps both Adar and Adar I to month number 12', () => {
    expect(monthNumberForName('ADAR')).toBe(12);
    expect(monthNumberForName('ADAR_I')).toBe(12);
    expect(monthNumberForName('ADAR_II')).toBe(13);
  });

  it('offers thirteen months in a leap year and twelve otherwise', () => {
    expect(selectableMonths(5784)).toEqual(LEAP_YEAR_MONTHS);
    expect(selectableMonths(5785)).toEqual(ORDINARY_YEAR_MONTHS);
  });

  it('offers Adar, Adar I and Adar II when the year is unknown (PRD 16.1)', () => {
    const months = selectableMonths(undefined);
    expect(months).toContain('ADAR');
    expect(months).toContain('ADAR_I');
    expect(months).toContain('ADAR_II');
  });
});

describe('date validity', () => {
  it('rejects dates that do not exist', () => {
    expect(hebrewDateExists({ year: 5784, month: 8, day: 30 })).toBe(false); // short Cheshvan
    expect(hebrewDateExists({ year: 5785, month: 8, day: 30 })).toBe(true);
    expect(hebrewDateExists({ year: 5785, month: 13, day: 1 })).toBe(false); // no Adar II
    expect(hebrewDateExists({ year: 5784, month: 13, day: 30 })).toBe(false); // Adar II is 29
    expect(hebrewDateExists({ year: 5784, month: 12, day: 30 })).toBe(true); // Adar I is 30
    expect(hebrewDateExists({ year: 5785, month: 12, day: 30 })).toBe(false); // Adar is 29
  });
});

describe('conversion round-trips', () => {
  it('round-trips every 37th day across 200 Gregorian years', () => {
    const start = civilToAbsolute({ year: 1900, month: 1, day: 1 });
    const end = civilToAbsolute({ year: 2100, month: 1, day: 1 });
    for (let abs = start; abs <= end; abs += 37) {
      const civil = absoluteToCivil(abs);
      expect(civilToAbsolute(civil)).toBe(abs);
      const hebrew = civilToHebrew(civil);
      expect(hebrewDateExists(hebrew)).toBe(true);
      expect(hebrewToAbsolute(hebrew)).toBe(abs);
      expect(hebrewToCivil(hebrew)).toEqual(civil);
    }
  });

  it('advances the Hebrew day exactly once per civil day', () => {
    let abs = civilToAbsolute({ year: 2024, month: 1, day: 1 });
    let previous = civilToHebrew(absoluteToCivil(abs));
    for (let i = 1; i < 800; i++) {
      const current = civilToHebrew(absoluteToCivil(abs + i));
      const advancedWithinMonth = current.day === previous.day + 1;
      const rolledOverToNewMonth = current.day === 1 && previous.day >= 29;
      expect(advancedWithinMonth || rolledOverToNewMonth).toBe(true);
      previous = current;
    }
  });
});
