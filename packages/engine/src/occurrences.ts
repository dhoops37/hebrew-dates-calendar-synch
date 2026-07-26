/**
 * Occurrence resolution: turning one source record into N dated, individually
 * addressable Hebrew anniversaries.
 *
 * **This layer knows nothing about location.** A Hebrew anniversary falls on a
 * particular Hebrew date and therefore a particular Gregorian day, and neither
 * of those depends on where the observer is. Only the *times* do — sunset in
 * Jerusalem is not sunset in Melbourne — and those live one layer out, in
 * `destinations.ts`.
 *
 * That split is what lets one family dataset serve several members' calendars
 * in different cities: one set of occurrences, several sets of events, and the
 * Hebrew-date reasoning happening exactly once. See docs/DATA-MODEL.md §5.
 *
 * Explicitly *not* a recurrence rule. A Hebrew date does not recur on a
 * Gregorian cycle, so every occurrence is materialised with its own Hebrew year
 * and its own stable identifier (PRD "Instructions to the Coding Agent").
 */
import {
  resolveAnniversary,
  type AnniversaryResolution,
  normaliseOrigin,
} from './anniversary';
import {
  absoluteToCivil,
  absoluteToHebrew,
  civilToAbsolute,
  hebrewToAbsolute,
} from './hebrewCalendar';
import { hebrewDateLabels, type HebrewDateLabels } from './format';
import { occurrenceKey } from './ids';
import { sunsetOn } from './sunset';
import { CALCULATION_VERSION } from './version';
import type {
  Ambiguity,
  AnniversaryOrigin,
  CalculationConventions,
  CalculationLocation,
  CivilDate,
  DecisionRequired,
  HebrewDate,
  RuleId,
  SourceRecordType,
} from './types';

/**
 * One Hebrew anniversary in one Hebrew year. Location-independent: no times, no
 * time zone, no location snapshot.
 */
export interface HebrewOccurrence {
  /** Deterministic key: sha256(sourceRecordId, hebrewYear, sequence). */
  key: string;
  sourceRecordId: string;
  hebrewYear: number;
  /**
   * Which observance this is within its Hebrew year. 0 unless the record's
   * convention observes the date twice, as with both Adars of a leap year.
   */
  sequence: number;
  hebrewDate: HebrewDate;
  labels: HebrewDateLabels;
  /** The Gregorian day on which the Hebrew date's daytime falls. */
  gregorianDate: CivilDate;
  /** The Gregorian day whose sunset begins the Hebrew date. */
  precedingGregorianDate: CivilDate;
  /** The day after the Hebrew date's daytime; the exclusive all-day end. */
  followingGregorianDate: CivilDate;
  ruleApplied: RuleId;
  ambiguities: Ambiguity[];
  isManualOverride: boolean;
  calculationVersion: string;
}

export interface ResolveOccurrencesInput {
  /** Stable identifier of the source record. Feeds every derived identifier. */
  sourceRecordId: string;
  type: SourceRecordType;
  origin: AnniversaryOrigin;
  /**
   * How many future Hebrew *years* to materialise. The MVP horizon is 20.
   * Not a count of occurrences: a record observed in both Adars produces two
   * occurrences in a leap year while still covering one year of the horizon.
   */
  count: number;
  /**
   * The earliest Hebrew date to include. Anything before it has already passed.
   *
   * Passed in rather than derived, because "has today's occurrence finished?" is
   * a sunset question and therefore a per-location one. `currentHebrewDateAt`
   * computes it for a given location; a shared dataset uses one anchor location
   * and each destination still renders its own times.
   */
  from: HebrewDate;
  conventions?: CalculationConventions;
  /** Per-year manual overrides, keyed by Hebrew year (PRD 17.1). */
  overrides?: Record<number, HebrewDate>;
}

export interface ResolveOccurrencesResult {
  status: 'ok';
  occurrences: HebrewOccurrence[];
  /**
   * How many future Hebrew years were materialised. This is the number the
   * dashboard reports and the rolling-horizon job checks, and it can be smaller
   * than `occurrences.length` when a year holds two observances.
   */
  hebrewYearsGenerated: number;
  /** True when any occurrence carries an ambiguity the user should review. */
  requiresReview: boolean;
}

export type ResolveOccurrencesOutcome =
  | ResolveOccurrencesResult
  | DecisionRequired<HebrewDate>;

/**
 * The Hebrew date currently in effect at a location.
 * Sunset-aware: after sunset the Hebrew date, and possibly the Hebrew year,
 * has already advanced.
 */
export function currentHebrewDateAt(
  location: CalculationLocation,
  nowEpochMs: number,
): HebrewDate {
  const civilToday = civilDateInZone(nowEpochMs, location.timezoneId);
  const sunset = sunsetOn(location, civilToday);
  const abs = civilToAbsolute(civilToday);
  // After sunset the Hebrew day - and possibly the Hebrew year - has advanced.
  // Where the sun does not set, fall back to the civil day.
  const afterSunset = sunset.status === 'ok' && nowEpochMs >= sunset.epochMs;
  return absoluteToHebrew(abs + (afterSunset ? 1 : 0));
}

/** The civil date currently in effect in an IANA zone. */
export function civilDateInZone(epochMs: number, timezoneId: string): CivilDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneId,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Resolve the next `count` Hebrew years of a record into individual occurrences.
 * Pure and location-free.
 */
export function resolveOccurrences(
  input: ResolveOccurrencesInput,
): ResolveOccurrencesOutcome {
  if (!Number.isInteger(input.count) || input.count < 1) {
    throw new RangeError(`count must be a positive integer, received ${input.count}`);
  }
  const kind = input.type === 'birthday' ? 'birthday' : 'yahrzeit';
  const origin = normaliseOrigin(input.origin);
  const fromAbs = hebrewToAbsolute(input.from);

  const occurrences: HebrewOccurrence[] = [];
  let yearsWithOccurrences = 0;
  // Guard against pathological inputs looping forever.
  const maxYearsScanned = input.count + 5;

  for (
    let scanned = 0;
    yearsWithOccurrences < input.count && scanned < maxYearsScanned;
    scanned++
  ) {
    const targetYear = input.from.year + scanned;
    if (origin.year !== undefined) {
      if (kind === 'birthday' && targetYear < origin.year) continue;
      if (kind === 'yahrzeit' && targetYear <= origin.year) continue;
    }

    const override = input.overrides?.[targetYear];
    let resolution: AnniversaryResolution;
    if (override) {
      // A manual override replaces every observance in that Hebrew year with
      // the single date the user chose.
      resolution = {
        status: 'resolved',
        dates: [
          { hebrewDate: override, sequence: 0, ruleApplied: 'SAME_MONTH_AND_DAY', ambiguities: [] },
        ],
        hebrewDate: override,
        ruleApplied: 'SAME_MONTH_AND_DAY',
        ambiguities: [],
      };
    } else {
      resolution = resolveAnniversary({
        kind,
        origin: input.origin,
        targetHebrewYear: targetYear,
        ...(input.conventions ? { conventions: input.conventions } : {}),
      });
      if (resolution.status === 'needs_user_decision') return resolution;
    }

    let addedThisYear = 0;
    for (const date of resolution.dates) {
      // Skip an observance that has already passed at the anchor location.
      if (hebrewToAbsolute(date.hebrewDate) < fromAbs) continue;
      occurrences.push(
        buildHebrewOccurrence({
          sourceRecordId: input.sourceRecordId,
          hebrewDate: date.hebrewDate,
          sequence: date.sequence,
          ruleApplied: date.ruleApplied,
          ambiguities: date.ambiguities,
          isManualOverride: Boolean(override),
        }),
      );
      addedThisYear++;
    }
    if (addedThisYear > 0) yearsWithOccurrences++;
  }

  // Two observances in one Hebrew year are resolved in calendar order, but a
  // year boundary could still interleave them; sort so the caller always sees
  // chronological order.
  occurrences.sort((a, b) => civilToAbsolute(a.gregorianDate) - civilToAbsolute(b.gregorianDate));

  return {
    status: 'ok',
    occurrences,
    hebrewYearsGenerated: yearsWithOccurrences,
    requiresReview: occurrences.some((o) => o.ambiguities.length > 0),
  };
}

function buildHebrewOccurrence(args: {
  sourceRecordId: string;
  hebrewDate: HebrewDate;
  sequence: number;
  ruleApplied: RuleId;
  ambiguities: Ambiguity[];
  isManualOverride: boolean;
}): HebrewOccurrence {
  const { sourceRecordId, hebrewDate, sequence, ruleApplied, ambiguities, isManualOverride } = args;
  const abs = hebrewToAbsolute(hebrewDate);
  return {
    key: occurrenceKey({ sourceRecordId, hebrewYear: hebrewDate.year, sequence }),
    sourceRecordId,
    hebrewYear: hebrewDate.year,
    sequence,
    hebrewDate,
    labels: hebrewDateLabels(hebrewDate),
    gregorianDate: absoluteToCivil(abs),
    precedingGregorianDate: absoluteToCivil(abs - 1),
    followingGregorianDate: absoluteToCivil(abs + 1),
    ruleApplied,
    ambiguities,
    isManualOverride,
    calculationVersion: CALCULATION_VERSION,
  };
}
