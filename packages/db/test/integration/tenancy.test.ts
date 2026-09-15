/**
 * Tenant boundaries.
 *
 * The worst plausible bug in this system is one family seeing another family's
 * dates of death. These tests take two fully independent tenants and try, from
 * tenant B's session, to read and write every dataset-scoped thing that belongs
 * to tenant A — using B's real access token and A's real IDs, which is exactly
 * the shape of an IDOR attempt against a route that trusted its path parameter.
 *
 * Every attempt must fail, and must fail as "not found" rather than
 * "forbidden": telling an attacker that a dataset exists but is not theirs is
 * itself a disclosure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError, authorise, authoriseDestination, systemAccess } from '../../src/access';
import {
  confirmLocationRow,
  createSourceRecord,
  getDestinationCalendar,
  getLocation,
  getSourceRecord,
  listDestinationCalendars,
  listDestinationEvents,
  listOccurrences,
  listSourceRecords,
  saveLocation,
  setHorizon,
  softDeleteSourceRecord,
  updateDestinationCalendar,
  upsertOccurrences,
} from '../../src/repositories';
import type { DatasetAccess } from '../../src/access';
import {
  createTestDatabase,
  describeWithDatabase,
  seedTenant,
  type TestDatabase,
  type Tenant,
} from '../helpers/database';

describe.runIf(describeWithDatabase)('tenant boundaries', () => {
  let harness: TestDatabase;
  let alice: Tenant;
  let bob: Tenant;
  let aliceAccess: DatasetAccess;
  let bobAccess: DatasetAccess;

  beforeAll(async () => {
    harness = await createTestDatabase('tenancy');
    alice = await seedTenant(harness.db, 'alice');
    bob = await seedTenant(harness.db, 'bob');
    aliceAccess = await authorise(harness.db, {
      datasetId: alice.datasetId,
      userId: alice.userId,
      minimumRole: 'admin',
    });
    bobAccess = await authorise(harness.db, {
      datasetId: bob.datasetId,
      userId: bob.userId,
      minimumRole: 'admin',
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  /* ----------------------------------------------------------- authorise -- */

  describe('authorise', () => {
    it('grants access to a member of the dataset owner', async () => {
      const access = await authorise(harness.db, {
        datasetId: alice.datasetId,
        userId: alice.userId,
        minimumRole: 'viewer',
      });
      expect(access.datasetId).toBe(alice.datasetId);
      expect(access.role).toBe('admin');
    });

    it("refuses another tenant's dataset", async () => {
      await expect(
        authorise(harness.db, {
          datasetId: alice.datasetId,
          userId: bob.userId,
          minimumRole: 'viewer',
        }),
      ).rejects.toThrow(AccessDeniedError);
    });

    it('reports a foreign dataset as "Not found", disclosing nothing', async () => {
      // The message is load-bearing: distinguishing "exists but not yours" from
      // "does not exist" would let an attacker enumerate datasets.
      const foreign = await authorise(harness.db, {
        datasetId: alice.datasetId,
        userId: bob.userId,
        minimumRole: 'viewer',
      }).catch((error: Error) => error.message);
      const absent = await authorise(harness.db, {
        datasetId: '00000000-0000-0000-0000-000000000000',
        userId: bob.userId,
        minimumRole: 'viewer',
      }).catch((error: Error) => error.message);
      expect(foreign).toBe(absent);
      expect(foreign).toBe('Not found');
    });

    it('enforces the minimum role', async () => {
      const viewerOnly = await seedTenant(harness.db, 'viewer-only');
      await harness.db
        .updateTable('owner_members')
        .set({ role: 'viewer' })
        .where('owner_id', '=', viewerOnly.ownerId)
        .execute();

      await expect(
        authorise(harness.db, {
          datasetId: viewerOnly.datasetId,
          userId: viewerOnly.userId,
          minimumRole: 'viewer',
        }),
      ).resolves.toMatchObject({ role: 'viewer' });

      // A viewer must not be able to edit: a shared dataset means their edit
      // would change what appears in another member's calendar.
      await expect(
        authorise(harness.db, {
          datasetId: viewerOnly.datasetId,
          userId: viewerOnly.userId,
          minimumRole: 'editor',
        }),
      ).rejects.toThrow(AccessDeniedError);
    });

    it('refuses a deactivated dataset even for its own member', async () => {
      const paused = await seedTenant(harness.db, 'paused');
      await harness.db
        .updateTable('datasets')
        .set({ active: false })
        .where('id', '=', paused.datasetId)
        .execute();

      await expect(
        authorise(harness.db, {
          datasetId: paused.datasetId,
          userId: paused.userId,
          minimumRole: 'viewer',
        }),
      ).rejects.toThrow(AccessDeniedError);
    });

    it('grants a second member of a shared household the same dataset', async () => {
      // The family case, which is the reason authorisation goes through owners
      // rather than a user_id column on every row.
      const household = await seedTenant(harness.db, 'household', { kind: 'household' });
      const spouse = await harness.db
        .insertInto('users')
        .values({ email: 'spouse@example.test' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await harness.db
        .insertInto('owner_members')
        .values({ owner_id: household.ownerId, user_id: spouse.id, role: 'editor' })
        .execute();

      const access = await authorise(harness.db, {
        datasetId: household.datasetId,
        userId: spouse.id,
        minimumRole: 'editor',
      });
      expect(access.datasetId).toBe(household.datasetId);
      expect(access.role).toBe('editor');
    });
  });

  /* ------------------------------------------------- authoriseDestination -- */

  describe('authoriseDestination', () => {
    it("refuses another tenant's destination calendar", async () => {
      await expect(
        authoriseDestination(harness.db, {
          destinationCalendarId: alice.destinationCalendarId,
          userId: bob.userId,
          minimumRole: 'viewer',
        }),
      ).rejects.toThrow(AccessDeniedError);
    });

    it("returns the calendar's own dataset, so a mismatched pair cannot be forged", async () => {
      const resolved = await authoriseDestination(harness.db, {
        destinationCalendarId: alice.destinationCalendarId,
        userId: alice.userId,
        minimumRole: 'admin',
      });
      expect(resolved.datasetId).toBe(alice.datasetId);
      expect(resolved.access.datasetId).toBe(alice.datasetId);
      expect(resolved.access.datasetId).not.toBe(bob.datasetId);
    });
  });

  /* ------------------------------------------ cross-tenant read attempts -- */

  describe("reads of another tenant's data", () => {
    beforeAll(async () => {
      const record = await createSourceRecord(harness.db, aliceAccess, {
        type: 'personal_yahrzeit',
        displayName: "Alice's grandfather",
        hebrewMonth: 'SIVAN',
        hebrewDay: 12,
        originalHebrewYear: 5745,
      });
      await upsertOccurrences(harness.db, aliceAccess, {
        sourceRecordId: record.id,
        occurrences: [
          {
            hebrewYear: 5786,
            sequence: 0,
            occurrenceKey: 'alice-occ'.padEnd(32, '0'),
            hebrewMonth: 3,
            hebrewDay: 12,
            gregorianDate: '2026-05-28',
            calculationVersion: 'test-1',
            ruleApplied: 'yahrzeit_ordinary',
            ambiguities: [],
          },
        ],
      });
      await saveLocation(harness.db, aliceAccess, {
        destinationCalendarId: alice.destinationCalendarId,
        location: {
          displayName: 'Jerusalem, Israel',
          countryCode: 'IL',
          latitude: 31.7781,
          longitude: 35.2352,
          elevationMeters: 754,
          timezoneId: 'Asia/Jerusalem',
          source: 'user_selected',
        },
        confirmedByUserId: alice.userId,
      });
    });

    it("does not list Alice's calendars for Bob", async () => {
      const calendars = await listDestinationCalendars(harness.db, bobAccess);
      expect(calendars.map((row) => row.id)).toEqual([bob.destinationCalendarId]);
    });

    it("does not list Alice's source records for Bob", async () => {
      const records = await listSourceRecords(harness.db, bobAccess);
      expect(records).toHaveLength(0);
    });

    it("does not list Alice's occurrences for Bob", async () => {
      // The dangerous one: occurrences join through source_records, so a missing
      // dataset predicate here would leak dates of death across families.
      const occurrences = await listOccurrences(harness.db, bobAccess);
      expect(occurrences).toHaveLength(0);

      const own = await listOccurrences(harness.db, aliceAccess);
      expect(own).toHaveLength(1);
      expect(own[0]?.dataset_id).toBe(alice.datasetId);
    });

    it("refuses to fetch Alice's source record with Bob's access", async () => {
      const records = await listSourceRecords(harness.db, aliceAccess);
      const target = records[0];
      expect(target).toBeDefined();
      await expect(getSourceRecord(harness.db, bobAccess, target!.id)).rejects.toThrow(
        AccessDeniedError,
      );
    });

    it("refuses to fetch Alice's calendar with Bob's access", async () => {
      await expect(
        getDestinationCalendar(harness.db, bobAccess, alice.destinationCalendarId),
      ).rejects.toThrow(AccessDeniedError);
    });

    it("refuses to read Alice's location with Bob's access", async () => {
      await expect(
        getLocation(harness.db, bobAccess, alice.destinationCalendarId),
      ).rejects.toThrow(AccessDeniedError);

      const own = await getLocation(harness.db, aliceAccess, alice.destinationCalendarId);
      expect(own?.timezone_id).toBe('Asia/Jerusalem');
      expect(own?.latitude).toBe('31.778100');
    });

    it("does not list Alice's destination events for Bob", async () => {
      const events = await listDestinationEvents(harness.db, bobAccess, alice.destinationCalendarId);
      expect(events).toHaveLength(0);
    });
  });

  /* ----------------------------------------- cross-tenant write attempts -- */

  describe("writes to another tenant's data", () => {
    it("cannot rename Alice's calendar", async () => {
      await expect(
        updateDestinationCalendar(harness.db, bobAccess, alice.destinationCalendarId, {
          name: 'Taken over',
        }),
      ).rejects.toThrow(AccessDeniedError);

      const untouched = await getDestinationCalendar(
        harness.db,
        aliceAccess,
        alice.destinationCalendarId,
      );
      expect(untouched.name).toBe('Calendar alice');
    });

    it("cannot overwrite Alice's location", async () => {
      await expect(
        saveLocation(harness.db, bobAccess, {
          destinationCalendarId: alice.destinationCalendarId,
          location: {
            displayName: 'Somewhere else entirely',
            countryCode: 'US',
            latitude: 0,
            longitude: 0,
            timezoneId: 'UTC',
            source: 'user_selected',
          },
          confirmedByUserId: bob.userId,
        }),
      ).rejects.toThrow(AccessDeniedError);

      const untouched = await getLocation(harness.db, aliceAccess, alice.destinationCalendarId);
      expect(untouched?.display_name).toBe('Jerusalem, Israel');
    });

    it("cannot confirm Alice's location on her behalf", async () => {
      await expect(
        confirmLocationRow(harness.db, bobAccess, {
          destinationCalendarId: alice.destinationCalendarId,
          userId: bob.userId,
        }),
      ).rejects.toThrow(AccessDeniedError);
    });

    it("cannot soft-delete Alice's source record", async () => {
      const records = await listSourceRecords(harness.db, aliceAccess);
      const target = records[0]!;
      await softDeleteSourceRecord(harness.db, bobAccess, target.id);

      // The update is scoped by dataset, so it matches nothing rather than
      // deleting someone else's row.
      const stillThere = await getSourceRecord(harness.db, aliceAccess, target.id);
      expect(stillThere.deleted_at).toBeNull();
    });

    it("cannot move Alice's horizon", async () => {
      const records = await listSourceRecords(harness.db, aliceAccess);
      const target = records[0]!;
      await setHorizon(harness.db, bobAccess, {
        sourceRecordId: target.id,
        throughHebrewYear: 9999,
      });
      const unchanged = await getSourceRecord(harness.db, aliceAccess, target.id);
      expect(unchanged.horizon_through_hebrew_year).not.toBe(9999);
    });

    it("cannot attach occurrences to Alice's source record", async () => {
      const records = await listSourceRecords(harness.db, aliceAccess);
      const target = records[0]!;
      await expect(
        upsertOccurrences(harness.db, bobAccess, {
          sourceRecordId: target.id,
          occurrences: [
            {
              hebrewYear: 5790,
              sequence: 0,
              occurrenceKey: 'intruder'.padEnd(32, '0'),
              hebrewMonth: 3,
              hebrewDay: 12,
              gregorianDate: '2030-06-12',
              calculationVersion: 'test-1',
              ruleApplied: 'yahrzeit_ordinary',
              ambiguities: [],
            },
          ],
        }),
      ).rejects.toThrow(AccessDeniedError);
    });

    it('writes a source record into the access token\'s dataset, never a supplied one', async () => {
      // `createSourceRecord` takes no dataset argument at all: the dataset comes
      // from the access token. This pins that, because adding such a parameter
      // "for convenience" is exactly how this class of bug appears.
      const created = await createSourceRecord(harness.db, bobAccess, {
        type: 'birthday',
        displayName: "Bob's own",
        hebrewMonth: 'AV',
        hebrewDay: 15,
      });
      expect(created.dataset_id).toBe(bob.datasetId);
    });
  });

  /* --------------------------------------------------------- system access -- */

  describe('system access', () => {
    it('is confined to the dataset it names and is identifiable as a job', async () => {
      const access = systemAccess(alice.datasetId, 'job-123');
      expect(access.datasetId).toBe(alice.datasetId);
      expect(access.userId).toBe('system:job:job-123');

      const occurrences = await listOccurrences(harness.db, access);
      expect(occurrences.every((row) => row.dataset_id === alice.datasetId)).toBe(true);

      // Not a shortcut past scoping: the same token cannot reach Bob's data.
      await expect(
        getDestinationCalendar(harness.db, access, bob.destinationCalendarId),
      ).rejects.toThrow(AccessDeniedError);
    });
  });
});
