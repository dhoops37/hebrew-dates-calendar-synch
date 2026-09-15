/**
 * The server-side boundary between the prototype UI and the calculation engine.
 *
 * All calculation happens here, on the server (PRD 13.4). The client sends a
 * plain request describing what the user typed; it receives a fully rendered
 * preview and never runs any calendar arithmetic itself. When the database
 * arrives in Phase 2 this module is where a source record gets read and
 * persisted; nothing in the engine or the UI has to change for that.
 */
import {
  generateOccurrences,
  getSeedLocation,
  interpretGregorianEntry,
  monthNumberForName,
  resolveAnniversary,
  confirmLocation,
  searchSeedLocations,
  selectableMonths,
  suggestLocationForTimezone,
  type AnniversaryOrigin,
  type CalculationLocation,
  type DisplayMode,
  type HebrewMonthName,
  type Occurrence,
  type SourceRecordType,
  type SunsetStatus,
} from '@hebrew-dates/engine';

export interface PreviewRequest {
  locationId: string;
  type: SourceRecordType;
  displayName: string;
  displayMode: DisplayMode;
  /**
   * Which Adar a yahrzeit falls in during a leap year. Defaults to `both`.
   * Stored per record in Phase 2; here it is per request.
   */
  adarConvention?: 'both' | 'adar_i' | 'adar_ii';
  /**
   * Whether the user has confirmed the calculation location. A suggested
   * location previews fine but is never treated as settled — the sync planner
   * refuses to write events for an unconfirmed one.
   */
  locationConfirmed?: boolean;
  /**
   * The destination calendar's own IANA zone. A display and suggestion hint
   * only; never an input to sunset. In Phase 2 this comes from Google's
   * `calendars.get`.
   */
  calendarTimezoneHint?: string;
  /** How the user described the date. */
  entryMode: 'hebrew' | 'gregorian';
  /** Hebrew entry. */
  hebrewMonth?: HebrewMonthName;
  hebrewDay?: number;
  hebrewYear?: number | null;
  /** Gregorian entry. */
  gregorianDate?: string;
  sunsetStatus?: SunsetStatus;
  count?: number;
  /** Overrides the clock in tests and demos. */
  nowEpochMs?: number;
}

export interface PreviewDecision {
  status: 'needs_user_decision';
  code: string;
  question: string;
  explanation: string;
  options: { id: string; label: string }[];
}

export interface PreviewOk {
  status: 'ok';
  location: CalculationLocation;
  origin: { month: HebrewMonthName; day: number; year?: number };
  interpretedFrom?: { gregorianDate: string; sunsetStatus: SunsetStatus; sunsetIso?: string };
  requiresReview: boolean;
  /** Hebrew years materialised, which is not occurrences.length when a year doubles. */
  hebrewYearsGenerated: number;
  occurrences: Occurrence[];
}

export interface PreviewError {
  status: 'error';
  message: string;
}

export type PreviewResponse = PreviewOk | PreviewDecision | PreviewError;

const MAX_COUNT = 50;

export function listLocations(query = ''): CalculationLocation[] {
  return searchSeedLocations(query, 25);
}

/**
 * Best guess at a calculation location from an IANA time zone.
 *
 * In Phase 2 the preferred source is the destination calendar's own zone, read
 * from the Google Calendar API once the account is connected. Until then - and
 * as the fallback for feed-only users - the browser's zone is the closest
 * available signal. Either way it is only a pre-selection: the resolved place
 * name is shown and can be changed, because one time zone spans enough
 * longitude for sunset to differ by more than half an hour.
 */
export function suggestLocation(
  timezoneId: string | undefined,
  source: 'timezone_suggestion' | 'calendar_timezone_hint' = 'timezone_suggestion',
) {
  return suggestLocationForTimezone(timezoneId, source);
}

export function listMonths(hebrewYear?: number): HebrewMonthName[] {
  return selectableMonths(hebrewYear);
}

export function buildPreview(request: PreviewRequest): PreviewResponse {
  const catalogueEntry = getSeedLocation(request.locationId);
  if (!catalogueEntry) {
    return { status: 'error', message: `Unknown location "${request.locationId}"` };
  }
  // A catalogue entry is a candidate. It only becomes a settled calculation
  // location once the user says so.
  const location: CalculationLocation = request.locationConfirmed
    ? confirmLocation(catalogueEntry)
    : { ...catalogueEntry, source: 'timezone_suggestion', confirmedByUser: false };

  const displayName = request.displayName.trim() || 'Untitled';
  const count = clamp(request.count ?? 20, 1, MAX_COUNT);

  let origin: AnniversaryOrigin;
  let interpretedFrom: PreviewOk['interpretedFrom'];

  if (request.entryMode === 'gregorian') {
    const parsed = parseIsoDate(request.gregorianDate);
    if (!parsed) {
      return { status: 'error', message: 'Enter a Gregorian date as YYYY-MM-DD.' };
    }
    const sunsetStatus = request.sunsetStatus ?? 'unknown';
    const interpretation = interpretGregorianEntry({
      gregorianDate: parsed,
      sunsetStatus,
      location,
    });
    // "I am not sure" stops here. The engine returns both candidate Hebrew
    // dates and the UI makes the user pick one (PRD 16.3).
    if (interpretation.status === 'needs_user_decision') {
      return toDecision(interpretation);
    }
    const { hebrewDate, monthName } = interpretation.interpretation;
    origin = { month: monthName, day: hebrewDate.day, year: hebrewDate.year };
    interpretedFrom = {
      gregorianDate: request.gregorianDate!,
      sunsetStatus,
      ...(interpretation.sunsetOnEnteredDate?.status === 'ok'
        ? { sunsetIso: interpretation.sunsetOnEnteredDate.iso }
        : {}),
    };
  } else {
    if (!request.hebrewMonth || !request.hebrewDay) {
      return { status: 'error', message: 'Choose a Hebrew month and day.' };
    }
    origin = {
      month: request.hebrewMonth,
      day: request.hebrewDay,
      ...(request.hebrewYear ? { year: request.hebrewYear } : {}),
    };
  }

  try {
    const result = generateOccurrences({
      // A real source record ID arrives from the database in Phase 2. For the
      // prototype it is derived from the record's identity so that the
      // generated keys are stable across page reloads, which is what makes the
      // "same keys on a repeat run" property visible in the UI.
      sourceRecordId: prototypeSourceRecordId(request, origin),
      type: request.type,
      displayName,
      origin,
      location,
      displayMode: request.displayMode,
      count,
      ...(request.nowEpochMs ? { nowEpochMs: request.nowEpochMs } : {}),
      ...(request.adarConvention
        ? { conventions: { adarOrdinaryYahrzeitInLeapYear: request.adarConvention } }
        : {}),
      ...(request.calendarTimezoneHint
        ? { calendarTimezoneHint: request.calendarTimezoneHint }
        : {}),
    });

    if (result.status === 'needs_user_decision') {
      return toDecision(result);
    }

    return {
      status: 'ok',
      location,
      origin,
      ...(interpretedFrom ? { interpretedFrom } : {}),
      requiresReview: result.requiresReview,
      hebrewYearsGenerated: result.hebrewYearsGenerated,
      occurrences: result.occurrences,
    };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'Invalid date' };
  }
}

function toDecision(decision: {
  code: string;
  question: string;
  explanation: string;
  options: { id: string; label: string }[];
}): PreviewDecision {
  return {
    status: 'needs_user_decision',
    code: decision.code,
    question: decision.question,
    explanation: decision.explanation,
    options: decision.options.map((option) => ({ id: option.id, label: option.label })),
  };
}

function prototypeSourceRecordId(request: PreviewRequest, origin: AnniversaryOrigin): string {
  return [
    request.type,
    request.displayName.trim().toLowerCase(),
    monthNumberForName(origin.month),
    origin.month,
    origin.day,
    origin.year ?? 'no-year',
  ].join(':');
}

function parseIsoDate(value?: string): { year: number; month: number; day: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Convenience re-export so the UI never imports the engine directly. */
export { resolveAnniversary };
export type { CalculationLocation, HebrewMonthName, Occurrence, SourceRecordType, DisplayMode };
