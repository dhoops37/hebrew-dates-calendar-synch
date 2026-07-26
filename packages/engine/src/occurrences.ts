/**
 * Occurrence generation: turning one source record into N dated, timed,
 * individually addressable calendar occurrences.
 *
 * Explicitly *not* a recurrence rule. A Hebrew date does not recur on a
 * Gregorian cycle, so every occurrence is materialised with its own Hebrew
 * year, its own Gregorian dates, its own sunset instants and its own stable
 * identifier (PRD "Instructions to the Coding Agent").
 *
 * Exact Sunset Mode, per PRD 14.1:
 *   start = sunset on the Gregorian day *before* the Hebrew date's daytime
 *   end   = sunset on the Gregorian day *of* the Hebrew date's daytime
 *
 * Two-Day All-Day Mode, per PRD 14.2: one all-day event covering both of those
 * Gregorian days. `endDateExclusive` is the day after the second one, because
 * both RFC 5545 and the Google Calendar API treat an all-day end date as
 * exclusive - an off-by-one here shows up as a visibly wrong calendar.
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
  formatCivilDate,
  hebrewToAbsolute,
} from './hebrewCalendar';
import { hebrewDateLabels, type HebrewDateLabels } from './format';
import { contentHash, googleEventId, occurrenceKey } from './ids';
import { sunsetOn } from './sunset';
import { eventDescription, eventTitle } from './eventContent';
import { CALCULATION_VERSION } from './version';
import type {
  Ambiguity,
  AnniversaryOrigin,
  CalculationConventions,
  CalculationLocation,
  CivilDate,
  DecisionRequired,
  DisplayMode,
  HebrewDate,
  RuleId,
  SourceRecordType,
  SunsetResult,
} from './types';

export interface GenerateOccurrencesInput {
  /** Stable identifier of the source record. Feeds every derived identifier. */
  sourceRecordId: string;
  type: SourceRecordType;
  displayName: string;
  origin: AnniversaryOrigin;
  location: CalculationLocation;
  displayMode: DisplayMode;
  /** How many future Hebrew years to materialise. The MVP horizon is 20. */
  count: number;
  /** Injected for testability; defaults to the current time. */
  nowEpochMs?: number;
  conventions?: CalculationConventions;
  notes?: string;
  customTitle?: string;
  /** Per-year manual overrides, keyed by Hebrew year (PRD 17.1). */
  overrides?: Record<number, HebrewDate>;
}

export interface Occurrence {
  /** Deterministic key: sha256(sourceRecordId, hebrewYear, sequence). */
  key: string;
  /** Deterministic Google Calendar event ID derived from `key`. */
  googleEventId: string;
  hebrewYear: number;
  hebrewDate: HebrewDate;
  labels: HebrewDateLabels;
  /** The Gregorian day on which the Hebrew date's daytime falls. */
  gregorianDate: CivilDate;
  /** The Gregorian day whose sunset begins the Hebrew date. */
  precedingGregorianDate: CivilDate;
  start: SunsetResult;
  end: SunsetResult;
  /** Present only when both sunsets resolved. */
  timing: {
    startIso: string;
    endIso: string;
    startEpochMs: number;
    endEpochMs: number;
    durationMinutes: number;
  } | null;
  allDay: {
    /** Inclusive first day, "YYYY-MM-DD". */
    startDate: string;
    /** Exclusive end, "YYYY-MM-DD" - the day *after* the last covered day. */
    endDateExclusive: string;
  };
  title: string;
  description: string;
  ruleApplied: RuleId;
  ambiguities: Ambiguity[];
  isManualOverride: boolean;
  calculationVersion: string;
  contentHash: string;
  /** Copy of the location as used, so a later location change is detectable. */
  locationSnapshot: CalculationLocation;
  /** Set when the sun does not set at this location on these days. */
  warnings: OccurrenceWarning[];
}

export type OccurrenceWarning =
  | { code: 'NO_SUNSET'; message: string }
  | { code: 'AMBIGUOUS_HEBREW_DATE'; message: string };

export interface GenerateOccurrencesResult {
  status: 'ok';
  occurrences: Occurrence[];
  /** True when any occurrence carries an ambiguity the user should review. */
  requiresReview: boolean;
}

export type GenerateOccurrencesOutcome =
  | GenerateOccurrencesResult
  | DecisionRequired<HebrewDate>;

/**
 * The Hebrew year to start searching from, given "now" at a location.
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

export function generateOccurrences(
  input: GenerateOccurrencesInput,
): GenerateOccurrencesOutcome {
  if (!Number.isInteger(input.count) || input.count < 1) {
    throw new RangeError(`count must be a positive integer, received ${input.count}`);
  }
  const nowEpochMs = input.nowEpochMs ?? Date.now();
  const kind = input.type === 'birthday' ? 'birthday' : 'yahrzeit';
  const origin = normaliseOrigin(input.origin);
  const today = currentHebrewDateAt(input.location, nowEpochMs);
  const todayAbs = hebrewToAbsolute(today);

  const occurrences: Occurrence[] = [];
  let hebrewYear = today.year;
  // Guard against pathological inputs looping forever.
  const maxYearsScanned = input.count + 5;

  for (let scanned = 0; occurrences.length < input.count && scanned < maxYearsScanned; scanned++) {
    const targetYear = hebrewYear + scanned;
    if (origin.year !== undefined) {
      if (kind === 'birthday' && targetYear < origin.year) continue;
      if (kind === 'yahrzeit' && targetYear <= origin.year) continue;
    }

    const override = input.overrides?.[targetYear];
    let resolution: AnniversaryResolution;
    if (override) {
      resolution = {
        status: 'resolved',
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

    const hebrewDate = resolution.hebrewDate;
    const abs = hebrewToAbsolute(hebrewDate);
    // Skip an occurrence whose sunset-to-sunset window has already ended.
    if (abs < todayAbs) continue;

    occurrences.push(
      buildOccurrence({
        input,
        hebrewDate,
        ruleApplied: resolution.ruleApplied,
        ambiguities: resolution.ambiguities,
        isManualOverride: Boolean(override),
      }),
    );
  }

  return {
    status: 'ok',
    occurrences,
    requiresReview: occurrences.some((o) => o.ambiguities.length > 0),
  };
}

function buildOccurrence(args: {
  input: GenerateOccurrencesInput;
  hebrewDate: HebrewDate;
  ruleApplied: RuleId;
  ambiguities: Ambiguity[];
  isManualOverride: boolean;
}): Occurrence {
  const { input, hebrewDate, ruleApplied, ambiguities, isManualOverride } = args;
  const abs = hebrewToAbsolute(hebrewDate);
  const gregorianDate = absoluteToCivil(abs);
  const precedingGregorianDate = absoluteToCivil(abs - 1);
  const followingGregorianDate = absoluteToCivil(abs + 1);

  const start = sunsetOn(input.location, precedingGregorianDate);
  const end = sunsetOn(input.location, gregorianDate);

  const timing =
    start.status === 'ok' && end.status === 'ok'
      ? {
          startIso: start.iso,
          endIso: end.iso,
          startEpochMs: start.epochMs,
          endEpochMs: end.epochMs,
          durationMinutes: Math.round((end.epochMs - start.epochMs) / 60000),
        }
      : null;

  const allDay = {
    startDate: formatCivilDate(precedingGregorianDate),
    endDateExclusive: formatCivilDate(followingGregorianDate),
  };

  const contentInput = {
    type: input.type,
    displayName: input.displayName,
    hebrewDate,
    displayMode: input.displayMode,
    locationDisplayName: input.location.displayName,
    startIso: timing?.startIso ?? null,
    endIso: timing?.endIso ?? null,
    startDate: formatCivilDate(precedingGregorianDate),
    endDate: formatCivilDate(gregorianDate),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.customTitle ? { customTitle: input.customTitle } : {}),
  };

  const title = eventTitle(contentInput);
  const description = eventDescription(contentInput);

  const key = occurrenceKey({
    sourceRecordId: input.sourceRecordId,
    hebrewYear: hebrewDate.year,
  });

  const warnings: OccurrenceWarning[] = [];
  if (!timing) {
    warnings.push({
      code: 'NO_SUNSET',
      message:
        'The sun does not set at this location on these dates, so exact sunset times ' +
        'cannot be calculated. Use the two-day all-day display, or choose a different ' +
        'calculation location.',
    });
  }
  for (const ambiguity of ambiguities) {
    warnings.push({ code: 'AMBIGUOUS_HEBREW_DATE', message: ambiguity.explanation });
  }

  return {
    key,
    googleEventId: googleEventId(key),
    hebrewYear: hebrewDate.year,
    hebrewDate,
    labels: hebrewDateLabels(hebrewDate),
    gregorianDate,
    precedingGregorianDate,
    start,
    end,
    timing,
    allDay,
    title,
    description,
    ruleApplied,
    ambiguities,
    isManualOverride,
    calculationVersion: CALCULATION_VERSION,
    // Hashed over exactly what reaches the destination event, plus the display
    // mode and the times, so a location or mode change forces an update and
    // nothing else does.
    contentHash: contentHash({
      title,
      description,
      displayMode: input.displayMode,
      startIso: timing?.startIso ?? null,
      endIso: timing?.endIso ?? null,
      allDay,
      timezoneId: input.location.timezoneId,
      transparency: 'transparent',
      calculationVersion: CALCULATION_VERSION,
    }),
    locationSnapshot: { ...input.location },
    warnings,
  };
}
