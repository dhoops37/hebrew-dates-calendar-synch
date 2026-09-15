/**
 * Repository behaviour, against a real server.
 *
 * The properties under test here are the ones that make synchronisation safe to
 * re-run: persisting the same occurrences twice must update rather than
 * duplicate, and persisting the same destination event twice must not create a
 * second calendar entry. Idempotency is the whole design, and a mock cannot
 * prove `ON CONFLICT` does what it claims.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorise } from '../../src/access';
import { readAuditTrail, recordAuditEvent } from '../../src/audit';
import type { DatasetAccess } from '../../src/access';
import {
  DEFAULT_REMINDERS,
  confirmLocationRow,
  createPersonalDataset,
  createSourceRecord,
  deleteDestinationEventRow,
  getLocation,
  getReminders,
  getSourceRecord,
  listDestinationEvents,
  listOccurrences,
  listSourceRecords,
  markEventFailed,
  markEventSynced,
  pauseSourceRecord,
  saveLocation,
  seedDefaultReminders,
  setHorizon,
  softDeleteSourceRecord,
  upsertDestinationEvent,
  upsertOccurrences,
  upsertUserByEmail,
} from '../../src/repositories';
import { createTestDatabase, describeWithDatabase, type TestDatabase } from '../helpers/database';

describe.runIf(describeWithDatabase)('repositories', () => {
  let harness: TestDatabase;
  let userId: string;
  let datasetId: string;
  let destinationCalendarId: string;
  let access: DatasetAccess;

  beforeAll(async () => {
    harness = await createTestDatabase('repositories');

    const user = await upsertUserByEmail(harness.db, {
      email: 'owner@example.test',
      displayName: 'Owner',
    });
    userId = user.id;

    const created = await createPersonalDataset(harness.db, {
      userId,
      ownerName: 'Owner',
      datasetName: 'My dates',
      calendarName: 'Hebrew Dates',
    });
    datasetId = created.datasetId;
    destinationCalendarId = created.destinationCalendarId;

    access = await authorise(harness.db, { datasetId, userId, minimumRole: 'admin' });
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  /* ------------------------------------------------------------- sign-up -- */

  describe('sign-up', () => {
    it('is idempotent on email, so a second sign-in does not fork the account', async () => {
      const again = await upsertUserByEmail(harness.db, { email: 'owner@example.test' });
      expect(again.created).toBe(false);
      expect(again.id).toBe(userId);
    });

    it('treats email case-insensitively, because citext does', async () => {
      const mixedCase = await upsertUserByEmail(harness.db, { email: 'Owner@Example.Test' });
      expect(mixedCase.created).toBe(false);
      expect(mixedCase.id).toBe(userId);
    });

    it('creates an owner, a membership, a dataset and a calendar together', async () => {
      // All four or none: a half-created account would leave a user who can
      // sign in but has nowhere to put a date.
      const membership = await harness.db
        .selectFrom('owner_members')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(membership.role).toBe('admin');

      const calendar = await harness.db
        .selectFrom('destination_calendars')
        .selectAll()
        .where('id', '=', destinationCalendarId)
        .executeTakeFirstOrThrow();
      expect(calendar.dataset_id).toBe(datasetId);
      expect(calendar.destination_type).toBe('google');
      // Defaults the product depends on, asserted rather than assumed.
      expect(calendar.display_mode).toBe('exact_sunset');
      expect(calendar.event_visibility).toBe('default');
      expect(calendar.language).toBe('en');
      expect(calendar.calendar_timezone_hint).toBeNull();
    });
  });

  /* ------------------------------------------------------------ locations -- */

  describe('locations', () => {
    it('keeps coordinate precision exactly, as strings', async () => {
      const saved = await saveLocation(harness.db, access, {
        destinationCalendarId,
        location: {
          displayName: 'Jerusalem, Israel',
          countryCode: 'IL',
          latitude: 31.778100,
          longitude: 35.235200,
          elevationMeters: 754,
          timezoneId: 'Asia/Jerusalem',
          source: 'user_selected',
        },
        confirmedByUserId: userId,
      });

      expect(saved.latitude).toBe('31.778100');
      expect(saved.longitude).toBe('35.235200');
      expect(saved.elevation_meters).toBe(754);
      expect(saved.use_elevation).toBe(true);
      expect(saved.timezone_id).toBe('Asia/Jerusalem');
      expect(saved.confirmed_at).toBeInstanceOf(Date);
      expect(saved.confirmed_by_user_id).toBe(userId);
    });

    it('replaces the location rather than accumulating rows', async () => {
      await saveLocation(harness.db, access, {
        destinationCalendarId,
        location: {
          displayName: 'Brooklyn, United States',
          countryCode: 'US',
          latitude: 40.6782,
          longitude: -73.9442,
          timezoneId: 'America/New_York',
          source: 'user_selected',
        },
        confirmedByUserId: userId,
      });

      const rows = await harness.db
        .selectFrom('calendar_locations')
        .selectAll()
        .where('destination_calendar_id', '=', destinationCalendarId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.display_name).toBe('Brooklyn, United States');
      // A negative longitude must survive the string round trip too.
      expect(rows[0]?.longitude).toBe('-73.944200');
    });

    it('stores a suggestion unconfirmed, and confirming records who did it', async () => {
      // This is the "never silently choose" rule at the persistence layer: a
      // suggestion the user has not looked at must be distinguishable from one
      // they approved, because the sync planner refuses the former.
      await saveLocation(harness.db, access, {
        destinationCalendarId,
        location: {
          displayName: 'New York, United States',
          countryCode: 'US',
          latitude: 40.7128,
          longitude: -74.006,
          timezoneId: 'America/New_York',
          source: 'timezone_suggestion',
        },
        confirmedByUserId: null,
      });

      const suggested = await getLocation(harness.db, access, destinationCalendarId);
      expect(suggested?.source).toBe('timezone_suggestion');
      expect(suggested?.confirmed_at).toBeNull();
      expect(suggested?.confirmed_by_user_id).toBeNull();

      await confirmLocationRow(harness.db, access, { destinationCalendarId, userId });

      const confirmed = await getLocation(harness.db, access, destinationCalendarId);
      expect(confirmed?.confirmed_at).toBeInstanceOf(Date);
      expect(confirmed?.confirmed_by_user_id).toBe(userId);
      expect(confirmed?.source).toBe('user_selected');
    });
  });

  /* -------------------------------------------------------- source records -- */

  describe('source records', () => {
    it('defaults the Adar convention to observing both Adars', async () => {
      const record = await createSourceRecord(harness.db, access, {
        type: 'personal_yahrzeit',
        displayName: 'Grandfather',
        hebrewMonth: 'ADAR',
        hebrewDay: 10,
        originalHebrewYear: 5745,
      });
      // The user's decision, stored per record so a later halachic review can
      // change the default without touching existing rows.
      expect(record.calculation_convention).toEqual({
        adarOrdinaryYahrzeitInLeapYear: 'both',
      });
      expect(record.active).toBe(true);
      expect(record.deleted_at).toBeNull();
    });

    it('stores an explicit convention override', async () => {
      const record = await createSourceRecord(harness.db, access, {
        type: 'personal_yahrzeit',
        displayName: 'Adar II only',
        hebrewMonth: 'ADAR',
        hebrewDay: 10,
        originalHebrewYear: 5745,
        adarConvention: 'adar_ii',
      });
      expect(record.calculation_convention).toEqual({
        adarOrdinaryYahrzeitInLeapYear: 'adar_ii',
      });
    });

    it('stores the Hebrew month by name, keeping Adar and Adar I distinct', async () => {
      const plain = await createSourceRecord(harness.db, access, {
        type: 'birthday',
        displayName: 'Plain Adar',
        hebrewMonth: 'ADAR',
        hebrewDay: 7,
      });
      const first = await createSourceRecord(harness.db, access, {
        type: 'birthday',
        displayName: 'Adar I',
        hebrewMonth: 'ADAR_I',
        hebrewDay: 7,
      });
      // A numeric month would collapse these two, and they mean different
      // things: one is an ordinary-year date, the other only exists in a leap
      // year.
      expect(plain.hebrew_month).toBe('ADAR');
      expect(first.hebrew_month).toBe('ADAR_I');
    });

    it('hides a soft-deleted record from lists and fetches', async () => {
      const record = await createSourceRecord(harness.db, access, {
        type: 'birthday',
        displayName: 'To be removed',
        hebrewMonth: 'KISLEV',
        hebrewDay: 25,
      });
      await softDeleteSourceRecord(harness.db, access, record.id);

      const listed = await listSourceRecords(harness.db, access);
      expect(listed.map((row) => row.id)).not.toContain(record.id);
      await expect(getSourceRecord(harness.db, access, record.id)).rejects.toThrow();

      // Soft, not hard: the row survives so its calendar events can still be
      // deleted from Google before the record is forgotten.
      const raw = await harness.db
        .selectFrom('source_records')
        .select(['deleted_at', 'active'])
        .where('id', '=', record.id)
        .executeTakeFirstOrThrow();
      expect(raw.deleted_at).toBeInstanceOf(Date);
      expect(raw.active).toBe(false);
    });

    it('pauses and resumes a record without deleting it', async () => {
      const record = await createSourceRecord(harness.db, access, {
        type: 'birthday',
        displayName: 'Pausable',
        hebrewMonth: 'TEVET',
        hebrewDay: 3,
      });
      await pauseSourceRecord(harness.db, access, { sourceRecordId: record.id, active: false });
      expect((await getSourceRecord(harness.db, access, record.id)).active).toBe(false);

      await pauseSourceRecord(harness.db, access, { sourceRecordId: record.id, active: true });
      expect((await getSourceRecord(harness.db, access, record.id)).active).toBe(true);
    });

    it('records the horizon the generator has reached', async () => {
      const record = await createSourceRecord(harness.db, access, {
        type: 'birthday',
        displayName: 'Horizon',
        hebrewMonth: 'SHVAT',
        hebrewDay: 15,
      });
      expect(record.horizon_through_hebrew_year).toBeNull();

      await setHorizon(harness.db, access, { sourceRecordId: record.id, throughHebrewYear: 5806 });
      expect((await getSourceRecord(harness.db, access, record.id)).horizon_through_hebrew_year).toBe(
        5806,
      );
    });
  });

  /* ----------------------------------------------------------- occurrences -- */

  describe('occurrences', () => {
    async function makeRecord(name: string) {
      return createSourceRecord(harness.db, access, {
        type: 'personal_yahrzeit',
        displayName: name,
        hebrewMonth: 'NISAN',
        hebrewDay: 14,
        originalHebrewYear: 5750,
      });
    }

    const occurrence = (key: string, overrides: Record<string, unknown> = {}) => ({
      hebrewYear: 5786,
      sequence: 0,
      occurrenceKey: key.padEnd(32, '0'),
      hebrewMonth: 1,
      hebrewDay: 14,
      gregorianDate: '2026-04-01',
      calculationVersion: 'engine-1',
      ruleApplied: 'yahrzeit_ordinary',
      ambiguities: [],
      ...overrides,
    });

    it('is a no-op to run twice: the same input updates rather than duplicates', async () => {
      const record = await makeRecord('Idempotent');
      const first = await upsertOccurrences(harness.db, access, {
        sourceRecordId: record.id,
        occurrences: [occurrence('idem-a')],
      });
      const second = await upsertOccurrences(harness.db, access, {
        sourceRecordId: record.id,
        occurrences: [occurrence('idem-a')],
      });

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      // Same row, so the destination event keyed to it is untouched and no
      // calendar write happens.
      expect(second[0]?.id).toBe(first[0]?.id);

      const all = await listOccurrences(harness.db, access, { sourceRecordId: record.id });
      expect(all).toHaveLength(1);
    });

    it('updates the Gregorian date in place when a recalculation changes it', async () => {
      const record = await makeRecord('Recalculated');
      const before = await upsertOccurrences(harness.db, access, {
        sourceRecordId: record.id,
        occurrences: [occurrence('recalc')],
      });

      const after = await upsertOccurrences(harness.db, access, {
        sourceRecordId: record.id,
        occurrences: [
          occurrence('recalc', {
            gregorianDate: '2026-04-02',
            calculationVersion: 'engine-2',
            ruleApplied: 'yahrzeit_ordinary_corrected',
            ambiguities: [{ code: 'ADAR_AMBIGUITY' }],
          }),
        ],
      });

      // The row identity is preserved, so the event that points at it can be
      // *updated* in Google rather than deleted and recreated.
      expect(after[0]?.id).toBe(before[0]?.id);
      expect(after[0]?.gregorian_date).toBe('2026-04-02');
      expect(after[0]?.calculation_version).toBe('engine-2');
      expect(after[0]?.rule_applied).toBe('yahrzeit_ordinary_corrected');
      expect(after[0]?.ambiguities).toEqual([{ code: 'ADAR_AMBIGUITY' }]);
      expect(after[0]?.updated_at.getTime()).toBeGreaterThanOrEqual(
        before[0]!.updated_at.getTime(),
      );
    });

    it('persists both Adars of one Hebrew year as two rows', async () => {
      const record = await makeRecord('Both Adars');
      const rows = await upsertOccurrences(harness.db, access, {
        sourceRecordId: record.id,
        occurrences: [
          occurrence('adar-i', { sequence: 0, hebrewMonth: 12, gregorianDate: '2026-02-27' }),
          occurrence('adar-ii', { sequence: 1, hebrewMonth: 13, gregorianDate: '2026-03-28' }),
        ],
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.sequence).sort()).toEqual([0, 1]);
    });

    it('does nothing at all when handed an empty list', async () => {
      const record = await makeRecord('Empty');
      await expect(
        upsertOccurrences(harness.db, access, { sourceRecordId: record.id, occurrences: [] }),
      ).resolves.toEqual([]);
    });

    it('lists upcoming occurrences in date order, filtered from a given day', async () => {
      const record = await makeRecord('Ordered');
      await upsertOccurrences(harness.db, access, {
        sourceRecordId: record.id,
        occurrences: [
          occurrence('ord-1', { hebrewYear: 5786, gregorianDate: '2026-04-01' }),
          occurrence('ord-2', { hebrewYear: 5787, gregorianDate: '2027-04-21' }),
          occurrence('ord-3', { hebrewYear: 5788, gregorianDate: '2028-04-09' }),
        ],
      });

      const all = await listOccurrences(harness.db, access, { sourceRecordId: record.id });
      expect(all.map((row) => row.gregorian_date)).toEqual([
        '2026-04-01',
        '2027-04-21',
        '2028-04-09',
      ]);

      const future = await listOccurrences(harness.db, access, {
        sourceRecordId: record.id,
        fromGregorianDate: '2027-01-01',
      });
      expect(future.map((row) => row.gregorian_date)).toEqual(['2027-04-21', '2028-04-09']);
    });

    it('excludes occurrences of a soft-deleted record', async () => {
      const record = await makeRecord('Deleted parent');
      await upsertOccurrences(harness.db, access, {
        sourceRecordId: record.id,
        occurrences: [occurrence('del-parent')],
      });
      await softDeleteSourceRecord(harness.db, access, record.id);

      const listed = await listOccurrences(harness.db, access, { sourceRecordId: record.id });
      expect(listed).toHaveLength(0);
    });
  });

  /* ---------------------------------------------------- destination events -- */

  describe('destination events', () => {
    async function makeOccurrenceId(key: string): Promise<string> {
      const record = await createSourceRecord(harness.db, access, {
        type: 'birthday',
        displayName: `Event ${key}`,
        hebrewMonth: 'TISHREI',
        hebrewDay: 10,
      });
      const [row] = await upsertOccurrences(harness.db, access, {
        sourceRecordId: record.id,
        occurrences: [
          {
            hebrewYear: 5787,
            sequence: 0,
            occurrenceKey: key.padEnd(32, '0'),
            hebrewMonth: 7,
            hebrewDay: 10,
            gregorianDate: '2026-09-21',
            calculationVersion: 'engine-1',
            ruleApplied: 'birthday_ordinary',
            ambiguities: [],
          },
        ],
      });
      return row!.id;
    }

    it('upserts on (occurrence, calendar), so re-planning does not double-write', async () => {
      const occurrenceId = await makeOccurrenceId('de-1');
      const first = await upsertDestinationEvent(harness.db, {
        generatedOccurrenceId: occurrenceId,
        destinationCalendarId,
        destinationType: 'google',
        externalCalendarId: null,
        externalEventId: null,
        startAt: new Date('2026-09-20T18:45:00Z'),
        endAt: new Date('2026-09-21T18:44:00Z'),
        timezoneId: 'Asia/Jerusalem',
        locationSnapshot: { displayName: 'Jerusalem, Israel' },
        contentHash: 'a'.repeat(32),
        syncStatus: 'pending',
      });

      const second = await upsertDestinationEvent(harness.db, {
        generatedOccurrenceId: occurrenceId,
        destinationCalendarId,
        destinationType: 'google',
        externalCalendarId: null,
        externalEventId: null,
        startAt: new Date('2026-09-20T18:45:00Z'),
        endAt: new Date('2026-09-21T18:44:00Z'),
        timezoneId: 'Asia/Jerusalem',
        locationSnapshot: { displayName: 'Jerusalem, Israel' },
        contentHash: 'a'.repeat(32),
        syncStatus: 'pending',
      });

      expect(second.id).toBe(first.id);
      expect(second.location_snapshot).toEqual({ displayName: 'Jerusalem, Israel' });

      const events = await listDestinationEvents(harness.db, access, destinationCalendarId);
      expect(events.filter((row) => row.generated_occurrence_id === occurrenceId)).toHaveLength(1);
    });

    it('records a successful write and clears the failure state', async () => {
      const occurrenceId = await makeOccurrenceId('de-2');
      const event = await upsertDestinationEvent(harness.db, {
        generatedOccurrenceId: occurrenceId,
        destinationCalendarId,
        destinationType: 'google',
        externalCalendarId: null,
        externalEventId: null,
        startAt: null,
        endAt: null,
        timezoneId: 'UTC',
        locationSnapshot: {},
        contentHash: 'b'.repeat(32),
        syncStatus: 'pending',
      });

      await markEventFailed(harness.db, {
        destinationEventId: event.id,
        error: 'rateLimitExceeded',
        nextAttemptAt: new Date(Date.now() + 30_000),
        terminal: false,
      });
      const failed = await harness.db
        .selectFrom('destination_events')
        .selectAll()
        .where('id', '=', event.id)
        .executeTakeFirstOrThrow();
      expect(failed.sync_status).toBe('retry_scheduled');
      expect(failed.attempt_count).toBe(1);
      expect(failed.next_attempt_at).toBeInstanceOf(Date);
      expect(failed.last_error).toBe('rateLimitExceeded');

      await markEventSynced(harness.db, {
        destinationEventId: event.id,
        externalEventId: 'v5k3j2h1',
        externalCalendarId: 'hebrewdates@group.calendar.google.com',
        contentHash: 'c'.repeat(32),
      });
      const synced = await harness.db
        .selectFrom('destination_events')
        .selectAll()
        .where('id', '=', event.id)
        .executeTakeFirstOrThrow();

      expect(synced.sync_status).toBe('synced');
      expect(synced.external_event_id).toBe('v5k3j2h1');
      expect(synced.content_hash).toBe('c'.repeat(32));
      // Cleared, so an old error is not shown next to a now-healthy event.
      expect(synced.attempt_count).toBe(0);
      expect(synced.next_attempt_at).toBeNull();
      expect(synced.last_error).toBeNull();
      expect(synced.last_synced_at).toBeInstanceOf(Date);
    });

    it('increments the attempt count on each failure and can end terminally', async () => {
      const occurrenceId = await makeOccurrenceId('de-3');
      const event = await upsertDestinationEvent(harness.db, {
        generatedOccurrenceId: occurrenceId,
        destinationCalendarId,
        destinationType: 'google',
        externalCalendarId: null,
        externalEventId: null,
        startAt: null,
        endAt: null,
        timezoneId: 'UTC',
        locationSnapshot: {},
        contentHash: 'd'.repeat(32),
        syncStatus: 'pending',
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await markEventFailed(harness.db, {
          destinationEventId: event.id,
          error: `attempt ${attempt}`,
          nextAttemptAt: new Date(Date.now() + 1000),
          terminal: false,
        });
      }
      await markEventFailed(harness.db, {
        destinationEventId: event.id,
        error: 'x'.repeat(2000),
        nextAttemptAt: null,
        terminal: true,
      });

      const row = await harness.db
        .selectFrom('destination_events')
        .selectAll()
        .where('id', '=', event.id)
        .executeTakeFirstOrThrow();
      expect(row.attempt_count).toBe(4);
      expect(row.sync_status).toBe('failed');
      expect(row.next_attempt_at).toBeNull();
      // Truncated, because this string is rendered in the dashboard.
      expect(row.last_error).toHaveLength(500);
    });

    it('deletes the row once the calendar event is gone', async () => {
      const occurrenceId = await makeOccurrenceId('de-4');
      const event = await upsertDestinationEvent(harness.db, {
        generatedOccurrenceId: occurrenceId,
        destinationCalendarId,
        destinationType: 'google',
        externalCalendarId: 'cal',
        externalEventId: 'gone',
        startAt: null,
        endAt: null,
        timezoneId: 'UTC',
        locationSnapshot: {},
        contentHash: 'e'.repeat(32),
        syncStatus: 'deleting',
      });

      await deleteDestinationEventRow(harness.db, event.id);
      const remaining = await harness.db
        .selectFrom('destination_events')
        .select('id')
        .where('id', '=', event.id)
        .execute();
      expect(remaining).toHaveLength(0);
    });

    it('exposes the occurrence key alongside each event', async () => {
      // The reconciliation planner keys on this, so the join must carry it.
      const occurrenceId = await makeOccurrenceId('de-5');
      await upsertDestinationEvent(harness.db, {
        generatedOccurrenceId: occurrenceId,
        destinationCalendarId,
        destinationType: 'google',
        externalCalendarId: null,
        externalEventId: null,
        startAt: null,
        endAt: null,
        timezoneId: 'UTC',
        locationSnapshot: {},
        contentHash: 'f'.repeat(32),
        syncStatus: 'pending',
      });

      const events = await listDestinationEvents(harness.db, access, destinationCalendarId);
      const mine = events.find((row) => row.generated_occurrence_id === occurrenceId);
      expect(mine?.occurrence_key).toBe('de-5'.padEnd(32, '0'));
    });
  });

  /* ------------------------------------------------------------ reminders -- */

  describe('reminders', () => {
    it('seeds the documented defaults per event type', async () => {
      await seedDefaultReminders(harness.db, destinationCalendarId);

      const record = await createSourceRecord(harness.db, access, {
        type: 'personal_yahrzeit',
        displayName: 'Reminder subject',
        hebrewMonth: 'IYYAR',
        hebrewDay: 5,
        originalHebrewYear: 5740,
      });

      const yahrzeit = await getReminders(harness.db, {
        destinationCalendarId,
        sourceRecordId: record.id,
        eventType: 'personal_yahrzeit',
      });
      // 7 days, 1 day, and at the start of the event.
      expect(yahrzeit.map((row) => row.minutesBeforeStart).sort((a, b) => b - a)).toEqual([
        10_080, 1440, 0,
      ]);
      expect(yahrzeit.every((row) => row.enabled)).toBe(true);
      expect(DEFAULT_REMINDERS.personal_yahrzeit).toEqual([10_080, 1440, 0]);
    });

    it('gives a birthday its own defaults, not the yahrzeit set', async () => {
      const record = await createSourceRecord(harness.db, access, {
        type: 'birthday',
        displayName: 'Birthday reminders',
        hebrewMonth: 'IYYAR',
        hebrewDay: 6,
      });
      const reminders = await getReminders(harness.db, {
        destinationCalendarId,
        sourceRecordId: record.id,
        eventType: 'birthday',
      });
      expect(reminders.map((row) => row.minutesBeforeStart).sort((a, b) => b - a)).toEqual([
        1440, 0,
      ]);
    });

    it('lets a per-record override replace the calendar defaults entirely', async () => {
      // Replace, not merge: "remind me only on the day" must not leave the
      // seven-day default in place.
      const record = await createSourceRecord(harness.db, access, {
        type: 'personal_yahrzeit',
        displayName: 'Overridden',
        hebrewMonth: 'IYYAR',
        hebrewDay: 7,
        originalHebrewYear: 5740,
      });

      await harness.db
        .insertInto('reminder_rules')
        .values({ source_record_id: record.id, minutes_before_start: 0 })
        .execute();

      const reminders = await getReminders(harness.db, {
        destinationCalendarId,
        sourceRecordId: record.id,
        eventType: 'personal_yahrzeit',
      });
      expect(reminders).toEqual([{ minutesBeforeStart: 0, enabled: true }]);
    });

    it('keeps a disabled rule visible, so the UI can show it switched off', async () => {
      const record = await createSourceRecord(harness.db, access, {
        type: 'personal_yahrzeit',
        displayName: 'Disabled reminder',
        hebrewMonth: 'IYYAR',
        hebrewDay: 8,
        originalHebrewYear: 5740,
      });
      await harness.db
        .insertInto('reminder_rules')
        .values({ source_record_id: record.id, minutes_before_start: 1440, enabled: false })
        .execute();

      const reminders = await getReminders(harness.db, {
        destinationCalendarId,
        sourceRecordId: record.id,
        eventType: 'personal_yahrzeit',
      });
      expect(reminders).toEqual([{ minutesBeforeStart: 1440, enabled: false }]);
    });
  });

  /* ------------------------------------------------------------ audit log -- */

  describe('audit log', () => {
    it('records a typed event with its actor', async () => {
      await recordAuditEvent(
        harness.db,
        {
          action: 'location.confirmed',
          subjectType: 'destination_calendar',
          subjectId: destinationCalendarId,
          timezoneId: 'Asia/Jerusalem',
          source: 'user_selected',
        },
        { actorUserId: userId },
      );

      const entry = await harness.db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'location.confirmed')
        .executeTakeFirstOrThrow();

      expect(entry.actor_user_id).toBe(userId);
      expect(entry.subject_id).toBe(destinationCalendarId);
      // Only the declared fields: the zone and the source, never the
      // coordinates and never the place's name.
      expect(entry.detail).toEqual({ timezoneId: 'Asia/Jerusalem', source: 'user_selected' });
      expect(entry.at).toBeInstanceOf(Date);
    });

    it('accepts a system action with no actor', async () => {
      await recordAuditEvent(
        harness.db,
        {
          action: 'job.failed',
          subjectType: 'sync_job',
          subjectId: '00000000-0000-4000-8000-000000000001',
          jobType: 'reconcile',
          failureKind: 'google.transient',
        },
        { actorUserId: null },
      );
      const entry = await harness.db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'job.failed')
        .executeTakeFirstOrThrow();
      expect(entry.actor_user_id).toBeNull();
      expect(entry.detail).toEqual({ jobType: 'reconcile', failureKind: 'google.transient' });
    });

    it('refuses an unsafe value before it reaches the database', async () => {
      // The guard fires at the writer, so nothing lands even partially.
      await expect(
        recordAuditEvent(
          harness.db,
          {
            action: 'calendar.created',
            subjectType: 'destination_calendar',
            subjectId: destinationCalendarId,
            googleCalendarId: 'Avraham ben Yitzchak' as string,
          },
          { actorUserId: userId },
        ),
      ).rejects.toThrow(/does not accept/);

      const rows = await harness.db
        .selectFrom('audit_log')
        .select('id')
        .where('action', '=', 'calendar.created')
        .execute();
      expect(rows).toHaveLength(0);
    });

    it('reads a subject\'s trail newest first', async () => {
      const subjectId = '00000000-0000-4000-8000-000000000002';
      for (const active of [false, true]) {
        await recordAuditEvent(
          harness.db,
          { action: 'date.paused', subjectType: 'source_record', subjectId, active },
          { actorUserId: userId, at: new Date(active ? Date.now() : Date.now() - 60_000) },
        );
      }
      const trail = await readAuditTrail(harness.db, {
        subjectType: 'source_record',
        subjectId,
      });
      expect(trail).toHaveLength(2);
      expect((trail[0]?.detail as { active: boolean }).active).toBe(true);
    });
  });
});
