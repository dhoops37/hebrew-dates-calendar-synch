/**
 * Creating a Hebrew date and materialising its occurrences.
 *
 * Two halves that must stay separate, and this is where the separation is
 * enforced:
 *
 *  - `resolveOccurrences` answers "which Hebrew dates, in which Gregorian
 *    years" — location-free, stored once per dataset in `generated_occurrences`.
 *  - `renderForDestination` answers "what does that look like in *this*
 *    member's calendar" — location-dependent, stored per destination.
 *
 * A family dataset feeding calendars in Jerusalem and Brooklyn observes the
 * same Hebrew date; only the sunset window differs. Collapsing the two would
 * mean recomputing the Hebrew reasoning per member and, worse, re-keying
 * everybody's events when one member moves.
 */
import {
  createSourceRecord,
  getLocation,
  getDestinationCalendar,
  getSourceRecord,
  listSourceRecords,
  recordAuditEvent,
  setHorizon,
  upsertOccurrences,
  type DatasetAccess,
  type SourceRecordInput,
  type SourceRecordRow,
} from '@hebrew-dates/db';
import {
  currentHebrewDateAt,
  formatCivilDate,
  resolveOccurrences,
  type AnniversaryOrigin,
  type CalculationConventions,
  type CalculationLocation,
  type HebrewMonthName,
  type HebrewOccurrence,
} from '@hebrew-dates/engine';
import type { ServiceContext } from './context';

/** The MVP horizon: 20 Hebrew years, per the PRD. */
export const DEFAULT_HORIZON_YEARS = 20;

/** Materialised synchronously on the request that creates a date. */
export const SYNCHRONOUS_HORIZON_YEARS = 2;

export class LocationNotConfirmedError extends Error {
  constructor() {
    super(
      'This calendar has no confirmed location yet. Sunset times depend on where you ' +
        'are, so please confirm your location before adding dates.',
    );
  }
}

export class DecisionRequiredError extends Error {
  constructor(
    readonly code: string,
    readonly question: string,
    readonly options: unknown,
  ) {
    super(question);
  }
}

export interface CreateHebrewDateInput extends SourceRecordInput {
  /** How many Hebrew years to materialise now. Defaults to the fast path. */
  horizonYears?: number;
}

export interface CreateHebrewDateResult {
  record: SourceRecordRow;
  occurrencesPersisted: number;
  hebrewYearsGenerated: number;
  /** True when the engine flagged an ambiguity a user should look at. */
  requiresReview: boolean;
}

/**
 * Create a source record and materialise its first occurrences.
 *
 * Deliberately *not* a Gregorian yearly recurrence: a Hebrew date lands on a
 * different Gregorian date every year, so each year is one stored row with a
 * stable key. That is what makes the sync idempotent and what makes a
 * correction an update rather than a delete-and-recreate.
 */
export async function createHebrewDate(
  context: ServiceContext,
  access: DatasetAccess,
  input: CreateHebrewDateInput,
): Promise<CreateHebrewDateResult> {
  const record = await createSourceRecord(context.db, access, input);

  const generated = await generateAndPersist(context, access, {
    record,
    horizonYears: input.horizonYears ?? SYNCHRONOUS_HORIZON_YEARS,
  });

  await recordAuditEvent(
    context.db,
    {
      // The type and the Hebrew month/day. Never the person's name, their
      // Hebrew name, the relationship, or the year of death.
      action: 'date.created',
      subjectType: 'source_record',
      subjectId: record.id,
      recordType: record.type,
      hebrewMonth: record.hebrew_month,
      hebrewDay: record.hebrew_day,
      hasOriginalYear: record.original_hebrew_year !== null,
      enteredAsGregorian: record.original_gregorian_date !== null,
    },
    { actorUserId: access.userId, at: context.now() },
  );

  return { record, ...generated };
}

export interface GenerateAndPersistResult {
  occurrencesPersisted: number;
  hebrewYearsGenerated: number;
  requiresReview: boolean;
}

/**
 * Resolve and store occurrences for one record.
 *
 * The anchor for "which Hebrew year are we in now" is a sunset question, so it
 * needs a location — but only to find *today's* Hebrew date. The occurrences
 * themselves are location-free.
 */
export async function generateAndPersist(
  context: ServiceContext,
  access: DatasetAccess,
  params: {
    record: SourceRecordRow;
    horizonYears: number;
    /** A location to anchor "today". Read from the dataset when omitted. */
    location?: CalculationLocation;
  },
): Promise<GenerateAndPersistResult> {
  const location = params.location ?? (await anchorLocation(context, access));
  const from = currentHebrewDateAt(location, context.now().getTime());

  const resolved = resolveOccurrences({
    sourceRecordId: params.record.id,
    type: params.record.type,
    origin: originFor(params.record),
    count: params.horizonYears,
    from,
    conventions: params.record.calculation_convention as CalculationConventions,
  });

  if (resolved.status === 'needs_user_decision') {
    // Never silently choose. The engine refuses, and that refusal is carried
    // through to the user rather than resolved by a default here.
    throw new DecisionRequiredError(resolved.code, resolved.question, resolved.options);
  }

  const persisted = await upsertOccurrences(context.db, access, {
    sourceRecordId: params.record.id,
    occurrences: resolved.occurrences.map(toOccurrenceInput),
  });

  const highestYear = resolved.occurrences.reduce(
    (highest, occurrence) => Math.max(highest, occurrence.hebrewYear),
    params.record.horizon_through_hebrew_year ?? 0,
  );
  if (highestYear > 0) {
    await setHorizon(context.db, access, {
      sourceRecordId: params.record.id,
      throughHebrewYear: highestYear,
    });
  }

  return {
    occurrencesPersisted: persisted.length,
    hebrewYearsGenerated: resolved.hebrewYearsGenerated,
    requiresReview: resolved.requiresReview,
  };
}

/**
 * Extend one record to the full horizon.
 *
 * Run from a background job after the synchronous first two years, so adding a
 * date feels instant while still ending up with twenty years of occurrences.
 */
export async function extendHorizon(
  context: ServiceContext,
  access: DatasetAccess,
  params: { sourceRecordId: string; throughYears?: number },
): Promise<GenerateAndPersistResult> {
  const record = await getSourceRecord(context.db, access, params.sourceRecordId);
  return generateAndPersist(context, access, {
    record,
    horizonYears: params.throughYears ?? DEFAULT_HORIZON_YEARS,
  });
}

/** Extend every active record in a dataset. The `extend_horizon` job's body. */
export async function extendDatasetHorizon(
  context: ServiceContext,
  access: DatasetAccess,
  params: { throughYears?: number } = {},
): Promise<{ records: number; occurrencesPersisted: number }> {
  const records = await listSourceRecords(context.db, access);
  let occurrencesPersisted = 0;
  let extended = 0;

  for (const record of records) {
    if (!record.active) continue;
    const result = await generateAndPersist(context, access, {
      record,
      horizonYears: params.throughYears ?? DEFAULT_HORIZON_YEARS,
    });
    occurrencesPersisted += result.occurrencesPersisted;
    extended += 1;
  }

  return { records: extended, occurrencesPersisted };
}

/* ------------------------------------------------------------- helpers -- */

/**
 * Turn a stored record into the engine's origin shape.
 *
 * The month is stored by name, so "Adar" and "Adar I" stay distinguishable — a
 * numeric month would collapse an ordinary-year date into a leap-year one.
 */
export function originFor(record: SourceRecordRow): AnniversaryOrigin {
  return {
    // By NAME, so 'ADAR' and 'ADAR_I' stay distinct all the way into the engine.
    month: record.hebrew_month as HebrewMonthName,
    day: record.hebrew_day,
    ...(record.original_hebrew_year !== null ? { year: record.original_hebrew_year } : {}),
  };
}

function toOccurrenceInput(occurrence: HebrewOccurrence) {
  return {
    hebrewYear: occurrence.hebrewYear,
    sequence: occurrence.sequence,
    occurrenceKey: occurrence.key,
    hebrewMonth: occurrence.hebrewDate.month,
    hebrewDay: occurrence.hebrewDate.day,
    // A calendar day as text, never an instant: `gregorian_date` is a `date`
    // column for exactly this reason.
    gregorianDate: formatCivilDate(occurrence.gregorianDate),
    calculationVersion: occurrence.calculationVersion,
    ruleApplied: occurrence.ruleApplied,
    ambiguities: occurrence.ambiguities,
    isManualOverride: occurrence.isManualOverride,
  };
}

/**
 * A location to anchor "what Hebrew date is it now".
 *
 * Any confirmed location in the dataset will do: the question is which Hebrew
 * day it is, and that differs between locations only for the hours between the
 * two sunsets. An unconfirmed location is refused, because the whole point of
 * confirmation is that the app does not guess where somebody is.
 */
export async function anchorLocation(
  context: ServiceContext,
  access: DatasetAccess,
): Promise<CalculationLocation> {
  const row = await context.db
    .selectFrom('calendar_locations')
    .innerJoin(
      'destination_calendars',
      'destination_calendars.id',
      'calendar_locations.destination_calendar_id',
    )
    .selectAll('calendar_locations')
    .where('destination_calendars.dataset_id', '=', access.datasetId)
    .where('calendar_locations.confirmed_at', 'is not', null)
    .orderBy('calendar_locations.confirmed_at', 'desc')
    .executeTakeFirst();

  if (!row) throw new LocationNotConfirmedError();
  return toCalculationLocation(row);
}

/** The confirmed location for one destination, or undefined. */
export async function destinationLocation(
  context: ServiceContext,
  access: DatasetAccess,
  destinationCalendarId: string,
): Promise<CalculationLocation | undefined> {
  await getDestinationCalendar(context.db, access, destinationCalendarId);
  const row = await getLocation(context.db, access, destinationCalendarId);
  if (!row) return undefined;
  return toCalculationLocation(row);
}

type LocationRow = {
  id: string;
  display_name: string;
  country_code: string;
  latitude: string;
  longitude: string;
  elevation_meters: number | null;
  use_elevation: boolean;
  timezone_id: string;
  geocoder_place_id: string | null;
  source: string;
  confirmed_at: Date | null;
};

export function toCalculationLocation(row: LocationRow): CalculationLocation {
  return {
    id: row.id,
    displayName: row.display_name,
    countryCode: row.country_code,
    // Stored as numeric strings to keep full precision; parsed only here.
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    timezoneId: row.timezone_id,
    ...(row.elevation_meters !== null ? { elevationMeters: row.elevation_meters } : {}),
    useElevation: row.use_elevation,
    ...(row.geocoder_place_id !== null ? { geocoderPlaceId: row.geocoder_place_id } : {}),
    source: row.source as CalculationLocation['source'],
    confirmedByUser: row.confirmed_at !== null,
  };
}
