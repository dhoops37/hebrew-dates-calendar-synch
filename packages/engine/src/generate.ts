/**
 * `generateOccurrences` - the single-destination convenience path.
 *
 * Most users have one calendar in one place, and for them "resolve the Hebrew
 * dates, then render them for my calendar" is one step. This composes
 * `resolveOccurrences` and `renderForDestination` rather than duplicating
 * either, so there is exactly one implementation of each concern.
 *
 * Use the two-step API directly when one dataset feeds several destinations -
 * a family whose members live in different cities - so that the Hebrew dates are
 * resolved once and only the times differ per member. See `destinations.ts`.
 */
import { currentHebrewDateAt, resolveOccurrences } from './occurrences';
import { renderForDestinationCalendar, type DestinationEvent } from './destinations';
import type {
  AnniversaryOrigin,
  CalculationConventions,
  CalculationLocation,
  DecisionRequired,
  DisplayMode,
  HebrewDate,
  SourceRecordType,
} from './types';

export interface GenerateOccurrencesInput {
  /** Stable identifier of the source record. Feeds every derived identifier. */
  sourceRecordId: string;
  type: SourceRecordType;
  displayName: string;
  origin: AnniversaryOrigin;
  location: CalculationLocation;
  displayMode: DisplayMode;
  /**
   * How many future Hebrew *years* to materialise. The MVP horizon is 20.
   * Not a count of occurrences: a record observed in both Adars produces two
   * occurrences in a leap year while still covering one year of the horizon.
   */
  count: number;
  /** Injected for testability; defaults to the current time. */
  nowEpochMs?: number;
  conventions?: CalculationConventions;
  notes?: string;
  customTitle?: string;
  language?: 'en' | 'he';
  visibility?: 'private' | 'calendar_default';
  /** Per-year manual overrides, keyed by Hebrew year (PRD 17.1). */
  overrides?: Record<number, HebrewDate>;
  /** Destination identifier, which the external event ID derives from. */
  destinationCalendarId?: string;
}

export interface GenerateOccurrencesResult {
  status: 'ok';
  occurrences: DestinationEvent[];
  /**
   * How many future Hebrew years were materialised. Can be smaller than
   * `occurrences.length` when a year holds two observances.
   */
  hebrewYearsGenerated: number;
  requiresReview: boolean;
}

export type GenerateOccurrencesOutcome =
  | GenerateOccurrencesResult
  | DecisionRequired<HebrewDate>;

export function generateOccurrences(
  input: GenerateOccurrencesInput,
): GenerateOccurrencesOutcome {
  const nowEpochMs = input.nowEpochMs ?? Date.now();
  // "Has today's occurrence finished?" is a sunset question, so the anchor is
  // this destination's own location.
  const from = currentHebrewDateAt(input.location, nowEpochMs);

  const resolved = resolveOccurrences({
    sourceRecordId: input.sourceRecordId,
    type: input.type,
    origin: input.origin,
    count: input.count,
    from,
    ...(input.conventions ? { conventions: input.conventions } : {}),
    ...(input.overrides ? { overrides: input.overrides } : {}),
  });
  if (resolved.status === 'needs_user_decision') return resolved;

  const occurrences = renderForDestinationCalendar(
    resolved.occurrences,
    {
      type: input.type,
      displayName: input.displayName,
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.customTitle ? { customTitle: input.customTitle } : {}),
    },
    {
      id: input.destinationCalendarId ?? 'default',
      destinationType: 'google',
      location: input.location,
      displayMode: input.displayMode,
      ...(input.language ? { language: input.language } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
    },
  );

  return {
    status: 'ok',
    occurrences,
    hebrewYearsGenerated: resolved.hebrewYearsGenerated,
    requiresReview: resolved.requiresReview,
  };
}

/**
 * Backwards-compatible alias. A rendered occurrence *is* a destination event;
 * the old name is kept because it reads better at call sites that only ever
 * have one calendar.
 */
export type Occurrence = DestinationEvent;
