/**
 * The unknown-sunset-status flow.
 *
 * The behaviour under test is the one the product is built around: when a user
 * does not know whether a death was before or after sunset, they get a question
 * with both answers laid out — not an error, and not a guess.
 *
 * Every assertion here is about that. The draft is storable, it generates
 * nothing, it cannot be activated without an answer even by a direct UPDATE,
 * and the answer the user gives is what decides the Hebrew date.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorise, type DatasetAccess } from '@hebrew-dates/db';
import {
  addDateAndSync,
  beginGoogleSignIn,
  completeGoogleSignIn,
  confirmLocation,
  createHebrewDate,
  describeSunsetDecision,
  ensureGoogleCalendar,
  listAwaitingSunsetDecision,
  needsSunsetDecision,
  pendingSunsetDecision,
  resolveSunsetStatus,
  syncDestination,
  NotAwaitingSunsetError,
  SunsetAlreadyResolvedError,
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

/** 9 April 1990: 14 Nisan 5750 by day, 15 Nisan 5750 after sunset. */
const GREGORIAN_ENTRY = {
  type: 'personal_yahrzeit' as const,
  displayName: 'Avraham ben Yitzchak',
  hebrewMonth: 'NISAN' as const,
  hebrewDay: 14,
  originalGregorianDate: '1990-04-09',
  originalHebrewYear: 5750,
};

/* ------------------------------------------------------------------ pure -- */

describe('describeSunsetDecision', () => {
  it('offers exactly two candidates, a day apart in the Hebrew calendar', () => {
    const decision = describeSunsetDecision({
      gregorianDate: { year: 1990, month: 4, day: 9 },
      location: { ...JERUSALEM, source: 'user_selected' },
    });

    expect(decision.candidates).toHaveLength(2);
    const [before, after] = decision.candidates;
    expect(before.choice).toBe('before_sunset');
    expect(after.choice).toBe('after_sunset');
    // The whole point: the two are consecutive Hebrew days.
    expect(after.hebrewDay).toBe(before.hebrewDay + 1);
    expect(before.hebrewDateLabel).toContain('Nisan');
    expect(after.hebrewDateLabel).toContain('Nisan');
  });

  it('shows the calculated sunset at the location', () => {
    const decision = describeSunsetDecision({
      gregorianDate: { year: 1990, month: 4, day: 9 },
      location: { ...JERUSALEM, source: 'user_selected' },
    });

    expect(decision.sunset?.localTime).toMatch(/^\d{2}:\d{2}$/);
    expect(decision.sunset?.locationDisplayName).toBe('Jerusalem, Israel');
    expect(decision.sunset?.timezoneId).toBe('Asia/Jerusalem');
    // Early April in Jerusalem: sunset is around seven in the evening.
    const hour = Number(decision.sunset?.localTime.slice(0, 2));
    expect(hour).toBeGreaterThanOrEqual(18);
    expect(hour).toBeLessThanOrEqual(20);
  });

  it('still offers both candidates with no location at all', () => {
    // The sunset time is help for answering, not an input to the question. A
    // user who has not set a location yet must still be able to answer it.
    const decision = describeSunsetDecision({ gregorianDate: { year: 1990, month: 4, day: 9 } });
    expect(decision.candidates).toHaveLength(2);
    expect(decision.sunset).toBeUndefined();
  });

  it('offers both candidates where the sun does not set', () => {
    // Tromsø in June. No sunset, so no time to show — but the Hebrew day
    // boundary still exists and the question is still answerable.
    const decision = describeSunsetDecision({
      gregorianDate: { year: 1990, month: 6, day: 21 },
      location: {
        id: 'tromso',
        displayName: 'Tromsø, Norway',
        countryCode: 'NO',
        latitude: 69.6492,
        longitude: 18.9553,
        timezoneId: 'Europe/Oslo',
        source: 'user_selected',
      },
    });
    expect(decision.candidates).toHaveLength(2);
    expect(decision.sunset).toBeUndefined();
  });

  it('explains why the answer matters, and where to find it', () => {
    const decision = describeSunsetDecision({ gregorianDate: { year: 1990, month: 4, day: 9 } });
    expect(decision.explanation).toContain('begins at sunset');
    expect(decision.explanation).toContain('will not guess');
    expect(decision.whereToLook.length).toBeGreaterThanOrEqual(3);
    expect(decision.whereToLook.join(' ')).toMatch(/certificate/i);
  });

  it('says what each choice means in plain language', () => {
    const decision = describeSunsetDecision({ gregorianDate: { year: 1990, month: 4, day: 9 } });
    expect(decision.candidates[0].meaning).toContain('before the sun went down');
    expect(decision.candidates[1].meaning).toContain('already the next day');
  });
});

/* ---------------------------------------------------------- the draft path -- */

describe.runIf(hasDatabase)('an unresolved Gregorian entry', () => {
  let harness: Harness;
  let session: Session;

  beforeEach(async () => {
    clearTokenCache();
    harness = await createHarness('sunset');
    session = await setUpAccount(harness);
  }, 60_000);

  afterEach(async () => {
    await harness?.destroy();
  });

  it('is stored as a draft rather than refused', async () => {
    // This is the fix. Previously this threw and the dashboard showed an error.
    const created = await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);

    expect(created.awaitingSunsetDecision).toBe(true);
    expect(created.record.active).toBe(false);
    expect(created.record.sunset_status).toBeNull();
    expect(created.occurrencesPersisted).toBe(0);
  });

  it('derives the stored Hebrew date rather than keeping what was sent', async () => {
    // The web form has no Hebrew month to send in Gregorian mode, so it sends a
    // placeholder. Storing that placeholder would put a Hebrew date on the
    // record that corresponds to neither candidate — here, 1 Tishrei for a
    // death on 9 April. The draft holds the before-sunset reading instead.
    const created = await createHebrewDate(harness.context, session.access, {
      ...GREGORIAN_ENTRY,
      hebrewMonth: 'TISHREI',
      hebrewDay: 1,
      originalHebrewYear: undefined,
    });

    expect(created.record.hebrew_month).toBe('NISAN');
    expect(created.record.hebrew_day).toBe(14);
    expect(created.record.original_hebrew_year).toBe(5750);
  });

  it('generates nothing and writes nothing to the calendar', async () => {
    await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);

    const occurrences = await harness.db.selectFrom('generated_occurrences').selectAll().execute();
    expect(occurrences).toHaveLength(0);

    const result = await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(result.created).toBe(0);

    const calendarId = harness.google.calendarIds()[0] as string;
    expect(harness.google.calendar(calendarId)?.events.size).toBe(0);
  });

  it('cannot be activated while the answer is missing, even by a direct update', async () => {
    // The refusal is now the database's, not a thrown error's — which means no
    // code path, including one written later, can generate from a guess.
    const created = await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);

    await expect(
      harness.db
        .updateTable('source_records')
        .set({ active: true })
        .where('id', '=', created.record.id)
        .execute(),
    ).rejects.toThrow(/unresolved_sunset_entry_cannot_be_active/);
  });

  it('appears in the list of dates waiting for an answer', async () => {
    const created = await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);

    const waiting = await listAwaitingSunsetDecision(harness.context, session.access);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      id: created.record.id,
      displayName: 'Avraham ben Yitzchak',
      gregorianDate: '1990-04-09',
    });
  });

  it('is recognisable as needing a decision', async () => {
    const created = await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);
    expect(needsSunsetDecision(created.record)).toBe(true);

    const resolved = await createHebrewDate(harness.context, session.access, {
      ...GREGORIAN_ENTRY,
      displayName: 'Already answered',
      sunsetStatus: 'before_sunset',
    });
    expect(needsSunsetDecision(resolved.record)).toBe(false);
  });

  it('serves the question with both candidates and the local sunset', async () => {
    const created = await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);

    const decision = await pendingSunsetDecision(harness.context, session.access, {
      sourceRecordId: created.record.id,
      destinationCalendarId: session.destinationCalendarId,
    });

    expect(decision?.gregorianDate).toBe('1990-04-09');
    expect(decision?.candidates).toHaveLength(2);
    expect(decision?.sunset?.localTime).toMatch(/^\d{2}:\d{2}$/);
    // The location the user actually confirmed, not a default.
    expect(decision?.sunset?.locationDisplayName).toBe('Jerusalem, Israel');
  });

  it('serves no question for a Hebrew-entered date', async () => {
    const created = await createHebrewDate(harness.context, session.access, {
      type: 'birthday',
      displayName: 'Hebrew entry',
      hebrewMonth: 'SIVAN',
      hebrewDay: 6,
    });
    await expect(
      pendingSunsetDecision(harness.context, session.access, {
        sourceRecordId: created.record.id,
      }),
    ).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------ the answer -- */

describe.runIf(hasDatabase)('answering the sunset question', () => {
  let harness: Harness;
  let session: Session;

  beforeEach(async () => {
    clearTokenCache();
    harness = await createHarness('sunset-answer');
    session = await setUpAccount(harness);
  }, 60_000);

  afterEach(async () => {
    await harness?.destroy();
  });

  it.each([
    ['before_sunset' as const, 'NISAN', 14],
    ['after_sunset' as const, 'NISAN', 15],
  ])(
    'answering %s at entry time reaches the same Hebrew date as answering later',
    async (sunsetStatus, expectedMonth, expectedDay) => {
      // Two routes to the same record: the user knew at entry, or the user
      // answered the question afterwards. They must not disagree.
      const atEntry = await createHebrewDate(harness.context, session.access, {
        ...GREGORIAN_ENTRY,
        hebrewMonth: 'TISHREI',
        hebrewDay: 1,
        originalHebrewYear: undefined,
        sunsetStatus,
      });

      expect(atEntry.awaitingSunsetDecision).toBe(false);
      expect(atEntry.record.active).toBe(true);
      expect(atEntry.record.hebrew_month).toBe(expectedMonth);
      expect(atEntry.record.hebrew_day).toBe(expectedDay);
      expect(atEntry.record.original_hebrew_year).toBe(5750);
      expect(atEntry.occurrencesPersisted).toBeGreaterThan(0);

      const draft = await createHebrewDate(harness.context, session.access, {
        ...GREGORIAN_ENTRY,
        displayName: 'Answered later',
        hebrewMonth: 'TISHREI',
        hebrewDay: 1,
        originalHebrewYear: undefined,
      });
      const answered = await resolveSunsetStatus(harness.context, session.access, {
        sourceRecordId: draft.record.id,
        choice: sunsetStatus,
        destinationCalendarId: session.destinationCalendarId,
      });

      expect(answered.record.hebrew_month).toBe(atEntry.record.hebrew_month);
      expect(answered.record.hebrew_day).toBe(atEntry.record.hebrew_day);
      expect(answered.record.original_hebrew_year).toBe(atEntry.record.original_hebrew_year);
    },
  );

  it.each([
    ['before_sunset' as const, 14],
    ['after_sunset' as const, 15],
  ])('records %s and settles on %s Nisan', async (choice, expectedDay) => {
    const created = await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);

    const resolved = await resolveSunsetStatus(harness.context, session.access, {
      sourceRecordId: created.record.id,
      choice,
      destinationCalendarId: session.destinationCalendarId,
    });

    expect(resolved.record.sunset_status).toBe(choice);
    expect(resolved.record.hebrew_day).toBe(expectedDay);
    expect(resolved.record.hebrew_month).toBe('NISAN');
    expect(resolved.record.active).toBe(true);
    expect(resolved.hebrewDateLabel).toContain(String(expectedDay));
    expect(resolved.occurrencesPersisted).toBeGreaterThan(0);
  });

  it('recomputes the Hebrew date rather than trusting the request', async () => {
    // The form sends only which of the two it was. A Hebrew month supplied
    // alongside a Gregorian date is discarded at both steps: on creation, where
    // the before-sunset reading is derived, and on the answer, where the chosen
    // reading is.
    const created = await createHebrewDate(harness.context, session.access, {
      ...GREGORIAN_ENTRY,
      // Deliberately wrong. Neither candidate is in Elul.
      hebrewMonth: 'ELUL',
      hebrewDay: 1,
    });
    expect(created.record.hebrew_month).toBe('NISAN');

    const resolved = await resolveSunsetStatus(harness.context, session.access, {
      sourceRecordId: created.record.id,
      choice: 'after_sunset',
      destinationCalendarId: session.destinationCalendarId,
    });
    expect(resolved.record.hebrew_month).toBe('NISAN');
    expect(resolved.record.hebrew_day).toBe(15);
  });

  it('writes events to the calendar once answered', async () => {
    const created = await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);
    await resolveSunsetStatus(harness.context, session.access, {
      sourceRecordId: created.record.id,
      choice: 'after_sunset',
      destinationCalendarId: session.destinationCalendarId,
    });

    const sync = await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(sync.created).toBeGreaterThan(0);

    const calendarId = harness.google.calendarIds()[0] as string;
    expect(harness.google.calendar(calendarId)?.events.size).toBeGreaterThan(0);
  });

  it('removes the record from the waiting list', async () => {
    const created = await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);
    await resolveSunsetStatus(harness.context, session.access, {
      sourceRecordId: created.record.id,
      choice: 'before_sunset',
    });
    await expect(
      listAwaitingSunsetDecision(harness.context, session.access),
    ).resolves.toEqual([]);
  });

  it('refuses a second answer, rather than silently overwriting the first', async () => {
    const created = await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);
    await resolveSunsetStatus(harness.context, session.access, {
      sourceRecordId: created.record.id,
      choice: 'before_sunset',
    });

    await expect(
      resolveSunsetStatus(harness.context, session.access, {
        sourceRecordId: created.record.id,
        choice: 'after_sunset',
      }),
    ).rejects.toThrow(SunsetAlreadyResolvedError);
  });

  it('refuses for a date that was never entered as Gregorian', async () => {
    const created = await createHebrewDate(harness.context, session.access, {
      type: 'birthday',
      displayName: 'Hebrew entry',
      hebrewMonth: 'SIVAN',
      hebrewDay: 6,
    });
    await expect(
      resolveSunsetStatus(harness.context, session.access, {
        sourceRecordId: created.record.id,
        choice: 'before_sunset',
      }),
    ).rejects.toThrow(NotAwaitingSunsetError);
  });

  it('records the answer in the audit log without the person\'s name', async () => {
    const created = await createHebrewDate(harness.context, session.access, GREGORIAN_ENTRY);
    await resolveSunsetStatus(harness.context, session.access, {
      sourceRecordId: created.record.id,
      choice: 'before_sunset',
    });

    const entries = await harness.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'date.edited')
      .execute();

    expect(entries).toHaveLength(1);
    const serialised = JSON.stringify(entries[0]?.detail);
    expect(serialised).toContain('sunsetStatus');
    expect(serialised).not.toContain('Avraham');
  });

  it('refuses to add a date through the normal flow without an answer', async () => {
    // `addDateAndSync` is the one-step path. A Gregorian entry with no answer
    // must come back as "needs an answer", not as a thrown error.
    const result = await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: GREGORIAN_ENTRY,
    });

    expect(result.awaitingSunsetDecision).toBe(true);
    expect(result.sync.created).toBe(0);
    expect(result.sunsetDecision?.candidates).toHaveLength(2);
  });
});
