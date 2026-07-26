import { describe, expect, it } from 'vitest';
import { getBirthdayHD, getYahrzeitHD } from '@hebcal/hdate';
import {
  InvalidOriginError,
  normaliseOrigin,
  resolveAnniversary,
  type ResolvedAnniversary,
} from '../src/anniversary';
import { isLeapYear, monthNameFor } from '../src/hebrewCalendar';
import { HEBREW_MONTH_NUMBER, type AnniversaryOrigin, type HebrewMonthName } from '../src/types';

const { CHESHVAN, KISLEV, TEVET, SHVAT, NISAN, ADAR_I, ADAR_II } = HEBREW_MONTH_NUMBER;

function resolved(
  kind: 'birthday' | 'yahrzeit',
  origin: AnniversaryOrigin,
  targetHebrewYear: number,
  conventions?: Parameters<typeof resolveAnniversary>[0]['conventions'],
): ResolvedAnniversary {
  const result = resolveAnniversary({
    kind,
    origin,
    targetHebrewYear,
    ...(conventions ? { conventions } : {}),
  });
  if (result.status !== 'resolved') {
    throw new Error(`expected a resolved anniversary, got ${result.code}`);
  }
  return result;
}

describe('ordinary dates', () => {
  it('keeps the same Hebrew month and day', () => {
    const result = resolved('birthday', { month: 'NISAN', day: 10, year: 5744 }, 5786);
    expect(result.hebrewDate).toEqual({ year: 5786, month: NISAN, day: 10 });
    expect(result.ruleApplied).toBe('SAME_MONTH_AND_DAY');
    expect(result.ambiguities).toEqual([]);
  });

  it('works without an origin Hebrew year (PRD 16.1)', () => {
    const result = resolved('birthday', { month: 'NISAN', day: 10 }, 5786);
    expect(result.hebrewDate).toEqual({ year: 5786, month: NISAN, day: 10 });
  });
});

describe('Adar: birthdays', () => {
  it('born in Adar of an ordinary year, observed in Adar II of a leap year', () => {
    // 5785 is ordinary, 5787 is a leap year.
    const result = resolved('birthday', { month: 'ADAR', day: 10, year: 5785 }, 5787);
    expect(result.hebrewDate).toEqual({ year: 5787, month: ADAR_II, day: 10 });
    expect(result.ruleApplied).toBe('ADAR_ORDINARY_TO_ADAR_II');
  });

  it('flags the Adar birthday in a leap year and offers Adar I as the alternative', () => {
    const result = resolved('birthday', { month: 'ADAR', day: 10 }, 5787);
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0]?.code).toBe('ADAR_ORDINARY_IN_LEAP_YEAR');
    expect(result.ambiguities[0]?.alternative).toEqual({ year: 5787, month: ADAR_I, day: 10 });
  });

  it('born in Adar of an ordinary year, observed in Adar of an ordinary year', () => {
    const result = resolved('birthday', { month: 'ADAR', day: 10 }, 5786);
    expect(result.hebrewDate).toEqual({ year: 5786, month: ADAR_I, day: 10 });
    expect(monthNameFor(result.hebrewDate.month, 5786)).toBe('ADAR');
    expect(result.ambiguities).toEqual([]);
  });

  it('born in Adar II, observed in the last month of the year', () => {
    expect(resolved('birthday', { month: 'ADAR_II', day: 10, year: 5784 }, 5787).hebrewDate).toEqual(
      { year: 5787, month: ADAR_II, day: 10 },
    );
    expect(resolved('birthday', { month: 'ADAR_II', day: 10, year: 5784 }, 5786).hebrewDate).toEqual(
      { year: 5786, month: ADAR_I, day: 10 },
    );
  });

  it('born in Adar I, observed in Adar I of a leap year and Adar of an ordinary year', () => {
    expect(resolved('birthday', { month: 'ADAR_I', day: 10, year: 5784 }, 5787).hebrewDate).toEqual({
      year: 5787,
      month: ADAR_I,
      day: 10,
    });
    expect(resolved('birthday', { month: 'ADAR_I', day: 10, year: 5784 }, 5786).hebrewDate).toEqual({
      year: 5786,
      month: ADAR_I,
      day: 10,
    });
  });

  it('born on 30 Adar I, observed on 1 Nisan in an ordinary year', () => {
    const result = resolved('birthday', { month: 'ADAR_I', day: 30, year: 5784 }, 5786);
    expect(result.hebrewDate).toEqual({ year: 5786, month: NISAN, day: 1 });
    expect(result.ruleApplied).toBe('ADAR_I_30_TO_1_NISAN');
    expect(result.ambiguities[0]?.code).toBe('ADAR_I_30_IN_ORDINARY_YEAR');
  });

  it('born on 30 Adar I, unchanged in a leap year', () => {
    expect(resolved('birthday', { month: 'ADAR_I', day: 30, year: 5784 }, 5787).hebrewDate).toEqual({
      year: 5787,
      month: ADAR_I,
      day: 30,
    });
  });
});

describe('Adar: yahrzeits', () => {
  it('died in Adar of an ordinary year, observed in Adar I of a leap year by default', () => {
    const result = resolved('yahrzeit', { month: 'ADAR', day: 10, year: 5785 }, 5787);
    expect(result.hebrewDate).toEqual({ year: 5787, month: ADAR_I, day: 10 });
    expect(result.ruleApplied).toBe('ADAR_ORDINARY_TO_ADAR_I');
  });

  it('always flags that case, because communities differ', () => {
    const result = resolved('yahrzeit', { month: 'ADAR', day: 10, year: 5785 }, 5787);
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0]?.code).toBe('ADAR_ORDINARY_IN_LEAP_YEAR');
    expect(result.ambiguities[0]?.alternative).toEqual({ year: 5787, month: ADAR_II, day: 10 });
    expect(result.ambiguities[0]?.explanation).toMatch(/consult your rabbi/i);
  });

  it('honours a stored convention selecting Adar II', () => {
    const result = resolved('yahrzeit', { month: 'ADAR', day: 10, year: 5785 }, 5787, {
      adarOrdinaryYahrzeitInLeapYear: 'adar_ii',
    });
    expect(result.hebrewDate).toEqual({ year: 5787, month: ADAR_II, day: 10 });
    expect(result.ambiguities[0]?.alternative).toEqual({ year: 5787, month: ADAR_I, day: 10 });
  });

  it('differs deliberately from the birthday rule for the same Hebrew date', () => {
    // The documented standard rules are asymmetric here. This test exists so
    // that the asymmetry can never be "fixed" by accident.
    const birthday = resolved('birthday', { month: 'ADAR', day: 10, year: 5785 }, 5787);
    const yahrzeit = resolved('yahrzeit', { month: 'ADAR', day: 10, year: 5785 }, 5787);
    expect(birthday.hebrewDate.month).toBe(ADAR_II);
    expect(yahrzeit.hebrewDate.month).toBe(ADAR_I);
  });

  it('died in Adar II, observed in the last month of the year', () => {
    expect(resolved('yahrzeit', { month: 'ADAR_II', day: 10, year: 5784 }, 5786).hebrewDate).toEqual(
      { year: 5786, month: ADAR_I, day: 10 },
    );
    expect(resolved('yahrzeit', { month: 'ADAR_II', day: 10, year: 5784 }, 5787).hebrewDate).toEqual(
      { year: 5787, month: ADAR_II, day: 10 },
    );
  });

  it('died on 30 Adar I, observed on 30 Shevat in an ordinary year', () => {
    const result = resolved('yahrzeit', { month: 'ADAR_I', day: 30, year: 5784 }, 5786);
    expect(result.hebrewDate).toEqual({ year: 5786, month: SHVAT, day: 30 });
    expect(result.ruleApplied).toBe('ADAR_I_30_TO_30_SHVAT');
    // The birthday rule for the very same origin gives 1 Nisan instead.
    expect(resolved('birthday', { month: 'ADAR_I', day: 30, year: 5784 }, 5786).hebrewDate).toEqual({
      year: 5786,
      month: NISAN,
      day: 1,
    });
  });
});

describe('30 Cheshvan', () => {
  it('birthday moves to 1 Kislev in a year with a 29-day Cheshvan', () => {
    // 5784 and 5786 have a short Cheshvan; 5785 and 5788 have a long one.
    const short = resolved('birthday', { month: 'CHESHVAN', day: 30, year: 5783 }, 5786);
    expect(short.hebrewDate).toEqual({ year: 5786, month: KISLEV, day: 1 });
    expect(short.ruleApplied).toBe('CHESHVAN_30_TO_1_KISLEV');
    expect(short.ambiguities[0]?.code).toBe('MISSING_30TH_DAY');

    const long = resolved('birthday', { month: 'CHESHVAN', day: 30, year: 5783 }, 5785);
    expect(long.hebrewDate).toEqual({ year: 5785, month: CHESHVAN, day: 30 });
    expect(long.ambiguities).toEqual([]);
  });

  it('yahrzeit uses the last day of Cheshvan when the first anniversary year was short', () => {
    // Died 30 Cheshvan 5783; Cheshvan 5784 has only 29 days, so the observance
    // is anchored to the last day of Cheshvan rather than to 1 Kislev.
    const short = resolved('yahrzeit', { month: 'CHESHVAN', day: 30, year: 5783 }, 5786);
    expect(short.hebrewDate).toEqual({ year: 5786, month: CHESHVAN, day: 29 });
    expect(short.ruleApplied).toBe('CHESHVAN_30_TO_LAST_DAY_OF_CHESHVAN');

    const long = resolved('yahrzeit', { month: 'CHESHVAN', day: 30, year: 5783 }, 5785);
    expect(long.hebrewDate).toEqual({ year: 5785, month: CHESHVAN, day: 30 });
  });

  it('refuses to guess a 30 Cheshvan yahrzeit with no Hebrew year of death', () => {
    const result = resolveAnniversary({
      kind: 'yahrzeit',
      origin: { month: 'CHESHVAN', day: 30 },
      targetHebrewYear: 5786,
    });
    expect(result.status).toBe('needs_user_decision');
    if (result.status !== 'needs_user_decision') return;
    expect(result.code).toBe('YAHRZEIT_30TH_REQUIRES_ORIGIN_YEAR');
    expect(result.options).toHaveLength(2);
  });

  it('still resolves a 30 Cheshvan birthday with no Hebrew year of birth', () => {
    // Unlike the yahrzeit rule, the birthday rule does not depend on the
    // character of the year after the origin.
    const result = resolved('birthday', { month: 'CHESHVAN', day: 30 }, 5786);
    expect(result.hebrewDate).toEqual({ year: 5786, month: KISLEV, day: 1 });
  });
});

describe('30 Kislev', () => {
  it('birthday moves to 1 Tevet in a year with a 29-day Kislev', () => {
    // 5790 has a 29-day Kislev; 5788 has a 30-day Kislev.
    const short = resolved('birthday', { month: 'KISLEV', day: 30, year: 5785 }, 5790);
    expect(short.hebrewDate).toEqual({ year: 5790, month: TEVET, day: 1 });
    expect(short.ruleApplied).toBe('KISLEV_30_TO_1_TEVET');

    const long = resolved('birthday', { month: 'KISLEV', day: 30, year: 5785 }, 5788);
    expect(long.hebrewDate).toEqual({ year: 5788, month: KISLEV, day: 30 });
  });

  it('yahrzeit uses the last day of Kislev when the first anniversary year was short', () => {
    // Died 30 Kislev 5789; Kislev 5790 has 29 days.
    const result = resolved('yahrzeit', { month: 'KISLEV', day: 30, year: 5789 }, 5793);
    expect(result.hebrewDate).toEqual({ year: 5793, month: KISLEV, day: 29 });
    expect(result.ruleApplied).toBe('KISLEV_30_TO_LAST_DAY_OF_KISLEV');
  });

  it('refuses to guess a 30 Kislev yahrzeit with no Hebrew year of death', () => {
    const result = resolveAnniversary({
      kind: 'yahrzeit',
      origin: { month: 'KISLEV', day: 30 },
      targetHebrewYear: 5790,
    });
    expect(result.status).toBe('needs_user_decision');
  });
});

describe('input validation', () => {
  it('rejects a month that cannot exist in the stated year', () => {
    // 5785 is an ordinary year, so it has no Adar II and no Adar I.
    expect(() => normaliseOrigin({ month: 'ADAR_II', day: 10, year: 5785 })).toThrow(
      InvalidOriginError,
    );
    expect(() => normaliseOrigin({ month: 'ADAR_I', day: 10, year: 5785 })).toThrow(
      InvalidOriginError,
    );
    // ...and 5784 is a leap year, so it has no plain "Adar".
    expect(() => normaliseOrigin({ month: 'ADAR', day: 10, year: 5784 })).toThrow(
      InvalidOriginError,
    );
  });

  it('rejects a day that does not exist in the stated month', () => {
    expect(() => normaliseOrigin({ month: 'CHESHVAN', day: 30, year: 5784 })).toThrow(
      InvalidOriginError,
    );
    expect(() => normaliseOrigin({ month: 'IYYAR', day: 30 })).toThrow(InvalidOriginError);
    expect(() => normaliseOrigin({ month: 'ADAR_II', day: 30 })).toThrow(InvalidOriginError);
    expect(() => normaliseOrigin({ month: 'NISAN', day: 31 })).toThrow(InvalidOriginError);
  });

  it('accepts a 30th in months that can have one', () => {
    expect(() => normaliseOrigin({ month: 'CHESHVAN', day: 30 })).not.toThrow();
    expect(() => normaliseOrigin({ month: 'KISLEV', day: 30 })).not.toThrow();
    expect(() => normaliseOrigin({ month: 'ADAR_I', day: 30 })).not.toThrow();
  });

  it('rejects a yahrzeit target year that does not follow the death', () => {
    expect(() =>
      resolveAnniversary({
        kind: 'yahrzeit',
        origin: { month: 'NISAN', day: 10, year: 5785 },
        targetHebrewYear: 5785,
      }),
    ).toThrow(RangeError);
  });
});

/**
 * Differential test against @hebcal's own implementation of the same rules.
 * The engine re-implements them in order to support unknown origin years, to
 * report which rule fired, and to refuse undecidable cases - but for every
 * input @hebcal can also handle, the answers must be identical.
 */
describe('agreement with @hebcal for known origin years', () => {
  const originMonths: HebrewMonthName[] = [
    'TISHREI',
    'CHESHVAN',
    'KISLEV',
    'TEVET',
    'SHVAT',
    'NISAN',
    'IYYAR',
    'SIVAN',
    'TAMUZ',
    'AV',
    'ELUL',
  ];

  it('matches getBirthdayHD and getYahrzeitHD across 20 origin years and 20 target years', () => {
    let compared = 0;
    for (let originYear = 5775; originYear < 5795; originYear++) {
      const monthNames: HebrewMonthName[] = [
        ...originMonths,
        ...(isLeapYear(originYear) ? (['ADAR_I', 'ADAR_II'] as const) : (['ADAR'] as const)),
      ];
      for (const month of monthNames) {
        for (const day of [1, 15, 29, 30]) {
          let origin: AnniversaryOrigin;
          try {
            origin = { month, day, year: originYear };
            normaliseOrigin(origin);
          } catch {
            continue; // day does not exist in that month
          }
          for (let targetYear = originYear + 1; targetYear < originYear + 21; targetYear++) {
            const monthNumber = normaliseOrigin(origin).month;
            // @hebcal mutates the object it is given, so pass a fresh copy.
            const expectedBirthday = getBirthdayHD(targetYear, {
              yy: originYear,
              mm: monthNumber,
              dd: day,
            });
            const expectedYahrzeit = getYahrzeitHD(targetYear, {
              yy: originYear,
              mm: monthNumber,
              dd: day,
            });

            const actualBirthday = resolved('birthday', origin, targetYear).hebrewDate;
            expect(
              { y: actualBirthday.year, m: actualBirthday.month, d: actualBirthday.day },
              `birthday ${day} ${month} ${originYear} -> ${targetYear}`,
            ).toEqual({ y: expectedBirthday!.yy, m: expectedBirthday!.mm, d: expectedBirthday!.dd });

            const actualYahrzeit = resolved('yahrzeit', origin, targetYear).hebrewDate;
            expect(
              { y: actualYahrzeit.year, m: actualYahrzeit.month, d: actualYahrzeit.day },
              `yahrzeit ${day} ${month} ${originYear} -> ${targetYear}`,
            ).toEqual({ y: expectedYahrzeit!.yy, m: expectedYahrzeit!.mm, d: expectedYahrzeit!.dd });
            compared += 2;
          }
        }
      }
    }
    // Guard against the loops silently skipping everything.
    expect(compared).toBeGreaterThan(8000);
  });
});

describe('resolved dates always exist', () => {
  it('never produces a Hebrew date that is not on the calendar', () => {
    const cases: AnniversaryOrigin[] = [
      { month: 'CHESHVAN', day: 30 },
      { month: 'KISLEV', day: 30 },
      { month: 'ADAR_I', day: 30, year: 5784 },
      { month: 'ADAR', day: 29, year: 5785 },
      { month: 'ADAR_II', day: 29, year: 5784 },
      { month: 'NISAN', day: 30 },
    ];
    for (const origin of cases) {
      for (let year = 5786; year < 5826; year++) {
        for (const kind of ['birthday', 'yahrzeit'] as const) {
          const result = resolveAnniversary({ kind, origin, targetHebrewYear: year });
          if (result.status !== 'resolved') continue;
          const { hebrewDate } = result;
          expect(hebrewDate.year).toBe(year);
          expect(hebrewDate.day).toBeGreaterThanOrEqual(1);
          expect(hebrewDate.day).toBeLessThanOrEqual(30);
          expect(hebrewDate.month).toBeLessThanOrEqual(isLeapYear(year) ? 13 : 12);
        }
      }
    }
  });
});
