/**
 * "I'm not sure whether it was before or after sunset."
 *
 * A Hebrew day runs sunset to sunset, so one Gregorian date corresponds to two
 * different Hebrew dates. When the user does not know which, the engine refuses
 * to choose — that refusal is correct and stays exactly as it is. What was
 * wrong was what happened next: the refusal reached the web layer as a thrown
 * error, so the honest answer produced something that looked like a crash.
 *
 * This module turns it into a question instead. The shape is:
 *
 *   1. The user enters a Gregorian date and says they are not sure.
 *   2. `describeSunsetDecision` returns **both** candidate Hebrew dates, the
 *      calculated local sunset on that date, and why the answer matters.
 *   3. The entry is stored as an **inactive draft**. It exists — it is in their
 *      list, marked as needing an answer — but it generates no occurrences,
 *      because `unresolved_sunset_entry_cannot_be_active` forbids activating
 *      it. The refusal is now enforced by the database rather than by a throw.
 *   4. `resolveSunsetStatus` records the user's explicit choice, activates the
 *      record, and generates occurrences.
 *
 * Nothing here guesses. There is no default, no "probably daytime", and the
 * draft cannot be activated without an answer.
 */
import {
  getSourceRecord,
  recordAuditEvent,
  type DatasetAccess,
  type SourceRecordRow,
} from '@hebrew-dates/db';
import {
  formatHebrewDateEnglish,
  hebrewDateForDaytimeOf,
  hebrewDateForEveningOf,
  sunsetOn,
  type CalculationLocation,
  type CivilDate,
  type HebrewMonthName,
} from '@hebrew-dates/engine';
import type { ServiceContext } from './context';
import {
  SYNCHRONOUS_HORIZON_YEARS,
  anchorLocation,
  destinationLocation,
  generateAndPersist,
  hebrewDateFromGregorianEntry,
  storedHebrewDateOf,
} from './records';

export type SunsetChoice = 'before_sunset' | 'after_sunset';

export interface SunsetCandidate {
  choice: SunsetChoice;
  /** "14 Nisan 5750". What the user is choosing between. */
  hebrewDateLabel: string;
  hebrewMonth: HebrewMonthName;
  hebrewDay: number;
  hebrewYear: number;
  /** Plain-language help: "the daytime of that Wednesday", say. */
  meaning: string;
}

export interface SunsetDecision {
  /** The Gregorian date as entered, "YYYY-MM-DD". */
  gregorianDate: string;
  /** Exactly two, always in this order: before sunset, then after. */
  candidates: [SunsetCandidate, SunsetCandidate];
  /**
   * The calculated sunset at the location, when it could be determined.
   *
   * `undefined` where the sun does not set — the polar case — and the caller
   * shows the candidates without a time rather than inventing one.
   */
  sunset:
    | {
        /** "19:12" in the location's own zone. */
        localTime: string;
        iso: string;
        locationDisplayName: string;
        timezoneId: string;
      }
    | undefined;
  /** Why the answer matters, in one or two sentences a person can act on. */
  explanation: string;
  /** Where the answer usually comes from. */
  whereToLook: string[];
}

/**
 * Describe the choice, without making it.
 *
 * `location` is used only to calculate the sunset time shown as help. It does
 * not influence which two candidates are offered: those follow from the
 * Gregorian date alone, because the Hebrew calendar's day boundary is the same
 * everywhere even though the clock time of that boundary is not.
 */
export function describeSunsetDecision(params: {
  gregorianDate: CivilDate;
  location?: CalculationLocation | undefined;
}): SunsetDecision {
  const beforeSunset = hebrewDateForDaytimeOf(params.gregorianDate);
  const afterSunset = hebrewDateForEveningOf(params.gregorianDate);

  const sunset = params.location ? sunsetOn(params.location, params.gregorianDate) : undefined;
  const iso = formatCivil(params.gregorianDate);

  return {
    gregorianDate: iso,
    candidates: [
      {
        choice: 'before_sunset',
        hebrewDateLabel: formatHebrewDateEnglish(beforeSunset.hebrewDate, true),
        hebrewMonth: beforeSunset.monthName,
        hebrewDay: beforeSunset.hebrewDate.day,
        hebrewYear: beforeSunset.hebrewDate.year,
        meaning: `During the day on ${iso}, before the sun went down.`,
      },
      {
        choice: 'after_sunset',
        hebrewDateLabel: formatHebrewDateEnglish(afterSunset.hebrewDate, true),
        hebrewMonth: afterSunset.monthName,
        hebrewDay: afterSunset.hebrewDate.day,
        hebrewYear: afterSunset.hebrewDate.year,
        meaning: `In the evening of ${iso}, after the sun went down — which in the Hebrew calendar is already the next day.`,
      },
    ],
    sunset:
      sunset && sunset.status === 'ok' && params.location
        ? {
            localTime: localClockTime(sunset.iso),
            iso: sunset.iso,
            locationDisplayName: params.location.displayName,
            timezoneId: params.location.timezoneId,
          }
        : undefined,
    explanation:
      'A Hebrew date begins at sunset, not at midnight. So this one Gregorian ' +
      'date is two different Hebrew dates depending on whether it happened ' +
      'before or after the sun went down — and every future anniversary falls ' +
      'on a different day depending on which. Hebrew Dates will not guess.',
    whereToLook: [
      'A death certificate or burial record, which usually gives a time of day',
      'A Hebrew date already written on a matzevah (headstone) or in a family record',
      'A relative who was there',
    ],
  };
}

/**
 * The decision for a record that is waiting on one.
 *
 * Reads the stored Gregorian date and the destination's location, so a route
 * can render the question without re-deriving either.
 */
export async function pendingSunsetDecision(
  context: ServiceContext,
  access: DatasetAccess,
  params: { sourceRecordId: string; destinationCalendarId?: string },
): Promise<SunsetDecision | undefined> {
  const record = await getSourceRecord(context.db, access, params.sourceRecordId);
  if (!needsSunsetDecision(record)) return undefined;

  return describeSunsetDecision({
    gregorianDate: parseCivil(record.original_gregorian_date as string),
    location: await bestEffortLocation(context, access, params.destinationCalendarId),
  });
}

/** Whether this record is a draft awaiting the user's answer. */
export function needsSunsetDecision(record: SourceRecordRow): boolean {
  return record.original_gregorian_date !== null && record.sunset_status === null;
}

export class SunsetAlreadyResolvedError extends Error {
  constructor() {
    super('This date already has an answer recorded. Edit it if you want to change it.');
  }
}

export class NotAwaitingSunsetError extends Error {
  constructor() {
    super('This date was entered as a Hebrew date, so there is no sunset question to answer.');
  }
}

export interface ResolveSunsetResult {
  record: SourceRecordRow;
  /** The Hebrew date the choice settled on. */
  hebrewDateLabel: string;
  occurrencesPersisted: number;
  hebrewYearsGenerated: number;
}

/**
 * Record the user's explicit choice and activate the record.
 *
 * The Hebrew month and day are **recomputed** from the Gregorian date and the
 * choice rather than taken from the request. The UI sends only which of the two
 * it was, so a tampered or stale form cannot store a Hebrew date that is
 * neither candidate.
 */
export async function resolveSunsetStatus(
  context: ServiceContext,
  access: DatasetAccess,
  params: {
    sourceRecordId: string;
    choice: SunsetChoice;
    /** Used to anchor "which Hebrew year is it now" when generating. */
    destinationCalendarId?: string;
    horizonYears?: number;
  },
): Promise<ResolveSunsetResult> {
  const record = await getSourceRecord(context.db, access, params.sourceRecordId);
  if (record.original_gregorian_date === null) throw new NotAwaitingSunsetError();
  if (record.sunset_status !== null) throw new SunsetAlreadyResolvedError();

  // The same derivation `createHebrewDate` uses, so answering later cannot
  // produce a different Hebrew date than answering at entry time would have.
  const interpreted = hebrewDateFromGregorianEntry(record.original_gregorian_date, params.choice);
  const stored = storedHebrewDateOf(interpreted);

  const updated = await context.db
    .updateTable('source_records')
    .set({
      sunset_status: params.choice,
      // Recomputed, never trusted from the request.
      hebrew_month: stored.hebrewMonth,
      hebrew_day: stored.hebrewDay,
      original_hebrew_year: stored.originalHebrewYear,
      // The draft becomes real. The CHECK constraint allowed this only once
      // `sunset_status` was set, which is the guarantee that matters.
      active: true,
      updated_at: context.now(),
    })
    .where('id', '=', record.id)
    .where('dataset_id', '=', access.datasetId)
    .returningAll()
    .executeTakeFirstOrThrow();

  const generated = await generateAndPersist(context, access, {
    record: updated,
    horizonYears: params.horizonYears ?? SYNCHRONOUS_HORIZON_YEARS,
  });

  await recordAuditEvent(
    context.db,
    {
      action: 'date.edited',
      subjectType: 'source_record',
      subjectId: record.id,
      changedFields: 'sunsetStatus,hebrewMonth,hebrewDay,active',
      dateChanged: true,
      occurrencesRegenerated: generated.occurrencesPersisted,
    },
    { actorUserId: access.userId, at: context.now() },
  );

  return {
    record: updated,
    hebrewDateLabel: formatHebrewDateEnglish(interpreted.hebrewDate, true),
    occurrencesPersisted: generated.occurrencesPersisted,
    hebrewYearsGenerated: generated.hebrewYearsGenerated,
  };
}

/** Every record in the dataset still waiting on an answer. */
export async function listAwaitingSunsetDecision(
  context: ServiceContext,
  access: DatasetAccess,
): Promise<{ id: string; displayName: string; gregorianDate: string }[]> {
  const rows = await context.db
    .selectFrom('source_records')
    .select(['id', 'display_name', 'original_gregorian_date'])
    .where('dataset_id', '=', access.datasetId)
    .where('deleted_at', 'is', null)
    .where('original_gregorian_date', 'is not', null)
    .where('sunset_status', 'is', null)
    .orderBy('created_at')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    gregorianDate: row.original_gregorian_date as string,
  }));
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * A location for the sunset time, if one can be had.
 *
 * Best effort on purpose. The sunset time is *help* for answering the
 * question, not an input to it, so a dataset with no confirmed location yet
 * still gets the two candidates — just without a clock time beside them.
 */
async function bestEffortLocation(
  context: ServiceContext,
  access: DatasetAccess,
  destinationCalendarId: string | undefined,
): Promise<CalculationLocation | undefined> {
  if (destinationCalendarId) {
    const forDestination = await destinationLocation(
      context,
      access,
      destinationCalendarId,
    ).catch(() => undefined);
    if (forDestination?.confirmedByUser) return forDestination;
  }
  return anchorLocation(context, access).catch(() => undefined);
}

/** "19:12" — the clock time from an offset-carrying ISO string. */
function localClockTime(iso: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[1]}:${match[2]}` : iso;
}

function formatCivil(date: CivilDate): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.year).padStart(4, '0')}-${pad(date.month)}-${pad(date.day)}`;
}

/** Parse a `date` column. Never through `new Date`, which would add a zone. */
function parseCivil(iso: string): CivilDate {
  const [year, month, day] = iso.split('-').map(Number);
  return { year: year as number, month: month as number, day: day as number };
}
