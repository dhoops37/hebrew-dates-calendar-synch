/**
 * The database's product rules, proved against a real PostgreSQL server.
 *
 * Every assertion here is a rule that must hold even if the application layer
 * has a bug: an under-specified yahrzeit that cannot be calculated must not be
 * storable, a duplicate calendar event must not be registrable, and an
 * unconfirmed location must be distinguishable from a confirmed one. The
 * constraint name is pinned in each case, because "it threw" would also pass if
 * the row were rejected for a typo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  describeWithDatabase,
  expectRejection,
  seedTenant,
  type TestDatabase,
  type Tenant,
} from '../helpers/database';

describe.runIf(describeWithDatabase)('database constraints', () => {
  let harness: TestDatabase;
  let tenant: Tenant;

  beforeAll(async () => {
    harness = await createTestDatabase('constraints');
    tenant = await seedTenant(harness.db, 'a');
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  /* -------------------------------------------------- the sunset-status rule -- */

  describe('a Gregorian-entered date must state which side of sunset it fell on', () => {
    it('refuses a Gregorian original date with no sunset status', async () => {
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('source_records')
          .values({
            dataset_id: tenant.datasetId,
            type: 'personal_yahrzeit',
            display_name: 'Unspecified sunset',
            hebrew_month: 'NISAN',
            hebrew_day: 14,
            original_hebrew_year: 5750,
            original_gregorian_date: '1990-04-09',
            sunset_status: null,
          })
          .execute(),
      );
      expect(failure.constraint).toBe('gregorian_entry_needs_sunset_status');
    });

    it('accepts the same row once the sunset status is stated', async () => {
      const row = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'personal_yahrzeit',
          display_name: 'Stated sunset',
          hebrew_month: 'NISAN',
          hebrew_day: 14,
          original_hebrew_year: 5750,
          original_gregorian_date: '1990-04-09',
          sunset_status: 'after_sunset',
        })
        .returning(['id', 'original_gregorian_date'])
        .executeTakeFirstOrThrow();

      // A calendar day, not an instant: it must survive the round trip as text.
      expect(row.original_gregorian_date).toBe('1990-04-09');
    });

    it('allows a Hebrew-only entry with no Gregorian date and no sunset status', async () => {
      const row = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'birthday',
          display_name: 'Hebrew-only entry',
          hebrew_month: 'SIVAN',
          hebrew_day: 6,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect(row.id).toBeTruthy();
    });
  });

  /* ------------------------------------------------- the 30th-of-the-month rule -- */

  describe('a yahrzeit on the 30th needs the Hebrew year of death', () => {
    it.each(['CHESHVAN', 'KISLEV'] as const)(
      'refuses 30 %s without an origin year',
      async (month) => {
        const failure = await expectRejection(() =>
          harness.db
            .insertInto('source_records')
            .values({
              dataset_id: tenant.datasetId,
              type: 'personal_yahrzeit',
              display_name: `30 ${month}`,
              hebrew_month: month,
              hebrew_day: 30,
              original_hebrew_year: null,
            })
            .execute(),
        );
        expect(failure.constraint).toBe('yahrzeit_30th_needs_origin_year');
      },
    );

    it('accepts 30 Kislev with an origin year, because the rule is then decidable', async () => {
      const row = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'personal_yahrzeit',
          display_name: '30 Kislev, year known',
          hebrew_month: 'KISLEV',
          hebrew_day: 30,
          original_hebrew_year: 5760,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect(row.id).toBeTruthy();
    });

    it('allows a birthday on the 30th without an origin year', async () => {
      // Birthdays do not depend on the character of the following year, so the
      // constraint exempts them deliberately rather than by omission.
      const row = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'birthday',
          display_name: '30 Cheshvan birthday',
          hebrew_month: 'CHESHVAN',
          hebrew_day: 30,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect(row.id).toBeTruthy();
    });
  });

  /* --------------------------------------------- months that have no 30th day -- */

  describe('months that never have a 30th day', () => {
    it.each(['ADAR', 'ADAR_II', 'IYYAR', 'TAMUZ', 'ELUL', 'TEVET'] as const)(
      'refuses 30 %s',
      async (month) => {
        const failure = await expectRejection(() =>
          harness.db
            .insertInto('source_records')
            .values({
              dataset_id: tenant.datasetId,
              type: 'birthday',
              display_name: `30 ${month}`,
              hebrew_month: month,
              hebrew_day: 30,
            })
            .execute(),
        );
        expect(failure.constraint).toBe('adar_ii_has_no_30th');
      },
    );

    it('permits 30 Adar I, which exists in a leap year', async () => {
      const row = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'birthday',
          display_name: '30 Adar I',
          hebrew_month: 'ADAR_I',
          hebrew_day: 30,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect(row.id).toBeTruthy();
    });

    it('refuses a day outside 1..30 entirely', async () => {
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('source_records')
          .values({
            dataset_id: tenant.datasetId,
            type: 'birthday',
            display_name: 'Day 31',
            hebrew_month: 'NISAN',
            hebrew_day: 31,
          })
          .execute(),
      );
      expect(failure.code).toBe('23514');
    });

    it('refuses a month name that is not a Hebrew month', async () => {
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('source_records')
          .values({
            dataset_id: tenant.datasetId,
            type: 'birthday',
            display_name: 'Bad month',
            // Deliberately invalid: the check constraint, not TypeScript, is
            // what protects a hand-written query or a bad migration.
            hebrew_month: 'MARCHESHVAN' as 'CHESHVAN',
            hebrew_day: 1,
          })
          .execute(),
      );
      expect(failure.code).toBe('23514');
    });
  });

  /* ------------------------------------------------------------- locations -- */

  describe('locations', () => {
    it('refuses a confirmation with no confirmer', async () => {
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('calendar_locations')
          .values({
            destination_calendar_id: tenant.destinationCalendarId,
            display_name: 'Nowhere',
            country_code: 'US',
            latitude: '40.000000',
            longitude: '-74.000000',
            timezone_id: 'America/New_York',
            confirmed_at: new Date(),
            confirmed_by_user_id: null,
          })
          .execute(),
      );
      expect(failure.constraint).toBe('confirmation_requires_a_confirmer');
    });

    it('allows an unconfirmed suggestion, which is the whole point of the column', async () => {
      const row = await harness.db
        .insertInto('calendar_locations')
        .values({
          destination_calendar_id: tenant.destinationCalendarId,
          display_name: 'New York, United States',
          country_code: 'US',
          latitude: '40.712800',
          longitude: '-74.006000',
          timezone_id: 'America/New_York',
          source: 'timezone_suggestion',
          confirmed_at: null,
          confirmed_by_user_id: null,
        })
        .returning(['id', 'confirmed_at', 'use_elevation', 'latitude', 'longitude'])
        .executeTakeFirstOrThrow();

      expect(row.confirmed_at).toBeNull();
      // Elevation defaults on; the engine's published-table comparisons are the
      // only place that turns it off.
      expect(row.use_elevation).toBe(true);
      // Full numeric precision, as strings. A float round trip would lose it.
      expect(row.latitude).toBe('40.712800');
      expect(row.longitude).toBe('-74.006000');
    });

    it('allows only one location per destination calendar', async () => {
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('calendar_locations')
          .values({
            destination_calendar_id: tenant.destinationCalendarId,
            display_name: 'A second location',
            country_code: 'IL',
            latitude: '31.778100',
            longitude: '35.235200',
            timezone_id: 'Asia/Jerusalem',
          })
          .execute(),
      );
      expect(failure.code).toBe('23505');
    });

    it.each([
      ['latitude', '91.000000', '0.000000'],
      ['longitude', '0.000000', '181.000000'],
    ])('refuses an out-of-range %s', async (_label, latitude, longitude) => {
      const other = await seedTenant(harness.db, `range-${latitude}-${longitude}`);
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('calendar_locations')
          .values({
            destination_calendar_id: other.destinationCalendarId,
            display_name: 'Off the planet',
            country_code: 'US',
            latitude,
            longitude,
            timezone_id: 'UTC',
          })
          .execute(),
      );
      expect(failure.code).toBe('23514');
    });
  });

  /* ----------------------------------------------------------- occurrences -- */

  describe('occurrences', () => {
    it('allows two occurrences in one Hebrew year when they differ by sequence', async () => {
      // This is the both-Adars case: one ordinary-Adar yahrzeit observed twice
      // in a leap year. If the unique key did not include `sequence`, the second
      // insert would collide and the second observance would silently vanish.
      const record = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'personal_yahrzeit',
          display_name: 'Both Adars',
          hebrew_month: 'ADAR',
          hebrew_day: 10,
          original_hebrew_year: 5759,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const rows = await harness.db
        .insertInto('generated_occurrences')
        .values([
          {
            source_record_id: record.id,
            hebrew_year: 5784,
            sequence: 0,
            occurrence_key: 'a'.repeat(32),
            hebrew_month: 12,
            hebrew_day: 10,
            gregorian_date: '2024-02-19',
            calculation_version: 'test-1',
            rule_applied: 'yahrzeit_adar_i',
          },
          {
            source_record_id: record.id,
            hebrew_year: 5784,
            sequence: 1,
            occurrence_key: 'b'.repeat(32),
            hebrew_month: 13,
            hebrew_day: 10,
            gregorian_date: '2024-03-20',
            calculation_version: 'test-1',
            rule_applied: 'yahrzeit_adar_ii',
          },
        ])
        .returning(['id', 'sequence', 'gregorian_date', 'ambiguities'])
        .execute();

      expect(rows.map((row) => row.sequence)).toEqual([0, 1]);
      expect(rows.map((row) => row.gregorian_date)).toEqual(['2024-02-19', '2024-03-20']);
      expect(rows[0]?.ambiguities).toEqual([]);
    });

    it('refuses a second occurrence with the same (record, year, sequence)', async () => {
      const record = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'birthday',
          display_name: 'Duplicate guard',
          hebrew_month: 'IYYAR',
          hebrew_day: 3,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const values = {
        source_record_id: record.id,
        hebrew_year: 5785,
        sequence: 0,
        hebrew_month: 2,
        hebrew_day: 3,
        gregorian_date: '2025-05-01',
        calculation_version: 'test-1',
        rule_applied: 'birthday_ordinary',
      };

      await harness.db
        .insertInto('generated_occurrences')
        .values({ ...values, occurrence_key: 'c'.repeat(32) })
        .execute();

      const failure = await expectRejection(() =>
        harness.db
          .insertInto('generated_occurrences')
          // A different key, so only the natural key can reject this.
          .values({ ...values, occurrence_key: 'd'.repeat(32) })
          .execute(),
      );
      expect(failure.constraint).toBe('occurrence_unique_per_year');
    });

    it('refuses a reused occurrence key across different records', async () => {
      const record = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'birthday',
          display_name: 'Key collision',
          hebrew_month: 'AV',
          hebrew_day: 9,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const failure = await expectRejection(() =>
        harness.db
          .insertInto('generated_occurrences')
          .values({
            source_record_id: record.id,
            hebrew_year: 5786,
            sequence: 0,
            // Already used above, by a different source record.
            occurrence_key: 'c'.repeat(32),
            hebrew_month: 5,
            hebrew_day: 9,
            gregorian_date: '2026-07-23',
            calculation_version: 'test-1',
            rule_applied: 'birthday_ordinary',
          })
          .execute(),
      );
      expect(failure.code).toBe('23505');
    });
  });

  /* ---------------------------------------------------- destination events -- */

  describe('destination events', () => {
    async function makeOccurrence(key: string): Promise<string> {
      const record = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'birthday',
          display_name: `Record ${key}`,
          hebrew_month: 'TISHREI',
          hebrew_day: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const occurrence = await harness.db
        .insertInto('generated_occurrences')
        .values({
          source_record_id: record.id,
          hebrew_year: 5787,
          sequence: 0,
          occurrence_key: key.padEnd(32, '0'),
          hebrew_month: 7,
          hebrew_day: 1,
          gregorian_date: '2026-09-12',
          calculation_version: 'test-1',
          rule_applied: 'birthday_ordinary',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return occurrence.id;
    }

    const eventValues = (occurrenceId: string) => ({
      generated_occurrence_id: occurrenceId,
      destination_calendar_id: tenant.destinationCalendarId,
      destination_type: 'google' as const,
      timezone_id: 'Asia/Jerusalem',
      location_snapshot: JSON.stringify({ displayName: 'Jerusalem' }) as unknown,
      content_hash: 'e'.repeat(32),
    });

    it('refuses a start time with no end time', async () => {
      const occurrenceId = await makeOccurrence('ev1');
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('destination_events')
          .values({
            ...eventValues(occurrenceId),
            start_at: new Date('2026-09-11T18:30:00Z'),
            end_at: null,
          })
          .execute(),
      );
      expect(failure.constraint).toBe('timing_is_all_or_nothing');
    });

    it('refuses an end time at or before the start', async () => {
      const occurrenceId = await makeOccurrence('ev2');
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('destination_events')
          .values({
            ...eventValues(occurrenceId),
            start_at: new Date('2026-09-12T18:30:00Z'),
            end_at: new Date('2026-09-11T18:30:00Z'),
          })
          .execute(),
      );
      expect(failure.constraint).toBe('timing_is_ordered');
    });

    it('accepts a null window, which is how an all-day event is stored', async () => {
      // The polar case: where the sun does not set, the event degrades to
      // all-day rather than being written with an invented time.
      const occurrenceId = await makeOccurrence('ev3');
      const row = await harness.db
        .insertInto('destination_events')
        .values({ ...eventValues(occurrenceId), start_at: null, end_at: null })
        .returning(['id', 'sync_status', 'attempt_count'])
        .executeTakeFirstOrThrow();
      expect(row.sync_status).toBe('pending');
      expect(row.attempt_count).toBe(0);
    });

    it('allows one event per occurrence per destination calendar, and no more', async () => {
      const occurrenceId = await makeOccurrence('ev4');
      await harness.db.insertInto('destination_events').values(eventValues(occurrenceId)).execute();

      const failure = await expectRejection(() =>
        harness.db.insertInto('destination_events').values(eventValues(occurrenceId)).execute(),
      );
      expect(failure.constraint).toBe('one_event_per_occurrence_per_destination');
    });

    it('allows the same occurrence in two members calendars', async () => {
      // The family case: one dataset, one Hebrew date, four members' calendars.
      // This must NOT collide, which is why the key is the calendar and not the
      // destination type.
      const occurrenceId = await makeOccurrence('ev5');
      const second = await harness.db
        .insertInto('destination_calendars')
        .values({
          dataset_id: tenant.datasetId,
          user_id: tenant.userId,
          name: 'Second member',
          destination_type: 'google',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await harness.db.insertInto('destination_events').values(eventValues(occurrenceId)).execute();
      const row = await harness.db
        .insertInto('destination_events')
        .values({
          ...eventValues(occurrenceId),
          destination_calendar_id: second.id,
          timezone_id: 'America/New_York',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect(row.id).toBeTruthy();
    });

    it('refuses two rows pointing at the same external Google event', async () => {
      const first = await makeOccurrence('ev6');
      const secondOccurrence = await makeOccurrence('ev7');

      await harness.db
        .insertInto('destination_events')
        .values({
          ...eventValues(first),
          external_calendar_id: 'cal-1@group.calendar.google.com',
          external_event_id: 'abcde',
        })
        .execute();

      const failure = await expectRejection(() =>
        harness.db
          .insertInto('destination_events')
          .values({
            ...eventValues(secondOccurrence),
            external_calendar_id: 'cal-1@group.calendar.google.com',
            external_event_id: 'abcde',
          })
          .execute(),
      );
      expect(failure.code).toBe('23505');
    });

    it('allows many rows with no external event yet, because the index is partial', async () => {
      const a = await makeOccurrence('ev8');
      const b = await makeOccurrence('ev9');
      await harness.db
        .insertInto('destination_events')
        .values([
          { ...eventValues(a), external_calendar_id: 'cal-1', external_event_id: null },
          { ...eventValues(b), external_calendar_id: 'cal-1', external_event_id: null },
        ])
        .execute();

      const pending = await harness.db
        .selectFrom('destination_events')
        .select(harness.db.fn.countAll().as('count'))
        .where('external_event_id', 'is', null)
        .executeTakeFirstOrThrow();
      expect(Number(pending.count)).toBeGreaterThanOrEqual(2);
    });
  });

  /* ------------------------------------------------------------- reminders -- */

  describe('reminder rules', () => {
    it('refuses a rule scoped to both a calendar and a record', async () => {
      const record = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'birthday',
          display_name: 'Reminder scope',
          hebrew_month: 'ELUL',
          hebrew_day: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const failure = await expectRejection(() =>
        harness.db
          .insertInto('reminder_rules')
          .values({
            destination_calendar_id: tenant.destinationCalendarId,
            source_record_id: record.id,
            event_type: 'birthday',
            minutes_before_start: 1440,
          })
          .execute(),
      );
      expect(failure.constraint).toBe('reminder_scope_is_exclusive');
    });

    it('refuses a rule scoped to neither', async () => {
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('reminder_rules')
          .values({
            destination_calendar_id: null,
            source_record_id: null,
            event_type: 'birthday',
            minutes_before_start: 1440,
          })
          .execute(),
      );
      expect(failure.constraint).toBe('reminder_scope_is_exclusive');
    });

    it('refuses a negative lead time', async () => {
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('reminder_rules')
          .values({
            destination_calendar_id: tenant.destinationCalendarId,
            event_type: 'birthday',
            minutes_before_start: -1,
          })
          .execute(),
      );
      expect(failure.code).toBe('23514');
    });
  });

  /* -------------------------------------------------- sessions and oauth -- */

  describe('sessions and oauth state', () => {
    it('refuses a session that expires before it was created', async () => {
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('sessions')
          .values({
            id: Buffer.alloc(32, 1),
            user_id: tenant.userId,
            created_at: new Date('2026-01-02T00:00:00Z'),
            expires_at: new Date('2026-01-01T00:00:00Z'),
          })
          .execute(),
      );
      expect(failure.constraint).toBe('session_expiry_is_in_the_future');
    });

    it('refuses an oauth state that expires before it was created', async () => {
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('oauth_states')
          .values({
            state_hash: Buffer.alloc(32, 2),
            encrypted_code_verifier: Buffer.alloc(16, 3),
            encryption_key_id: 'test-key/1',
            created_at: new Date('2026-01-02T00:00:00Z'),
            expires_at: new Date('2026-01-01T00:00:00Z'),
          })
          .execute(),
      );
      expect(failure.constraint).toBe('oauth_state_expiry_is_in_the_future');
    });

    it('refuses a google calendar connection the app did not create', async () => {
      // Under calendar.app.created the app can only touch calendars it created.
      // Storing a connection that claims otherwise would be a bug that produced
      // 403s at write time, so it is refused at insert time instead.
      const account = await harness.db
        .insertInto('google_accounts')
        .values({
          user_id: tenant.userId,
          google_subject: 'sub-not-app-created',
          encrypted_refresh_token: Buffer.alloc(32, 4),
          encryption_key_id: 'test-key/1',
          granted_scopes: 'https://www.googleapis.com/auth/calendar.app.created',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const failure = await expectRejection(() =>
        harness.db
          .insertInto('google_calendar_connections')
          .values({
            destination_calendar_id: tenant.destinationCalendarId,
            google_account_id: account.id,
            google_calendar_id: 'someone-elses@group.calendar.google.com',
            created_by_app: false,
          })
          .execute(),
      );
      expect(failure.constraint).toBe('app_owned_calendars_only');
    });

    it('allows only one google account row per (user, google subject)', async () => {
      const values = {
        user_id: tenant.userId,
        google_subject: 'sub-duplicate',
        encrypted_refresh_token: Buffer.alloc(32, 5),
        encryption_key_id: 'test-key/1',
        granted_scopes: 'https://www.googleapis.com/auth/calendar.app.created',
      };
      await harness.db.insertInto('google_accounts').values(values).execute();
      const failure = await expectRejection(() =>
        harness.db
          .insertInto('google_accounts')
          .values({ ...values, encrypted_refresh_token: Buffer.alloc(32, 6) })
          .execute(),
      );
      expect(failure.constraint).toBe('one_google_account_per_user');
    });
  });

  /* --------------------------------------------------------------- cascades -- */

  describe('cascades', () => {
    it('removes occurrences and events when a source record is hard-deleted', async () => {
      const record = await harness.db
        .insertInto('source_records')
        .values({
          dataset_id: tenant.datasetId,
          type: 'birthday',
          display_name: 'Cascade subject',
          hebrew_month: 'TEVET',
          hebrew_day: 5,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const occurrence = await harness.db
        .insertInto('generated_occurrences')
        .values({
          source_record_id: record.id,
          hebrew_year: 5788,
          sequence: 0,
          occurrence_key: 'cascade'.padEnd(32, '0'),
          hebrew_month: 10,
          hebrew_day: 5,
          gregorian_date: '2027-12-14',
          calculation_version: 'test-1',
          rule_applied: 'birthday_ordinary',
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await harness.db
        .insertInto('destination_events')
        .values({
          generated_occurrence_id: occurrence.id,
          destination_calendar_id: tenant.destinationCalendarId,
          destination_type: 'google',
          timezone_id: 'Asia/Jerusalem',
          location_snapshot: JSON.stringify({}) as unknown,
          content_hash: 'f'.repeat(32),
        })
        .execute();

      await harness.db.deleteFrom('source_records').where('id', '=', record.id).execute();

      const orphanOccurrences = await harness.db
        .selectFrom('generated_occurrences')
        .select('id')
        .where('id', '=', occurrence.id)
        .execute();
      const orphanEvents = await harness.db
        .selectFrom('destination_events')
        .select('id')
        .where('generated_occurrence_id', '=', occurrence.id)
        .execute();

      expect(orphanOccurrences).toHaveLength(0);
      expect(orphanEvents).toHaveLength(0);
    });

    it('keeps the audit trail when the acting user is deleted', async () => {
      // The audit log must outlive the actor, so its FK is ON DELETE SET NULL
      // rather than CASCADE: deleting a user must not erase the record of what
      // they did.
      const throwaway = await harness.db
        .insertInto('users')
        .values({ email: 'audit-actor@example.test' })
        .returning('id')
        .executeTakeFirstOrThrow();

      await harness.db
        .insertInto('audit_log')
        .values({
          actor_user_id: throwaway.id,
          action: 'google.connected',
          subject_type: 'google_account',
          subject_id: 'test',
        })
        .execute();

      await harness.db.deleteFrom('users').where('id', '=', throwaway.id).execute();

      const entries = await harness.db
        .selectFrom('audit_log')
        .select(['actor_user_id', 'action', 'detail'])
        .where('action', '=', 'google.connected')
        .execute();

      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor_user_id).toBeNull();
      expect(entries[0]?.detail).toEqual({});
    });
  });
});
