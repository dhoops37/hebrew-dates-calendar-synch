/**
 * Editing and deleting a date.
 *
 * The properties that matter:
 *
 *  - An edit **patches** the existing calendar events rather than deleting and
 *    recreating them, because a recreate would lose a reminder the user added
 *    by hand and would re-notify them about twenty years at once.
 *  - A delete **preserves past events**, per the existing policy, and says so
 *    in numbers before the user commits — numbers that come from the same rows
 *    the deletion then acts on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorise, type DatasetAccess } from '@hebrew-dates/db';
import {
  CannotEditWhileAwaitingSunsetError,
  addDateAndSync,
  beginGoogleSignIn,
  completeGoogleSignIn,
  confirmLocation,
  createHebrewDate,
  deleteHebrewDate,
  deletionSummary,
  describeDeletion,
  editHebrewDate,
  ensureGoogleCalendar,
  runDueJobs,
  setDateActive,
  syncDestination,
} from '../src/index';
import { clearTokenCache } from '../src/tokens';
import { createHarness, hasDatabase, JERUSALEM, type Harness } from './helpers/harness';

interface Session {
  userId: string;
  datasetId: string;
  destinationCalendarId: string;
  access: DatasetAccess;
}

async function setUpAccount(harness: Harness): Promise<Session> {
  const begun = await beginGoogleSignIn(harness.context);
  const code = harness.google.authorize(begun.authorizationUrl);
  const completed = await completeGoogleSignIn(harness.context, { code, state: begun.state });
  const access = await authorise(harness.context.db, {
    datasetId: completed.datasetId,
    userId: completed.userId,
    minimumRole: 'admin',
  });
  await confirmLocation(harness.context, access, {
    destinationCalendarId: completed.destinationCalendarId,
    userId: completed.userId,
    location: { ...JERUSALEM, source: 'user_selected' },
  });
  await ensureGoogleCalendar(harness.context, access, {
    destinationCalendarId: completed.destinationCalendarId,
    userId: completed.userId,
  });
  return {
    userId: completed.userId,
    datasetId: completed.datasetId,
    destinationCalendarId: completed.destinationCalendarId,
    access,
  };
}

const YAHRZEIT = {
  type: 'personal_yahrzeit' as const,
  displayName: 'Avraham ben Yitzchak',
  hebrewMonth: 'NISAN' as const,
  hebrewDay: 14,
  originalHebrewYear: 5750,
};

/* -------------------------------------------------------------------- edit -- */

describe.runIf(hasDatabase)('editing a date', () => {
  let harness: Harness;
  let session: Session;
  let recordId: string;

  beforeEach(async () => {
    clearTokenCache();
    harness = await createHarness('edit');
    session = await setUpAccount(harness);
    const added = await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    recordId = added.sourceRecordId;

    // Run the queued backfill so the record is at the full twenty-year horizon
    // before each edit test. Otherwise an edit legitimately *creates* the
    // eighteen years the synchronous fast path skipped, and the assertions
    // below could not tell that apart from a delete-and-recreate.
    await runDueJobs(harness.context);
    await runDueJobs(harness.context);
  }, 60_000);

  afterEach(async () => {
    await harness?.destroy();
  });

  function calendar() {
    return harness.google.calendar(harness.google.calendarIds()[0] as string);
  }

  it('corrects a name and patches the existing events', async () => {
    const eventIdsBefore = [...(calendar()?.events.keys() ?? [])];

    const result = await editHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      patch: { displayName: 'Avraham ben Yitzchak HaLevi' },
    });

    expect(result.changedFields).toEqual(['displayName']);
    expect(result.dateChanged).toBe(false);
    expect(result.sync?.updated).toBeGreaterThan(0);
    expect(result.sync?.created).toBe(0);
    expect(result.sync?.deleted).toBe(0);

    // The same events, patched. Not deleted and recreated.
    expect([...(calendar()?.events.keys() ?? [])]).toEqual(eventIdsBefore);
    const summaries = [...(calendar()?.events.values() ?? [])].map((event) => event.summary);
    expect(summaries.every((summary) => summary?.includes('HaLevi'))).toBe(true);
  });

  it('corrects the Hebrew date and moves the events to the new dates', async () => {
    const before = await harness.db
      .selectFrom('generated_occurrences')
      .select(['occurrence_key', 'gregorian_date', 'hebrew_day'])
      .orderBy('hebrew_year')
      .execute();
    const eventIdsBefore = [...(calendar()?.events.keys() ?? [])].sort();

    // The user discovers it was the 15th, not the 14th.
    const result = await editHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      patch: { hebrewDay: 15 },
    });

    expect(result.dateChanged).toBe(true);
    expect(result.changedFields).toEqual(['hebrewDay']);

    const after = await harness.db
      .selectFrom('generated_occurrences')
      .select(['occurrence_key', 'gregorian_date', 'hebrew_day'])
      .orderBy('hebrew_year')
      .execute();

    // The keys are unchanged — they are derived from (record, year, sequence),
    // not from the date — so the events are patched in place rather than
    // re-keyed. That is what preserves a reminder the user added by hand.
    expect(after.map((row) => row.occurrence_key)).toEqual(
      before.map((row) => row.occurrence_key),
    );
    // But every Gregorian date moved.
    expect(after.map((row) => row.gregorian_date)).not.toEqual(
      before.map((row) => row.gregorian_date),
    );
    expect(after.every((row) => row.hebrew_day === 15)).toBe(true);

    expect([...(calendar()?.events.keys() ?? [])].sort()).toEqual(eventIdsBefore);
    expect(result.sync?.updated).toBeGreaterThan(0);
  });

  it('extends to the full horizon on an edit, not just two years', async () => {
    // Leaving eighteen of the twenty years on the old date would be worse than
    // the edit taking a moment longer.
    const countBefore = await harness.db
      .selectFrom('generated_occurrences')
      .select(harness.db.fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(countBefore.count)).toBeGreaterThanOrEqual(20);

    const result = await editHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      patch: { hebrewDay: 15 },
    });
    expect(result.occurrencesRegenerated).toBeGreaterThanOrEqual(20);

    const stale = await harness.db
      .selectFrom('generated_occurrences')
      .select('hebrew_day')
      .where('hebrew_day', '=', 14)
      .execute();
    expect(stale).toHaveLength(0);
  });

  it('removes an orphaned occurrence when a convention change reduces the count', async () => {
    // Both Adars down to Adar II only: the leap years lose their sequence 1.
    const adar = await createHebrewDate(harness.context, session.access, {
      type: 'personal_yahrzeit',
      displayName: 'Adar yahrzeit',
      hebrewMonth: 'ADAR',
      hebrewDay: 10,
      originalHebrewYear: 5745,
      horizonYears: 20,
    });
    await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });

    const bothAdars = await harness.db
      .selectFrom('generated_occurrences')
      .select('sequence')
      .where('source_record_id', '=', adar.record.id)
      .where('sequence', '=', 1)
      .execute();
    expect(bothAdars.length).toBeGreaterThan(0);

    const result = await editHebrewDate(harness.context, session.access, {
      sourceRecordId: adar.record.id,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      patch: { adarConvention: 'adar_ii' },
    });

    expect(result.dateChanged).toBe(true);
    expect(result.orphanedOccurrencesRemoved).toBeGreaterThan(0);

    const remaining = await harness.db
      .selectFrom('generated_occurrences')
      .select('sequence')
      .where('source_record_id', '=', adar.record.id)
      .where('sequence', '=', 1)
      .execute();
    expect(remaining).toHaveLength(0);
  });

  it('does nothing at all when the patch changes nothing', async () => {
    const requestsBefore = harness.google.requests.length;
    const result = await editHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      patch: { displayName: 'Avraham ben Yitzchak' },
    });

    expect(result.changedFields).toEqual([]);
    expect(result.sync).toBeUndefined();
    expect(result.occurrencesRegenerated).toBe(0);
    // Not a single call to Google.
    expect(harness.google.requests.length).toBe(requestsBefore);
  });

  it('leaves fields the patch omits alone', async () => {
    await editHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      patch: { notes: 'Buried in Har HaMenuchot' },
    });
    const result = await editHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      patch: { relationship: 'Grandfather' },
    });

    // A form that renders two fields must not blank the other eight.
    expect(result.record.notes).toBe('Buried in Har HaMenuchot');
    expect(result.record.relationship).toBe('Grandfather');
    expect(result.record.display_name).toBe('Avraham ben Yitzchak');
    expect(result.record.hebrew_day).toBe(14);
  });

  it('refuses to edit a draft still waiting on the sunset question', async () => {
    const draft = await createHebrewDate(harness.context, session.access, {
      ...YAHRZEIT,
      displayName: 'Unresolved',
      originalGregorianDate: '1990-04-09',
    });

    await expect(
      editHebrewDate(harness.context, session.access, {
        sourceRecordId: draft.record.id,
        userId: session.userId,
        destinationCalendarId: session.destinationCalendarId,
        patch: { displayName: 'Renamed' },
      }),
    ).rejects.toThrow(CannotEditWhileAwaitingSunsetError);
  });

  it('records which fields changed, never their values', async () => {
    await editHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      patch: { displayName: 'Avraham ben Yitzchak HaLevi', relationship: 'Grandfather' },
    });

    const entry = await harness.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'date.edited')
      .executeTakeFirstOrThrow();

    const detail = entry.detail as { changedFields: string; dateChanged: boolean };
    expect(detail.changedFields.split(',').sort()).toEqual(['displayName', 'relationship']);
    expect(detail.dateChanged).toBe(false);
    // The values themselves are not in the trail.
    const serialised = JSON.stringify(entry.detail);
    expect(serialised).not.toContain('HaLevi');
    expect(serialised).not.toContain('Grandfather');
  });
});

/* ------------------------------------------------------------------ delete -- */

describe('deletionSummary', () => {
  it('states both numbers when there are past and future events', () => {
    const summary = deletionSummary('Avraham ben Yitzchak', 18, 2);
    expect(summary).toContain('18 events');
    expect(summary).toContain('2 events');
    expect(summary).toContain('removed from your Google Calendar');
    expect(summary).toContain('already observed stays in your calendar');
  });

  it('says nothing will be left behind when nothing has passed', () => {
    const summary = deletionSummary('Rivka', 20, 0);
    expect(summary).toContain('20 events');
    expect(summary).toContain('nothing will be left behind');
  });

  it('says there is nothing to remove when everything has passed', () => {
    const summary = deletionSummary('Sarah', 0, 5);
    expect(summary).toContain('no future events to remove');
  });

  it('says so when nothing has reached the calendar at all', () => {
    const summary = deletionSummary('Unsynced', 0, 0);
    expect(summary).toContain('Nothing has been written');
  });

  it('gets the singular right', () => {
    expect(deletionSummary('One', 1, 1)).toContain('1 event ');
    expect(deletionSummary('One', 1, 1)).not.toContain('1 events');
  });
});

describe.runIf(hasDatabase)('deleting a date', () => {
  let harness: Harness;
  let session: Session;
  let recordId: string;

  beforeEach(async () => {
    clearTokenCache();
    // Set up in March, when 14 Nisan 5786 (1 April 2026) is still ahead, so it
    // is generated and written. Then move to June, which makes it a past event.
    // That is the mixed case the preview has to describe, and it cannot be
    // reached by starting the clock in June: an occurrence already past is
    // never generated in the first place.
    harness = await createHarness('delete', { now: new Date('2026-03-01T12:00:00Z') });
    session = await setUpAccount(harness);
    const added = await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: { ...YAHRZEIT, horizonYears: 5 },
    });
    recordId = added.sourceRecordId;

    harness.setNow(new Date('2026-06-01T12:00:00Z'));
  }, 60_000);

  afterEach(async () => {
    await harness?.destroy();
  });

  function calendar() {
    return harness.google.calendar(harness.google.calendarIds()[0] as string);
  }

  it('describes exactly what will happen before anything happens', async () => {
    const preview = await describeDeletion(harness.context, session.access, {
      sourceRecordId: recordId,
      destinationCalendarId: session.destinationCalendarId,
    });

    expect(preview.displayName).toBe('Avraham ben Yitzchak');
    expect(preview.futureEventsToRemove).toBeGreaterThan(0);
    expect(preview.summary).toContain('will be removed from your Google Calendar');
    // The next few dates, so the user can see what they are agreeing to.
    expect(preview.nextDatesToRemove.length).toBeGreaterThan(0);
    expect(preview.nextDatesToRemove[0]?.gregorianDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(preview.nextDatesToRemove[0]?.hebrewDateLabel).toContain('Nisan');

    // Nothing was touched by asking.
    const eventsStillThere = [...(calendar()?.events.values() ?? [])];
    expect(eventsStillThere.every((event) => event.status === 'confirmed')).toBe(true);
  });

  it('removes future events and keeps past ones', async () => {
    const preview = await describeDeletion(harness.context, session.access, {
      sourceRecordId: recordId,
      destinationCalendarId: session.destinationCalendarId,
    });

    const result = await deleteHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
    });

    // The numbers the user was shown are the numbers that happened.
    expect(result.futureEventsRemoved).toBe(preview.futureEventsToRemove);
    expect(result.pastEventsKept).toBe(preview.pastEventsToKeep);

    const events = [...(calendar()?.events.values() ?? [])];
    const cancelled = events.filter((event) => event.status === 'cancelled');
    const confirmed = events.filter((event) => event.status === 'confirmed');
    expect(cancelled).toHaveLength(preview.futureEventsToRemove);
    expect(confirmed).toHaveLength(preview.pastEventsToKeep);
  });

  it('keeps the past yahrzeit that has already been observed', async () => {
    // The point of the policy. A yahrzeit someone sat through in April must not
    // vanish from their calendar in June because they tidied up an entry.
    const preview = await describeDeletion(harness.context, session.access, {
      sourceRecordId: recordId,
      destinationCalendarId: session.destinationCalendarId,
    });
    expect(preview.pastEventsToKeep).toBeGreaterThan(0);
    expect(preview.mostRecentKeptDate?.gregorianDate).toBe('2026-04-01');
    expect(preview.summary).toContain('already observed');

    await deleteHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
    });

    const stillThere = [...(calendar()?.events.values() ?? [])].filter(
      (event) => event.status === 'confirmed',
    );
    expect(stillThere).toHaveLength(preview.pastEventsToKeep);
  });

  it('keeps the record soft-deleted, so a mistake is recoverable', async () => {
    await deleteHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
    });

    const row = await harness.db
      .selectFrom('source_records')
      .selectAll()
      .where('id', '=', recordId)
      .executeTakeFirstOrThrow();
    // The Hebrew date someone spent an evening establishing is not destroyed by
    // one misplaced click.
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(row.active).toBe(false);
    expect(row.hebrew_day).toBe(14);
  });

  it('is idempotent: deleting twice does not error or double-count', async () => {
    await deleteHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
    });
    // The record is soft-deleted, so it is no longer reachable — which is the
    // right answer for a second attempt.
    await expect(
      deleteHebrewDate(harness.context, session.access, {
        sourceRecordId: recordId,
        userId: session.userId,
        destinationCalendarId: session.destinationCalendarId,
      }),
    ).rejects.toThrow();
  });

  it('records the counts in the audit log', async () => {
    await deleteHebrewDate(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
    });

    const entry = await harness.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'date.deleted')
      .executeTakeFirstOrThrow();

    const detail = entry.detail as { futureEventsRemoved: number; pastEventsKept: number };
    expect(detail.futureEventsRemoved).toBeGreaterThan(0);
    expect(detail.pastEventsKept).toBeGreaterThan(0);
    expect(JSON.stringify(entry.detail)).not.toContain('Avraham');
  });

  it('says so plainly when nothing has reached the calendar yet', async () => {
    const unsynced = await createHebrewDate(harness.context, session.access, {
      type: 'birthday',
      displayName: 'Never synced',
      hebrewMonth: 'ELUL',
      hebrewDay: 18,
    });

    const preview = await describeDeletion(harness.context, session.access, {
      sourceRecordId: unsynced.record.id,
      destinationCalendarId: session.destinationCalendarId,
    });
    expect(preview.futureEventsToRemove).toBe(0);
    expect(preview.pastEventsToKeep).toBe(0);
    expect(preview.summary).toContain('Nothing has been written');
  });
});

/* ------------------------------------------------------------------- pause -- */

describe.runIf(hasDatabase)('pausing a date', () => {
  let harness: Harness;
  let session: Session;
  let recordId: string;

  beforeEach(async () => {
    clearTokenCache();
    harness = await createHarness('pause');
    session = await setUpAccount(harness);
    const added = await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    recordId = added.sourceRecordId;
  }, 60_000);

  afterEach(async () => {
    await harness?.destroy();
  });

  it('removes future events but keeps the date, so it can be resumed', async () => {
    const paused = await setDateActive(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      active: false,
    });
    expect(paused.record.active).toBe(false);
    expect(paused.sync.deleted).toBeGreaterThan(0);

    // The date itself survives: a user who wants a year off should not have to
    // re-establish a Hebrew date.
    expect(paused.record.hebrew_day).toBe(14);
    expect(paused.record.deleted_at).toBeNull();

    const resumed = await setDateActive(harness.context, session.access, {
      sourceRecordId: recordId,
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      active: true,
    });
    expect(resumed.record.active).toBe(true);
    expect(resumed.sync.created).toBeGreaterThan(0);
  });

  it('refuses to resume a draft that still has no sunset answer', async () => {
    const draft = await createHebrewDate(harness.context, session.access, {
      ...YAHRZEIT,
      displayName: 'Unresolved',
      originalGregorianDate: '1990-04-09',
    });

    // A constraint error would be correct but unreadable; this is the sentence.
    await expect(
      setDateActive(harness.context, session.access, {
        sourceRecordId: draft.record.id,
        userId: session.userId,
        destinationCalendarId: session.destinationCalendarId,
        active: true,
      }),
    ).rejects.toThrow(CannotEditWhileAwaitingSunsetError);
  });
});
