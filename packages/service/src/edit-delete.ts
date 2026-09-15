/**
 * Editing and deleting a personal date.
 *
 * Both are more delicate than they look, because both change what is in
 * somebody's calendar and one of them is about a person who has died.
 *
 * **Editing.** An occurrence key is `sha256(source_record_id, hebrew_year,
 * sequence)` — it does not include the Hebrew date. So correcting a date moves
 * where the same keyed occurrence falls, and the reconciler issues PATCHes
 * rather than deleting and recreating. That matters practically: a delete and
 * recreate would lose any reminder the user added by hand and would re-notify
 * them about every year at once.
 *
 * The one case that does produce orphans is a convention change that reduces
 * the count in a year — both Adars down to Adar II only leaves a stale
 * sequence 1 — so regeneration reports which keys are current and anything else
 * is removed.
 *
 * **Deleting.** The existing past-event policy is `preserve`: an anniversary
 * someone already observed stays in their calendar. Deleting a record must not
 * quietly break that, so `describeDeletion` counts exactly what will happen
 * before the user commits, and the sentence shown to them comes from the same
 * numbers the deletion then acts on.
 */
import {
  deleteOccurrencesNotIn,
  diffSourceRecord,
  getSourceRecord,
  recordAuditEvent,
  softDeleteSourceRecord,
  updateSourceRecord,
  type DatasetAccess,
  type SourceRecordPatch,
  type SourceRecordRow,
} from '@hebrew-dates/db';
import { formatHebrewDateEnglish, type HebrewMonthNumber } from '@hebrew-dates/engine';
import type { ServiceContext } from './context';
import { DEFAULT_HORIZON_YEARS, generateAndPersist } from './records';
import { syncDestination, type SyncResult } from './sync';

export class CannotEditWhileAwaitingSunsetError extends Error {
  constructor() {
    super(
      'This date is still waiting for an answer about sunset. Answer that first, ' +
        'then you can edit it.',
    );
  }
}

export interface EditDateResult {
  record: SourceRecordRow;
  /** Field names that changed. Never their values. */
  changedFields: string[];
  /** True when the Hebrew date moved, so events will be rewritten. */
  dateChanged: boolean;
  occurrencesRegenerated: number;
  orphanedOccurrencesRemoved: number;
  /** The reconcile that followed, when one was needed. */
  sync: SyncResult | undefined;
}

/**
 * Edit a record and bring the calendar back in line.
 *
 * Reconciles only when something that reaches a calendar changed. Renaming the
 * record changes every event's summary, so that counts; a note the user keeps
 * for themselves does too, because the description carries it. What does *not*
 * reconcile is an edit that changed nothing.
 */
export async function editHebrewDate(
  context: ServiceContext,
  access: DatasetAccess,
  params: {
    sourceRecordId: string;
    userId: string;
    destinationCalendarId: string;
    patch: SourceRecordPatch;
  },
): Promise<EditDateResult> {
  const before = await getSourceRecord(context.db, access, params.sourceRecordId);

  // A draft awaiting a sunset answer is edited through that flow, not this one:
  // the Hebrew date is not settled yet, so there is nothing to regenerate.
  if (before.original_gregorian_date !== null && before.sunset_status === null) {
    throw new CannotEditWhileAwaitingSunsetError();
  }

  const change = diffSourceRecord(before, params.patch);
  if (change.changed.length === 0) {
    return {
      record: before,
      changedFields: [],
      dateChanged: false,
      occurrencesRegenerated: 0,
      orphanedOccurrencesRemoved: 0,
      sync: undefined,
    };
  }

  const record = await updateSourceRecord(
    context.db,
    access,
    params.sourceRecordId,
    params.patch,
  );

  // Regenerate to the full horizon rather than the two-year fast path: the
  // record already has twenty years of occurrences, and leaving eighteen of
  // them on the old date would be worse than the edit taking a moment longer.
  const regenerated = await generateAndPersist(context, access, {
    record,
    horizonYears: DEFAULT_HORIZON_YEARS,
  });

  // Anything the fresh generation did not produce is stale — the both-Adars
  // case described at the top of this file.
  const orphanedOccurrencesRemoved = await deleteOccurrencesNotIn(context.db, access, {
    sourceRecordId: record.id,
    keepOccurrenceKeys: regenerated.occurrenceKeys,
  });

  const sync = await syncDestination(context, access, {
    destinationCalendarId: params.destinationCalendarId,
    userId: params.userId,
  });

  await recordAuditEvent(
    context.db,
    {
      action: 'date.edited',
      subjectType: 'source_record',
      subjectId: record.id,
      // Which fields, never their old or new values.
      changedFields: change.changed.join(','),
      dateChanged: change.dateChanged,
      occurrencesRegenerated: regenerated.occurrencesPersisted,
    },
    { actorUserId: params.userId, at: context.now() },
  );

  return {
    record,
    changedFields: change.changed,
    dateChanged: change.dateChanged,
    occurrencesRegenerated: regenerated.occurrencesPersisted,
    orphanedOccurrencesRemoved,
    sync,
  };
}

/* ----------------------------------------------------------------- delete -- */

export interface DeletionPreview {
  sourceRecordId: string;
  displayName: string;
  /** Future events that will be removed from Google Calendar. */
  futureEventsToRemove: number;
  /** Past events that will be left alone. */
  pastEventsToKeep: number;
  /** The next few dates that will disappear, so the user can see them. */
  nextDatesToRemove: { gregorianDate: string; hebrewDateLabel: string }[];
  /** The most recent past date being kept, if any. */
  mostRecentKeptDate: { gregorianDate: string; hebrewDateLabel: string } | undefined;
  /** One paragraph stating exactly what will happen. */
  summary: string;
}

/**
 * Say what deleting this record will do, before doing it.
 *
 * Counted from the same rows the deletion acts on, so the sentence the user
 * reads and the outcome cannot disagree. "Past" is by calendar day rather than
 * by instant: an anniversary today is still today's, right up to its own
 * sunset, and telling someone their father's yahrzeit will be removed on the
 * morning of it would be both wrong and upsetting.
 */
export async function describeDeletion(
  context: ServiceContext,
  access: DatasetAccess,
  params: { sourceRecordId: string; destinationCalendarId: string },
): Promise<DeletionPreview> {
  const record = await getSourceRecord(context.db, access, params.sourceRecordId);
  const today = context.now().toISOString().slice(0, 10);

  const rows = await context.db
    .selectFrom('generated_occurrences')
    .leftJoin('destination_events', (join) =>
      join
        .onRef('destination_events.generated_occurrence_id', '=', 'generated_occurrences.id')
        .on('destination_events.destination_calendar_id', '=', params.destinationCalendarId),
    )
    .select([
      'generated_occurrences.gregorian_date as gregorian_date',
      'generated_occurrences.hebrew_year as hebrew_year',
      'generated_occurrences.hebrew_month as hebrew_month',
      'generated_occurrences.hebrew_day as hebrew_day',
      'destination_events.id as destination_event_id',
      'destination_events.external_event_id as external_event_id',
    ])
    .where('generated_occurrences.source_record_id', '=', params.sourceRecordId)
    .orderBy('generated_occurrences.gregorian_date')
    .execute();

  const label = (row: (typeof rows)[number]) => ({
    gregorianDate: row.gregorian_date,
    hebrewDateLabel: formatHebrewDateEnglish(
      {
        year: row.hebrew_year,
        month: row.hebrew_month as HebrewMonthNumber,
        day: row.hebrew_day,
      },
      true,
    ),
  });

  // Only rows that actually reached Google can be removed from it.
  const written = rows.filter((row) => row.external_event_id !== null);
  const future = written.filter((row) => row.gregorian_date >= today);
  const past = written.filter((row) => row.gregorian_date < today);

  const futureEventsToRemove = future.length;
  const pastEventsToKeep = past.length;

  return {
    sourceRecordId: record.id,
    displayName: record.display_name,
    futureEventsToRemove,
    pastEventsToKeep,
    nextDatesToRemove: future.slice(0, 3).map(label),
    mostRecentKeptDate: past.length > 0 ? label(past[past.length - 1] as (typeof rows)[number]) : undefined,
    summary: deletionSummary(record.display_name, futureEventsToRemove, pastEventsToKeep),
  };
}

/**
 * The sentence the user reads before confirming.
 *
 * Written out in full rather than assembled from fragments, because the
 * difference between "2 events" and "18 events" is the difference between
 * pressing the button and not, and because a yahrzeit deserves a sentence that
 * reads like it was written by a person.
 */
export function deletionSummary(
  displayName: string,
  futureEventsToRemove: number,
  pastEventsToKeep: number,
): string {
  const events = (count: number) => `${count} event${count === 1 ? '' : 's'}`;

  if (futureEventsToRemove === 0 && pastEventsToKeep === 0) {
    return (
      `Nothing has been written to your Google Calendar for ${displayName} yet, ` +
      'so deleting it removes it from Hebrew Dates only.'
    );
  }

  if (pastEventsToKeep === 0) {
    return (
      `${events(futureEventsToRemove)} for ${displayName} will be removed from your ` +
      'Google Calendar. Nothing has passed yet, so nothing will be left behind.'
    );
  }

  if (futureEventsToRemove === 0) {
    return (
      `${events(pastEventsToKeep)} for ${displayName} have already passed and will be ` +
      'left in your Google Calendar. There are no future events to remove.'
    );
  }

  return (
    `${events(futureEventsToRemove)} for ${displayName} will be removed from your Google ` +
    `Calendar. ${events(pastEventsToKeep)} that have already passed will be left where ` +
    'they are — an anniversary you have already observed stays in your calendar.'
  );
}

export interface DeleteDateResult {
  preview: DeletionPreview;
  futureEventsRemoved: number;
  pastEventsKept: number;
  sync: SyncResult;
}

/**
 * Delete a record and remove its future events.
 *
 * A soft delete: the row survives so the reconciler can still find the events
 * it needs to remove, and so a user who deletes the wrong entry has not
 * destroyed the Hebrew date they spent an evening establishing. The reconciler
 * then does the removal, which means it goes through the same
 * `past_event_preserved` policy as everything else rather than a second
 * implementation of the same rule.
 */
export async function deleteHebrewDate(
  context: ServiceContext,
  access: DatasetAccess,
  params: { sourceRecordId: string; userId: string; destinationCalendarId: string },
): Promise<DeleteDateResult> {
  // Counted before the delete, because afterwards the projection no longer
  // includes the record and the numbers would all be zero.
  const preview = await describeDeletion(context, access, {
    sourceRecordId: params.sourceRecordId,
    destinationCalendarId: params.destinationCalendarId,
  });

  await softDeleteSourceRecord(context.db, access, params.sourceRecordId);

  const sync = await syncDestination(context, access, {
    destinationCalendarId: params.destinationCalendarId,
    userId: params.userId,
  });

  await recordAuditEvent(
    context.db,
    {
      action: 'date.deleted',
      subjectType: 'source_record',
      subjectId: params.sourceRecordId,
      futureEventsRemoved: sync.deleted,
      pastEventsKept: preview.pastEventsToKeep,
    },
    { actorUserId: params.userId, at: context.now() },
  );

  return {
    preview,
    futureEventsRemoved: sync.deleted,
    pastEventsKept: preview.pastEventsToKeep,
    sync,
  };
}

/**
 * Pause or resume a record.
 *
 * Distinct from deleting: pausing removes the future events but keeps the date,
 * so a user who wants a year off does not have to re-enter it. `pause_behaviour`
 * on the dataset decides whether the events actually go.
 */
export async function setDateActive(
  context: ServiceContext,
  access: DatasetAccess,
  params: {
    sourceRecordId: string;
    userId: string;
    destinationCalendarId: string;
    active: boolean;
  },
): Promise<{ record: SourceRecordRow; sync: SyncResult }> {
  const record = await getSourceRecord(context.db, access, params.sourceRecordId);

  // Reactivating a draft would violate `unresolved_sunset_entry_cannot_be_active`,
  // so it is refused here with an explanation rather than as a constraint error.
  if (params.active && record.original_gregorian_date !== null && record.sunset_status === null) {
    throw new CannotEditWhileAwaitingSunsetError();
  }

  await context.db
    .updateTable('source_records')
    .set({ active: params.active, updated_at: context.now() })
    .where('id', '=', params.sourceRecordId)
    .where('dataset_id', '=', access.datasetId)
    .execute();

  const sync = await syncDestination(context, access, {
    destinationCalendarId: params.destinationCalendarId,
    userId: params.userId,
  });

  await recordAuditEvent(
    context.db,
    {
      action: 'date.paused',
      subjectType: 'source_record',
      subjectId: params.sourceRecordId,
      active: params.active,
    },
    { actorUserId: params.userId, at: context.now() },
  );

  return {
    record: await getSourceRecord(context.db, access, params.sourceRecordId),
    sync,
  };
}
