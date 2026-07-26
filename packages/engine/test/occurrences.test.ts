import { describe, expect, it } from 'vitest';
import {
  currentHebrewDateAt,
  generateOccurrences,
  type GenerateOccurrencesInput,
  type Occurrence,
} from '../src/occurrences';
import { getSeedLocation } from '../src/locations';
import { civilToAbsolute, formatCivilDate } from '../src/hebrewCalendar';
import { HEBREW_MONTH_NUMBER, type CalculationLocation } from '../src/types';

function requireLocation(id: string): CalculationLocation {
  const location = getSeedLocation(id);
  if (!location) throw new Error(`missing seed location ${id}`);
  return location;
}

const jerusalem = requireLocation('seed:jerusalem');
const newYork = requireLocation('seed:new-york');

/** 15 January 2025, midday UTC. */
const NOW = Date.UTC(2025, 0, 15, 12, 0, 0);

function generate(overrides: Partial<GenerateOccurrencesInput> = {}): Occurrence[] {
  const result = generateOccurrences({
    sourceRecordId: 'record-abc',
    type: 'birthday',
    displayName: 'David',
    origin: { month: 'NISAN', day: 10 },
    location: jerusalem,
    displayMode: 'exact_sunset',
    count: 20,
    nowEpochMs: NOW,
    ...overrides,
  });
  if (result.status !== 'ok') throw new Error(`expected occurrences, got ${result.code}`);
  return result.occurrences;
}

describe('the twenty-year horizon', () => {
  it('generates exactly twenty future occurrences', () => {
    expect(generate()).toHaveLength(20);
  });

  it('gives each occurrence a distinct, consecutive Hebrew year', () => {
    const years = generate().map((o) => o.hebrewYear);
    expect(new Set(years).size).toBe(20);
    for (let i = 1; i < years.length; i++) {
      expect(years[i]).toBe(years[i - 1]! + 1);
    }
  });

  it('orders occurrences forwards in time and starts no earlier than today', () => {
    const occurrences = generate();
    const todayAbs = civilToAbsolute({ year: 2025, month: 1, day: 15 });
    let previous = -Infinity;
    for (const occurrence of occurrences) {
      const abs = civilToAbsolute(occurrence.gregorianDate);
      expect(abs).toBeGreaterThanOrEqual(todayAbs);
      expect(abs).toBeGreaterThan(previous);
      previous = abs;
    }
  });

  it('does not fall on the same Gregorian date every year', () => {
    // The whole point of the product: a Hebrew date is not a Gregorian
    // yearly recurrence, so this must never be implementable as one.
    const monthDays = new Set(
      generate().map((o) => `${o.gregorianDate.month}-${o.gregorianDate.day}`),
    );
    expect(monthDays.size).toBeGreaterThan(10);
  });

  it('drifts by roughly the expected amount between consecutive years', () => {
    const occurrences = generate();
    for (let i = 1; i < occurrences.length; i++) {
      const gap =
        civilToAbsolute(occurrences[i]!.gregorianDate) -
        civilToAbsolute(occurrences[i - 1]!.gregorianDate);
      // A Hebrew year is 353-385 days, so consecutive occurrences of the same
      // Hebrew date are that far apart in Gregorian days.
      expect(gap).toBeGreaterThanOrEqual(353);
      expect(gap).toBeLessThanOrEqual(385);
    }
  });
});

describe('exact sunset mode (PRD 14.1)', () => {
  it('starts at sunset the day before and ends at sunset on the Hebrew date', () => {
    const [first] = generate();
    if (!first) throw new Error('no occurrences');
    expect(first.start.status).toBe('ok');
    expect(first.end.status).toBe('ok');
    expect(first.timing).not.toBeNull();
    expect(civilToAbsolute(first.precedingGregorianDate)).toBe(
      civilToAbsolute(first.gregorianDate) - 1,
    );
    expect(first.timing!.startEpochMs).toBeLessThan(first.timing!.endEpochMs);
  });

  it('produces a window of about 24 hours for every occurrence', () => {
    for (const occurrence of generate()) {
      expect(occurrence.timing!.durationMinutes).toBeGreaterThan(23 * 60 + 54);
      expect(occurrence.timing!.durationMinutes).toBeLessThan(24 * 60 + 6);
    }
  });

  it('stamps the location time zone on the start and end instants', () => {
    for (const occurrence of generate({ location: newYork })) {
      expect(occurrence.timing!.startIso).toMatch(/-0[45]:00$/);
      expect(occurrence.timing!.endIso).toMatch(/-0[45]:00$/);
    }
  });

  it('produces different times for different locations on the same Hebrew date', () => {
    const [jerusalemFirst] = generate({ location: jerusalem });
    const [newYorkFirst] = generate({ location: newYork });
    expect(jerusalemFirst!.hebrewDate).toEqual(newYorkFirst!.hebrewDate);
    expect(jerusalemFirst!.timing!.startEpochMs).not.toBe(newYorkFirst!.timing!.startEpochMs);
  });
});

describe('two-day all-day mode (PRD 14.2)', () => {
  it('covers both Gregorian days with one event, using an exclusive end date', () => {
    // RFC 5545 and the Google Calendar API both treat an all-day end date as
    // exclusive, so the stored end is the day after the second covered day.
    const [first] = generate({ displayMode: 'two_day_all_day' });
    if (!first) throw new Error('no occurrences');
    expect(first.allDay.startDate).toBe(formatCivilDate(first.precedingGregorianDate));
    const endAbs = civilToAbsolute({
      year: Number(first.allDay.endDateExclusive.slice(0, 4)),
      month: Number(first.allDay.endDateExclusive.slice(5, 7)),
      day: Number(first.allDay.endDateExclusive.slice(8, 10)),
    });
    expect(endAbs).toBe(civilToAbsolute(first.gregorianDate) + 1);
    expect(endAbs - civilToAbsolute(first.precedingGregorianDate)).toBe(2);
  });

  it('is one event, not two', () => {
    const occurrences = generate({ displayMode: 'two_day_all_day' });
    expect(occurrences).toHaveLength(20);
    expect(new Set(occurrences.map((o) => o.key)).size).toBe(20);
  });

  it('still records the sunset times in the description', () => {
    const [first] = generate({ displayMode: 'two_day_all_day' });
    expect(first!.description).toMatch(/Begins at sunset on \d{4}-\d{2}-\d{2}/);
    expect(first!.description).toContain('Jerusalem');
  });

  it('changes the content hash when the display mode changes', () => {
    const exact = generate({ displayMode: 'exact_sunset' })[0]!;
    const allDay = generate({ displayMode: 'two_day_all_day' })[0]!;
    expect(exact.key).toBe(allDay.key);
    expect(exact.contentHash).not.toBe(allDay.contentHash);
  });
});

describe('yahrzeits', () => {
  it('starts from the year after the death', () => {
    const occurrences = generate({
      type: 'personal_yahrzeit',
      displayName: 'Sarah',
      origin: { month: 'TEVET', day: 12, year: 5785 },
    });
    expect(occurrences[0]!.hebrewYear).toBe(5786);
    expect(occurrences[0]!.title).toContain('Yahrzeit: Sarah');
  });

  it('surfaces a decision instead of guessing a 30 Cheshvan yahrzeit', () => {
    const result = generateOccurrences({
      sourceRecordId: 'record-abc',
      type: 'personal_yahrzeit',
      displayName: 'Unknown year',
      origin: { month: 'CHESHVAN', day: 30 },
      location: jerusalem,
      displayMode: 'exact_sunset',
      count: 20,
      nowEpochMs: NOW,
    });
    expect(result.status).toBe('needs_user_decision');
  });
});

describe('sunset-aware "today"', () => {
  it('advances the Hebrew date after sunset', () => {
    // Sunset in Jerusalem on 15 January 2025 is around 17:00 local (15:00 UTC).
    const before = currentHebrewDateAt(jerusalem, Date.UTC(2025, 0, 15, 12, 0, 0));
    const after = currentHebrewDateAt(jerusalem, Date.UTC(2025, 0, 15, 18, 0, 0));
    expect(after.day).toBe(before.day + 1);
  });

  it('includes an occurrence whose sunset-to-sunset window is still running', () => {
    // 10 Nisan 5785 falls on 8 April 2025. On the morning of the 8th the event
    // started the previous evening and has not ended, so it must still appear.
    const occurrences = generate({ nowEpochMs: Date.UTC(2025, 3, 8, 6, 0, 0) });
    expect(occurrences[0]!.hebrewYear).toBe(5785);
    expect(formatCivilDate(occurrences[0]!.gregorianDate)).toBe('2025-04-08');
  });

  it('moves on once the window has ended', () => {
    const occurrences = generate({ nowEpochMs: Date.UTC(2025, 3, 9, 6, 0, 0) });
    expect(occurrences[0]!.hebrewYear).toBe(5786);
  });
});

describe('edge-case dates over the whole horizon', () => {
  it('never emits a Hebrew date that does not exist', () => {
    const origins = [
      { month: 'CHESHVAN', day: 30 },
      { month: 'KISLEV', day: 30 },
      { month: 'ADAR', day: 10 },
      { month: 'ADAR_I', day: 30, year: 5784 },
      { month: 'ADAR_II', day: 10, year: 5784 },
    ] as const;
    for (const origin of origins) {
      for (const type of ['birthday', 'personal_yahrzeit'] as const) {
        const result = generateOccurrences({
          sourceRecordId: 'record-abc',
          type,
          displayName: 'Test',
          origin,
          location: jerusalem,
          displayMode: 'exact_sunset',
          count: 20,
          nowEpochMs: NOW,
        });
        if (result.status !== 'ok') continue;
        for (const occurrence of result.occurrences) {
          // Round-tripping through the absolute day proves the date is real.
          const abs = civilToAbsolute(occurrence.gregorianDate);
          expect(Number.isInteger(abs)).toBe(true);
          expect(occurrence.timing).not.toBeNull();
        }
      }
    }
  });

  it('flags the years that need review and leaves the rest clean', () => {
    const result = generateOccurrences({
      sourceRecordId: 'record-abc',
      type: 'birthday',
      displayName: 'Adar child',
      origin: { month: 'ADAR', day: 10 },
      location: jerusalem,
      displayMode: 'exact_sunset',
      count: 20,
      nowEpochMs: NOW,
    });
    if (result.status !== 'ok') throw new Error('expected occurrences');
    expect(result.requiresReview).toBe(true);
    const flagged = result.occurrences.filter((o) => o.ambiguities.length > 0);
    // Seven leap years in every nineteen.
    expect(flagged.length).toBeGreaterThanOrEqual(6);
    expect(flagged.length).toBeLessThanOrEqual(8);
    for (const occurrence of flagged) {
      expect(occurrence.warnings.some((w) => w.code === 'AMBIGUOUS_HEBREW_DATE')).toBe(true);
    }
  });
});

describe('a yahrzeit observed in both Adars', () => {
  function bothAdars(count = 20) {
    const result = generateOccurrences({
      sourceRecordId: 'record-adar',
      type: 'personal_yahrzeit',
      displayName: 'Zayde',
      // Died 10 Adar 5785, an ordinary year.
      origin: { month: 'ADAR', day: 10, year: 5785 },
      location: jerusalem,
      displayMode: 'exact_sunset',
      count,
      nowEpochMs: NOW,
    });
    if (result.status !== 'ok') throw new Error('expected occurrences');
    return result;
  }

  it('still covers the promised twenty Hebrew years', () => {
    // `count` is a number of years, not of occurrences.
    const result = bothAdars();
    expect(result.hebrewYearsGenerated).toBe(20);
    expect(new Set(result.occurrences.map((o) => o.hebrewYear)).size).toBe(20);
  });

  it('adds one extra occurrence for each leap year in the horizon', () => {
    const result = bothAdars();
    const leapYears = [...new Set(result.occurrences.map((o) => o.hebrewYear))].filter((year) =>
      result.occurrences.filter((o) => o.hebrewYear === year).length === 2,
    );
    // Seven leap years in every nineteen, so six to eight in a twenty-year window.
    expect(leapYears.length).toBeGreaterThanOrEqual(6);
    expect(leapYears.length).toBeLessThanOrEqual(8);
    expect(result.occurrences).toHaveLength(20 + leapYears.length);
  });

  it('places the pair in Adar I and Adar II, in chronological order', () => {
    const result = bothAdars();
    const paired = result.occurrences.filter(
      (o) => result.occurrences.filter((x) => x.hebrewYear === o.hebrewYear).length === 2,
    );
    for (let i = 0; i < paired.length; i += 2) {
      const first = paired[i]!;
      const second = paired[i + 1]!;
      expect(first.hebrewYear).toBe(second.hebrewYear);
      expect(first.hebrewDate.month).toBe(HEBREW_MONTH_NUMBER.ADAR_I);
      expect(second.hebrewDate.month).toBe(HEBREW_MONTH_NUMBER.ADAR_II);
      expect(civilToAbsolute(first.gregorianDate)).toBeLessThan(
        civilToAbsolute(second.gregorianDate),
      );
      // About a month apart: Adar I always has 30 days.
      const gap =
        civilToAbsolute(second.gregorianDate) - civilToAbsolute(first.gregorianDate);
      expect(gap).toBe(30);
    }
  });

  it('gives the two observances different keys, sequences and event IDs', () => {
    const result = bothAdars();
    const pair = result.occurrences.filter(
      (o) => result.occurrences.filter((x) => x.hebrewYear === o.hebrewYear).length === 2,
    );
    expect(pair.length).toBeGreaterThan(0);
    const [first, second] = pair as [Occurrence, Occurrence];
    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
    expect(first.key).not.toBe(second.key);
    expect(first.googleEventId).not.toBe(second.googleEventId);
    // Every key in the whole horizon is still unique.
    expect(new Set(result.occurrences.map((o) => o.key)).size).toBe(result.occurrences.length);
  });

  it('distinguishes the two in the event title', () => {
    const result = bothAdars();
    const pair = result.occurrences.filter(
      (o) => result.occurrences.filter((x) => x.hebrewYear === o.hebrewYear).length === 2,
    );
    const [first, second] = pair as [Occurrence, Occurrence];
    expect(first.title).toContain('10 Adar I');
    expect(second.title).toContain('10 Adar II');
  });

  it('keeps every occurrence in chronological order overall', () => {
    let previous = -Infinity;
    for (const occurrence of bothAdars().occurrences) {
      const abs = civilToAbsolute(occurrence.gregorianDate);
      expect(abs).toBeGreaterThan(previous);
      previous = abs;
    }
  });

  it('collapses to one observance per year under a single-Adar convention', () => {
    const result = generateOccurrences({
      sourceRecordId: 'record-adar',
      type: 'personal_yahrzeit',
      displayName: 'Zayde',
      origin: { month: 'ADAR', day: 10, year: 5785 },
      location: jerusalem,
      displayMode: 'exact_sunset',
      count: 20,
      nowEpochMs: NOW,
      conventions: { adarOrdinaryYahrzeitInLeapYear: 'adar_ii' },
    });
    if (result.status !== 'ok') throw new Error('expected occurrences');
    expect(result.occurrences).toHaveLength(20);
    expect(result.occurrences.every((o) => o.sequence === 0)).toBe(true);
  });

  it('does not double up birthdays, only yahrzeits', () => {
    const result = generateOccurrences({
      sourceRecordId: 'record-birthday',
      type: 'birthday',
      displayName: 'Adar child',
      origin: { month: 'ADAR', day: 10, year: 5785 },
      location: jerusalem,
      displayMode: 'exact_sunset',
      count: 20,
      nowEpochMs: NOW,
    });
    if (result.status !== 'ok') throw new Error('expected occurrences');
    expect(result.occurrences).toHaveLength(20);
  });
});

describe('manual overrides (PRD 17.1)', () => {
  it('uses the override for the given Hebrew year and marks it', () => {
    const override = { year: 5787, month: HEBREW_MONTH_NUMBER.ADAR_I, day: 10 };
    const occurrences = generate({
      origin: { month: 'ADAR', day: 10 },
      overrides: { 5787: override },
    });
    const overridden = occurrences.find((o) => o.hebrewYear === 5787);
    expect(overridden!.hebrewDate).toEqual(override);
    expect(overridden!.isManualOverride).toBe(true);
    expect(occurrences.filter((o) => o.isManualOverride)).toHaveLength(1);
  });
});

describe('locations where the sun does not set', () => {
  it('warns instead of emitting an invalid time', () => {
    const tromso = requireLocation('seed:tromso');
    const result = generateOccurrences({
      sourceRecordId: 'record-abc',
      type: 'birthday',
      displayName: 'Midnight sun',
      // 25 Sivan falls in late June, inside the midnight-sun period.
      origin: { month: 'SIVAN', day: 25 },
      location: tromso,
      displayMode: 'exact_sunset',
      count: 3,
      nowEpochMs: NOW,
    });
    if (result.status !== 'ok') throw new Error('expected occurrences');
    for (const occurrence of result.occurrences) {
      expect(occurrence.timing).toBeNull();
      expect(occurrence.warnings.some((w) => w.code === 'NO_SUNSET')).toBe(true);
      // The all-day representation still works, which is the recommended fallback.
      expect(occurrence.allDay.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(occurrence.description).not.toContain('Invalid');
    }
  });
});

describe('determinism', () => {
  it('produces byte-identical output for identical input', () => {
    expect(JSON.stringify(generate())).toBe(JSON.stringify(generate()));
  });

  it('records the calculation version and a location snapshot on every occurrence', () => {
    for (const occurrence of generate()) {
      expect(occurrence.calculationVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(occurrence.locationSnapshot.timezoneId).toBe('Asia/Jerusalem');
      expect(occurrence.locationSnapshot.latitude).toBe(jerusalem.latitude);
    }
  });

  it('rejects a non-positive count', () => {
    expect(() => generate({ count: 0 })).toThrow(RangeError);
  });
});
