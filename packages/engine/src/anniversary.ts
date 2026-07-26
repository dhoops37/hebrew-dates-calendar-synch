/**
 * Hebrew anniversary rules for birthdays and yahrzeits.
 *
 * The rules are those documented in Reingold & Dershowitz, *Calendrical
 * Calculations* (pp. 111 and 113), which is also what @hebcal implements. They
 * are re-implemented here rather than delegated, for three reasons:
 *
 *  1. The engine must support a record with **no origin Hebrew year** (PRD 16.1
 *     allows omitting it). @hebcal's `getBirthdayHD` / `getYahrzeitHD` both
 *     require one, and derive "was the origin year a leap year" from it. Here
 *     that fact comes from the user's explicit Adar choice instead.
 *  2. The engine must report *which* rule fired and *what the alternative is*,
 *     so the UI can warn and offer an override (PRD 5.4, 17.1, 17.2).
 *  3. The engine must be able to refuse. Two yahrzeit branches depend on the
 *     character of the year *after* the death; without the origin year those
 *     are genuinely undecidable and are returned as a decision request rather
 *     than guessed.
 *
 * The known-origin-year path is differential-tested against @hebcal in
 * test/anniversary.test.ts, so any divergence from the reference
 * implementation fails the build.
 *
 * ## The rules, stated plainly
 *
 * Birthday (Calendrical Calculations p. 111):
 *   B1. Born in Adar of an ordinary year, or Adar II of a leap year ->
 *       the anniversary is in the *last* month of the target year
 *       (Adar in an ordinary year, Adar II in a leap year).
 *   B2. Born 30 Cheshvan, target year's Cheshvan has 29 days -> 1 Kislev.
 *   B3. Born 30 Kislev, target year's Kislev has 29 days -> 1 Tevet.
 *   B4. Born 30 Adar I, target year is ordinary -> 1 Nisan.
 *   B5. Otherwise the same month number and day. (Born in Adar I of a leap
 *       year, in an ordinary target year, therefore falls in Adar.)
 *
 * Yahrzeit (Calendrical Calculations p. 113):
 *   Y1. Died 30 Cheshvan and the *first* anniversary year had a 29-day
 *       Cheshvan -> the last day of Cheshvan in the target year.
 *   Y2. Died 30 Kislev and the *first* anniversary year had a 29-day
 *       Kislev -> the last day of Kislev in the target year.
 *   Y3. Died in Adar II -> the last month of the target year.
 *   Y4. Died 30 Adar I, target year is ordinary -> 30 Shvat.
 *   Y5. Otherwise the same month number and day, then, if that day does not
 *       exist (30 Cheshvan / 30 Kislev in a short year), the 1st of the
 *       following month.
 *
 * Note the deliberate asymmetry in Y5 vs B1: someone who *died* in Adar of an
 * ordinary year has a yahrzeit in **Adar I** of a leap year, while someone
 * *born* in Adar of an ordinary year has a birthday in **Adar II**. This is the
 * documented standard rule, and it is also a live halachic dispute, so the
 * engine flags it every time it fires.
 */
import {
  HEBREW_MONTH_NUMBER,
  type Ambiguity,
  type AnniversaryKind,
  type AnniversaryOrigin,
  type CalculationConventions,
  type DecisionRequired,
  type HebrewDate,
  type HebrewMonthName,
  type HebrewMonthNumber,
  type RuleId,
} from './types';
import { DEFAULT_CONVENTIONS } from './types';
import {
  daysInMonth,
  isLeapYear,
  isLongCheshvan,
  isShortKislev,
  lastMonthOfYear,
  monthNumberForName,
  originYearLeapnessImpliedBy,
} from './hebrewCalendar';

const { CHESHVAN, KISLEV, TEVET, SHVAT, NISAN, ADAR_I, ADAR_II } = HEBREW_MONTH_NUMBER;

/** Months that are 29 days long in every Hebrew year. */
const MONTHS_NEVER_HAVING_30_DAYS = new Set<HebrewMonthName>([
  'IYYAR',
  'TAMUZ',
  'ELUL',
  'TEVET',
  'ADAR',
  'ADAR_II',
]);

export interface ResolveAnniversaryInput {
  kind: AnniversaryKind;
  origin: AnniversaryOrigin;
  targetHebrewYear: number;
  conventions?: CalculationConventions;
}

export interface ResolvedAnniversary {
  status: 'resolved';
  hebrewDate: HebrewDate;
  ruleApplied: RuleId;
  ambiguities: Ambiguity[];
}

export type AnniversaryResolution = ResolvedAnniversary | DecisionRequired<HebrewDate>;

export class InvalidOriginError extends Error {}

/** Normalised view of an origin, with the leap-ness of its year pinned down. */
interface NormalisedOrigin {
  month: HebrewMonthNumber;
  day: number;
  year?: number;
  /** Whether the origin year was a leap year. Always known for Adar dates. */
  originYearIsLeap?: boolean;
}

export function normaliseOrigin(origin: AnniversaryOrigin): NormalisedOrigin {
  if (!Number.isInteger(origin.day) || origin.day < 1 || origin.day > 30) {
    throw new InvalidOriginError(`Hebrew day ${origin.day} is out of range (1-30)`);
  }
  const month = monthNumberForName(origin.month);
  const impliedLeap = originYearLeapnessImpliedBy(origin.month);

  if (origin.year !== undefined) {
    const actualLeap = isLeapYear(origin.year);
    if (impliedLeap !== undefined && impliedLeap !== actualLeap) {
      throw new InvalidOriginError(
        `${origin.month} cannot occur in Hebrew year ${origin.year}, which is ` +
          `${actualLeap ? 'a leap year' : 'an ordinary year'}`,
      );
    }
    if (origin.day > daysInMonth(month, origin.year)) {
      throw new InvalidOriginError(
        `${origin.month} ${origin.year} has only ${daysInMonth(month, origin.year)} days`,
      );
    }
    return { month, day: origin.day, year: origin.year, originYearIsLeap: actualLeap };
  }

  // Without a year, a 30th is only possible in months that can have 30 days.
  // Cheshvan and Kislev vary; Iyyar, Tamuz, Elul, Tevet, Adar (ordinary) and
  // Adar II never do.
  if (origin.day === 30 && MONTHS_NEVER_HAVING_30_DAYS.has(origin.month)) {
    throw new InvalidOriginError(`${origin.month.replace('_', ' ')} never has 30 days`);
  }
  return { month, day: origin.day, originYearIsLeap: impliedLeap };
}

/**
 * Was the origin month "plain Adar", i.e. Adar of an ordinary year?
 * This is the case the Adar rules key off, and it is exactly why the month is
 * named rather than numbered at the boundary.
 */
function isOrdinaryAdar(o: NormalisedOrigin): boolean {
  return o.month === ADAR_I && o.originYearIsLeap === false;
}

function isAdarI(o: NormalisedOrigin): boolean {
  return o.month === ADAR_I && o.originYearIsLeap === true;
}

export function resolveAnniversary(input: ResolveAnniversaryInput): AnniversaryResolution {
  const origin = normaliseOrigin(input.origin);
  const conventions = input.conventions ?? DEFAULT_CONVENTIONS;
  const year = input.targetHebrewYear;

  if (!Number.isInteger(year) || year < 1) {
    throw new RangeError(`Target Hebrew year ${year} is not valid`);
  }
  if (origin.year !== undefined) {
    if (input.kind === 'birthday' && year < origin.year) {
      throw new RangeError(`Birthday target year ${year} precedes origin year ${origin.year}`);
    }
    if (input.kind === 'yahrzeit' && year <= origin.year) {
      throw new RangeError(
        `Yahrzeit target year ${year} does not follow year of death ${origin.year}`,
      );
    }
  }

  return input.kind === 'birthday'
    ? resolveBirthday(origin, year)
    : resolveYahrzeit(origin, year, conventions);
}

function resolveBirthday(origin: NormalisedOrigin, year: number): AnniversaryResolution {
  const targetIsLeap = isLeapYear(year);
  const ambiguities: Ambiguity[] = [];

  // B1: Adar (ordinary origin) or Adar II -> last month of the target year.
  if (isOrdinaryAdar(origin) || origin.month === ADAR_II) {
    const month = lastMonthOfYear(year);
    const applied: HebrewDate = { year, month, day: origin.day };
    if (isOrdinaryAdar(origin) && targetIsLeap) {
      ambiguities.push({
        code: 'ADAR_ORDINARY_IN_LEAP_YEAR',
        applied,
        alternative: { year, month: ADAR_I, day: origin.day },
        explanation:
          'This birthday is in Adar, and this Hebrew year has two Adars. ' +
          'The standard calendar convention observes it in Adar II. ' +
          'Some families observe it in Adar I.',
      });
    }
    return {
      status: 'resolved',
      hebrewDate: applied,
      ruleApplied: isOrdinaryAdar(origin)
        ? targetIsLeap
          ? 'ADAR_ORDINARY_TO_ADAR_II'
          : 'SAME_MONTH_AND_DAY'
        : 'ADAR_TO_LAST_MONTH_OF_YEAR',
      ambiguities,
    };
  }

  // B2 / B3: a 30th that does not exist in the target year moves to the 1st of
  // the following month.
  if (origin.month === CHESHVAN && origin.day === 30 && !isLongCheshvan(year)) {
    const applied: HebrewDate = { year, month: KISLEV, day: 1 };
    return {
      status: 'resolved',
      hebrewDate: applied,
      ruleApplied: 'CHESHVAN_30_TO_1_KISLEV',
      ambiguities: [missing30th(applied, 'Cheshvan', { year, month: CHESHVAN, day: 29 })],
    };
  }
  if (origin.month === KISLEV && origin.day === 30 && isShortKislev(year)) {
    const applied: HebrewDate = { year, month: TEVET, day: 1 };
    return {
      status: 'resolved',
      hebrewDate: applied,
      ruleApplied: 'KISLEV_30_TO_1_TEVET',
      ambiguities: [missing30th(applied, 'Kislev', { year, month: KISLEV, day: 29 })],
    };
  }

  // B4: 30 Adar I in an ordinary year -> 1 Nisan.
  if (isAdarI(origin) && origin.day === 30 && !targetIsLeap) {
    const applied: HebrewDate = { year, month: NISAN, day: 1 };
    return {
      status: 'resolved',
      hebrewDate: applied,
      ruleApplied: 'ADAR_I_30_TO_1_NISAN',
      ambiguities: [
        {
          code: 'ADAR_I_30_IN_ORDINARY_YEAR',
          applied,
          alternative: { year, month: SHVAT, day: 30 },
          explanation:
            'This birthday is on 30 Adar I, and this Hebrew year has only one Adar, ' +
            'with 29 days. The standard convention for a birthday moves it to 1 Nisan. ' +
            'The corresponding yahrzeit rule instead uses 30 Shevat.',
        },
      ],
    };
  }

  // B5: same month number and day.
  return {
    status: 'resolved',
    hebrewDate: { year, month: origin.month, day: origin.day },
    ruleApplied: 'SAME_MONTH_AND_DAY',
    ambiguities,
  };
}

function resolveYahrzeit(
  origin: NormalisedOrigin,
  year: number,
  conventions: CalculationConventions,
): AnniversaryResolution {
  const targetIsLeap = isLeapYear(year);

  // Y1 / Y2 depend on the character of the year *after* the death. Without the
  // origin year there is no defensible default, so the engine asks.
  const thirtiethOfVariableMonth =
    (origin.month === CHESHVAN || origin.month === KISLEV) && origin.day === 30;
  if (thirtiethOfVariableMonth && origin.year === undefined) {
    return requireOriginYearForYahrzeit(origin, year);
  }

  if (origin.month === CHESHVAN && origin.day === 30 && origin.year !== undefined) {
    if (!isLongCheshvan(origin.year + 1)) {
      // Y1: the last day of Cheshvan in the target year (29th or 30th).
      const day = daysInMonth(CHESHVAN, year);
      const applied: HebrewDate = { year, month: CHESHVAN, day };
      return {
        status: 'resolved',
        hebrewDate: applied,
        ruleApplied: 'CHESHVAN_30_TO_LAST_DAY_OF_CHESHVAN',
        ambiguities:
          day === 30
            ? []
            : [missing30th(applied, 'Cheshvan', { year, month: KISLEV, day: 1 })],
      };
    }
  }

  if (origin.month === KISLEV && origin.day === 30 && origin.year !== undefined) {
    if (isShortKislev(origin.year + 1)) {
      // Y2: the last day of Kislev in the target year (29th or 30th).
      const day = daysInMonth(KISLEV, year);
      const applied: HebrewDate = { year, month: KISLEV, day };
      return {
        status: 'resolved',
        hebrewDate: applied,
        ruleApplied: 'KISLEV_30_TO_LAST_DAY_OF_KISLEV',
        ambiguities:
          day === 30 ? [] : [missing30th(applied, 'Kislev', { year, month: TEVET, day: 1 })],
      };
    }
  }

  // Y3: died in Adar II -> last month of the target year.
  if (origin.month === ADAR_II) {
    return {
      status: 'resolved',
      hebrewDate: { year, month: lastMonthOfYear(year), day: origin.day },
      ruleApplied: 'ADAR_TO_LAST_MONTH_OF_YEAR',
      ambiguities: [],
    };
  }

  // Y4: died 30 Adar I, target year ordinary -> 30 Shevat.
  if (isAdarI(origin) && origin.day === 30 && !targetIsLeap) {
    const applied: HebrewDate = { year, month: SHVAT, day: 30 };
    return {
      status: 'resolved',
      hebrewDate: applied,
      ruleApplied: 'ADAR_I_30_TO_30_SHVAT',
      ambiguities: [
        {
          code: 'ADAR_I_30_IN_ORDINARY_YEAR',
          applied,
          alternative: { year, month: NISAN, day: 1 },
          explanation:
            'This yahrzeit is on 30 Adar I, and this Hebrew year has only one Adar, ' +
            'with 29 days. The standard convention moves it to 30 Shevat, the last ' +
            'day of the preceding month.',
        },
      ],
    };
  }

  // Died in Adar of an ordinary year, observed in a leap year: the standard
  // rule keeps the month number, which is Adar I. Widely disputed - flag it,
  // and honour a stored per-record convention.
  if (isOrdinaryAdar(origin) && targetIsLeap) {
    const useAdarII = conventions.adarOrdinaryYahrzeitInLeapYear === 'adar_ii';
    const month = useAdarII ? ADAR_II : ADAR_I;
    const applied: HebrewDate = { year, month, day: origin.day };
    return {
      status: 'resolved',
      hebrewDate: applied,
      ruleApplied: useAdarII ? 'ADAR_ORDINARY_TO_ADAR_II' : 'ADAR_ORDINARY_TO_ADAR_I',
      ambiguities: [
        {
          code: 'ADAR_ORDINARY_IN_LEAP_YEAR',
          applied,
          alternative: { year, month: useAdarII ? ADAR_I : ADAR_II, day: origin.day },
          explanation:
            'This yahrzeit is in Adar, and this Hebrew year has two Adars. ' +
            `Hebrew Dates is applying ${useAdarII ? 'Adar II' : 'Adar I'} for this record. ` +
            'Customs differ: some observe the other Adar, and some observe both. ' +
            'Please follow your family custom or consult your rabbi.',
        },
      ],
    };
  }

  // Y5: same month and day, then fall forward off a 30th that does not exist.
  if (origin.month === CHESHVAN && origin.day === 30 && !isLongCheshvan(year)) {
    const applied: HebrewDate = { year, month: KISLEV, day: 1 };
    return {
      status: 'resolved',
      hebrewDate: applied,
      ruleApplied: 'CHESHVAN_30_TO_1_KISLEV',
      ambiguities: [missing30th(applied, 'Cheshvan', { year, month: CHESHVAN, day: 29 })],
    };
  }
  if (origin.month === KISLEV && origin.day === 30 && isShortKislev(year)) {
    const applied: HebrewDate = { year, month: TEVET, day: 1 };
    return {
      status: 'resolved',
      hebrewDate: applied,
      ruleApplied: 'KISLEV_30_TO_1_TEVET',
      ambiguities: [missing30th(applied, 'Kislev', { year, month: KISLEV, day: 29 })],
    };
  }

  return {
    status: 'resolved',
    hebrewDate: { year, month: origin.month, day: origin.day },
    ruleApplied: 'SAME_MONTH_AND_DAY',
    ambiguities: [],
  };
}

function missing30th(
  applied: HebrewDate,
  monthLabel: string,
  alternative: HebrewDate,
): Ambiguity {
  return {
    code: 'MISSING_30TH_DAY',
    applied,
    alternative,
    explanation:
      `${monthLabel} has only 29 days in this Hebrew year, so there is no 30th. ` +
      'Hebrew Dates is applying the standard calendar convention shown above. ' +
      'Customs differ; please follow your family custom or consult your rabbi.',
  };
}

function requireOriginYearForYahrzeit(
  origin: NormalisedOrigin,
  year: number,
): DecisionRequired<HebrewDate> {
  const monthLabel = origin.month === CHESHVAN ? 'Cheshvan' : 'Kislev';
  const followingMonth = origin.month === CHESHVAN ? KISLEV : TEVET;
  const lastDayThisYear = daysInMonth(origin.month, year);
  return {
    status: 'needs_user_decision',
    code: 'YAHRZEIT_30TH_REQUIRES_ORIGIN_YEAR',
    question: `Which Hebrew year was the death in 30 ${monthLabel}?`,
    explanation:
      `${monthLabel} has either 29 or 30 days depending on the year. For a yahrzeit ` +
      `on 30 ${monthLabel}, the observed date depends on the character of the Hebrew ` +
      'year immediately after the death, so Hebrew Dates cannot calculate it without ' +
      'the Hebrew year of death. Please supply the year, or choose an observance below.',
    options: [
      {
        id: 'last_day_of_month',
        label: `Last day of ${monthLabel} (${lastDayThisYear} ${monthLabel})`,
        value: { year, month: origin.month, day: lastDayThisYear },
      },
      {
        id: 'first_of_following_month',
        label: `1 ${followingMonth === KISLEV ? 'Kislev' : 'Tevet'} in short years`,
        value: { year, month: followingMonth, day: 1 },
      },
    ],
  };
}
