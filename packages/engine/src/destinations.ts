/**
 * Rendering an occurrence for one destination calendar.
 *
 * This is the only layer that knows about location, and therefore the only layer
 * that produces times. The separation matters for a real requirement: one family
 * dataset feeding several members' own calendars, who may live in different
 * cities. The Hebrew date is shared; the sunset window is not.
 *
 *     one source record
 *       → N HebrewOccurrence      (location-free: Hebrew date, Gregorian date)
 *         → N × M DestinationEvent (per destination: times, content, hash)
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
import { formatCivilDate } from './hebrewCalendar';
import { contentHash, googleEventId } from './ids';
import { sunsetOn } from './sunset';
import { eventDescription, eventTitle } from './eventContent';
import { CALCULATION_VERSION } from './version';
import type { HebrewOccurrence } from './occurrences';
import type {
  CalculationLocation,
  DisplayMode,
  SourceRecordType,
  SunsetResult,
} from './types';

/** Where events go, and how they should look when they get there. */
export interface DestinationCalendar {
  /** Stable identifier of this destination. Feeds the external event ID. */
  id: string;
  destinationType: 'google' | 'ical_feed';
  /** The location whose sunsets time these events. One per destination. */
  location: CalculationLocation;
  displayMode: DisplayMode;
  language?: 'en' | 'he';
  /**
   * Dates of death on a calendar that may be shared or shown at work is a real
   * privacy risk, so events default to private.
   */
  visibility?: 'private' | 'calendar_default';
}

/** The parts of a source record that reach the event content. */
export interface SourceRecordContent {
  type: SourceRecordType;
  displayName: string;
  notes?: string;
  customTitle?: string;
}

export type OccurrenceWarning =
  | { code: 'NO_SUNSET'; message: string }
  | { code: 'AMBIGUOUS_HEBREW_DATE'; message: string };

/**
 * One occurrence, rendered for one destination. Everything a calendar adapter
 * needs and nothing it does not.
 */
export interface DestinationEvent extends HebrewOccurrence {
  destinationCalendarId: string;
  /**
   * Deterministic external event ID, derived from the occurrence key and the
   * destination. Google requires base32hex; a retried insert therefore addresses
   * the same event instead of creating a duplicate.
   */
  googleEventId: string;
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
  visibility: 'private' | 'calendar_default';
  /** Hash of everything that reaches the destination event. Drives reconciliation. */
  contentHash: string;
  /** The location as used, so a later location change is detectable. */
  locationSnapshot: CalculationLocation;
  warnings: OccurrenceWarning[];
}

/** Render one occurrence for one destination. */
export function renderForDestination(
  occurrence: HebrewOccurrence,
  record: SourceRecordContent,
  destination: DestinationCalendar,
): DestinationEvent {
  const { location, displayMode } = destination;

  const start = sunsetOn(location, occurrence.precedingGregorianDate);
  const end = sunsetOn(location, occurrence.gregorianDate);

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
    startDate: formatCivilDate(occurrence.precedingGregorianDate),
    endDateExclusive: formatCivilDate(occurrence.followingGregorianDate),
  };

  const contentInput = {
    type: record.type,
    displayName: record.displayName,
    hebrewDate: occurrence.hebrewDate,
    displayMode,
    locationDisplayName: location.displayName,
    startIso: timing?.startIso ?? null,
    endIso: timing?.endIso ?? null,
    startDate: formatCivilDate(occurrence.precedingGregorianDate),
    endDate: formatCivilDate(occurrence.gregorianDate),
    ...(record.notes ? { notes: record.notes } : {}),
    ...(record.customTitle ? { customTitle: record.customTitle } : {}),
    ...(destination.language ? { language: destination.language } : {}),
  };

  const title = eventTitle(contentInput);
  const description = eventDescription(contentInput);
  const visibility = destination.visibility ?? 'private';

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
  for (const ambiguity of occurrence.ambiguities) {
    warnings.push({ code: 'AMBIGUOUS_HEBREW_DATE', message: ambiguity.explanation });
  }

  return {
    ...occurrence,
    destinationCalendarId: destination.id,
    googleEventId: googleEventId(occurrence.key, destination.id),
    start,
    end,
    timing,
    allDay,
    title,
    description,
    visibility,
    // Hashed over exactly what reaches the destination event, so a location,
    // mode or visibility change forces an update and nothing else does.
    contentHash: contentHash({
      title,
      description,
      displayMode,
      visibility,
      startIso: timing?.startIso ?? null,
      endIso: timing?.endIso ?? null,
      allDay,
      timezoneId: location.timezoneId,
      transparency: 'transparent',
      calculationVersion: CALCULATION_VERSION,
    }),
    locationSnapshot: { ...location },
    warnings,
  };
}

/** Render every occurrence for one destination. */
export function renderForDestinationCalendar(
  occurrences: HebrewOccurrence[],
  record: SourceRecordContent,
  destination: DestinationCalendar,
): DestinationEvent[] {
  return occurrences.map((occurrence) => renderForDestination(occurrence, record, destination));
}

/**
 * Render every occurrence for every destination: the family case.
 *
 * The returned map is keyed by destination ID. Each list has the same Hebrew
 * dates in the same order, with times, titles and hashes computed for that
 * destination's own location and display mode.
 */
export function renderForDestinations(
  occurrences: HebrewOccurrence[],
  record: SourceRecordContent,
  destinations: DestinationCalendar[],
): Map<string, DestinationEvent[]> {
  const byDestination = new Map<string, DestinationEvent[]>();
  for (const destination of destinations) {
    if (byDestination.has(destination.id)) {
      throw new Error(`Duplicate destination calendar ID "${destination.id}"`);
    }
    byDestination.set(
      destination.id,
      renderForDestinationCalendar(occurrences, record, destination),
    );
  }
  return byDestination;
}
