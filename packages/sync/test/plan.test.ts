/**
 * The reconciliation decision table, exhaustively.
 *
 * Every test here is a statement about what the product promises: no duplicate
 * events, no silently wrong sunset times, history preserved, and failures that
 * stop rather than hammer.
 */
import { describe, expect, it } from 'vitest';
import {
  confirmLocation,
  generateOccurrences,
  getSeedLocation,
  type DestinationEvent,
} from '@hebrew-dates/engine';
import {
  nextAttemptAt,
  planSync,
  type PlanSyncInput,
  type StoredDestinationEvent,
  type SyncAction,
} from '../src/plan';

const DESTINATION = 'dest-1';
const CALENDAR = 'google-calendar-1';
const NOW = Date.UTC(2025, 0, 15, 12, 0, 0);

const jerusalem = confirmLocation(getSeedLocation('seed:jerusalem')!);
const newYork = confirmLocation(getSeedLocation('seed:new-york')!);

/** Real engine output, so the planner is tested against real shapes. */
function desiredEvents(
  overrides: Partial<Parameters<typeof generateOccurrences>[0]> = {},
): DestinationEvent[] {
  const result = generateOccurrences({
    sourceRecordId: 'record-1',
    type: 'birthday',
    displayName: 'David',
    origin: { month: 'NISAN', day: 10 },
    location: jerusalem,
    displayMode: 'exact_sunset',
    count: 5,
    nowEpochMs: NOW,
    destinationCalendarId: DESTINATION,
    ...overrides,
  });
  if (result.status !== 'ok') throw new Error('expected occurrences');
  return result.occurrences;
}

/** A stored row that matches a desired event exactly and is fully synced. */
function syncedRow(event: DestinationEvent): StoredDestinationEvent {
  return {
    occurrenceKey: event.key,
    destinationCalendarId: DESTINATION,
    externalCalendarId: CALENDAR,
    externalEventId: event.googleEventId,
    contentHash: event.contentHash,
    syncStatus: 'synced',
    attemptCount: 0,
    startAtEpochMs: event.timing?.startEpochMs ?? null,
  };
}

function plan(overrides: Partial<PlanSyncInput> = {}) {
  const desired = overrides.desired ?? desiredEvents();
  return planSync({
    destinationCalendarId: DESTINATION,
    externalCalendarId: CALENDAR,
    desired,
    actual: [],
    nowEpochMs: NOW,
    locationConfirmed: true,
    ...overrides,
  });
}

function byKey(actions: SyncAction[]) {
  return new Map(actions.map((action) => [action.occurrenceKey, action]));
}

describe('first sync: nothing exists yet', () => {
  it('creates every desired event', () => {
    const desired = desiredEvents();
    const result = plan({ desired });
    expect(result.summary.create).toBe(desired.length);
    expect(result.summary.update).toBe(0);
    expect(result.summary.delete).toBe(0);
    expect(result.blocked).toBeUndefined();
  });

  it('uses the engine s deterministic event ID for the insert', () => {
    const desired = desiredEvents();
    const actions = byKey(plan({ desired }).actions);
    for (const event of desired) {
      const action = actions.get(event.key)!;
      expect(action.type).toBe('create');
      if (action.type !== 'create') continue;
      expect(action.externalEventId).toBe(event.googleEventId);
    }
  });

  it('explains why each event is being created', () => {
    for (const action of plan().actions) {
      expect(action.reason).toBe('missing_in_destination');
    }
  });
});

describe('repeat sync: the idempotency promise', () => {
  it('does nothing at all when everything already matches', () => {
    const desired = desiredEvents();
    const result = plan({ desired, actual: desired.map(syncedRow) });
    expect(result.summary).toMatchObject({ create: 0, update: 0, delete: 0, writes: 0 });
    expect(result.summary.noop).toBe(desired.length);
    for (const action of result.actions) expect(action.reason).toBe('already_synced');
  });

  it('is stable across repeated planning', () => {
    const desired = desiredEvents();
    const actual = desired.map(syncedRow);
    const first = plan({ desired, actual });
    const second = plan({ desired, actual });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('never emits two actions for one occurrence', () => {
    const desired = desiredEvents();
    const actual = desired.slice(0, 2).map(syncedRow);
    const result = plan({ desired, actual });
    const keys = result.actions.map((a) => a.occurrenceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('content changes produce updates, not duplicates', () => {
  it('updates when the location changed, reusing the same event ID', () => {
    // Same record, different city: same occurrence keys, different sunset times.
    const before = desiredEvents({ location: jerusalem });
    const after = desiredEvents({ location: newYork });
    expect(after.map((e) => e.key)).toEqual(before.map((e) => e.key));

    const result = plan({ desired: after, actual: before.map(syncedRow) });
    expect(result.summary.update).toBe(after.length);
    expect(result.summary.create).toBe(0);
    for (const action of result.actions) {
      expect(action.reason).toBe('content_changed');
      if (action.type !== 'update') continue;
      const original = before.find((e) => e.key === action.occurrenceKey)!;
      expect(action.externalEventId).toBe(original.googleEventId);
      expect(action.previousContentHash).toBe(original.contentHash);
    }
  });

  it('updates when the display name changed', () => {
    const before = desiredEvents({ displayName: 'David' });
    const after = desiredEvents({ displayName: 'Dovid' });
    const result = plan({ desired: after, actual: before.map(syncedRow) });
    expect(result.summary.update).toBe(after.length);
  });

  it('updates when only the display mode changed', () => {
    const before = desiredEvents({ displayMode: 'exact_sunset' });
    const after = desiredEvents({ displayMode: 'two_day_all_day' });
    const result = plan({ desired: after, actual: before.map(syncedRow) });
    expect(result.summary.update).toBe(after.length);
    expect(result.summary.create).toBe(0);
  });

  it('updates when only visibility changed', () => {
    const before = desiredEvents({ visibility: 'default' });
    const after = desiredEvents({ visibility: 'private' });
    const result = plan({ desired: after, actual: before.map(syncedRow) });
    expect(result.summary.update).toBe(after.length);
  });

  it('does NOT update when the content is identical but the row was re-read', () => {
    const desired = desiredEvents();
    const actual = desired.map((event) => ({ ...syncedRow(event), attemptCount: 3 }));
    expect(plan({ desired, actual }).summary.update).toBe(0);
  });
});

describe('interrupted runs heal', () => {
  it('re-creates when a row exists but was never written to the calendar', () => {
    const desired = desiredEvents();
    const actual: StoredDestinationEvent[] = desired.map((event) => ({
      ...syncedRow(event),
      externalEventId: null,
      externalCalendarId: null,
      syncStatus: 'creating',
    }));
    const result = plan({ desired, actual });
    expect(result.summary.create).toBe(desired.length);
    for (const action of result.actions) {
      expect(action.reason).toBe('previous_attempt_incomplete');
    }
  });

  it('re-writes a row left mid-update even though the hash matches', () => {
    const desired = desiredEvents();
    const actual = desired.map((event) => ({
      ...syncedRow(event),
      syncStatus: 'updating' as const,
    }));
    const result = plan({ desired, actual });
    expect(result.summary.update).toBe(desired.length);
    for (const action of result.actions) {
      expect(action.reason).toBe('previous_attempt_incomplete');
    }
  });

  it('re-writes a row left mid-delete that is desired again', () => {
    const desired = desiredEvents();
    const actual = desired.map((event) => ({
      ...syncedRow(event),
      syncStatus: 'deleting' as const,
    }));
    expect(plan({ desired, actual }).summary.update).toBe(desired.length);
  });

  it('converges after a simulated crash: plan, apply half, re-plan', () => {
    const desired = desiredEvents();
    const firstPass = plan({ desired, actual: [] });
    expect(firstPass.summary.create).toBe(desired.length);

    // The worker died after writing the first two.
    const applied = desired.slice(0, 2).map(syncedRow);
    const secondPass = plan({ desired, actual: applied });
    expect(secondPass.summary.create).toBe(desired.length - 2);
    expect(secondPass.summary.noop).toBe(2);
    expect(secondPass.summary.update).toBe(0);

    // Third pass, everything applied: total quiet.
    const thirdPass = plan({ desired, actual: desired.map(syncedRow) });
    expect(thirdPass.summary.writes).toBe(0);
  });
});

describe('events that are no longer desired', () => {
  it('deletes a future event whose occurrence has gone', () => {
    const desired = desiredEvents();
    const removed = desired[3]!;
    const result = plan({
      desired: desired.filter((e) => e.key !== removed.key),
      actual: desired.map(syncedRow),
    });
    expect(result.summary.delete).toBe(1);
    const action = byKey(result.actions).get(removed.key)!;
    expect(action.type).toBe('delete');
    expect(action.reason).toBe('no_longer_desired');
    if (action.type === 'delete') {
      expect(action.externalEventId).toBe(removed.googleEventId);
      expect(action.externalCalendarId).toBe(CALENDAR);
    }
  });

  it('removes the second Adar cleanly when a record switches to a single Adar', () => {
    const both = desiredEvents({
      type: 'personal_yahrzeit',
      displayName: 'Zayde',
      origin: { month: 'ADAR', day: 10, year: 5785 },
      count: 5,
    });
    const single = desiredEvents({
      type: 'personal_yahrzeit',
      displayName: 'Zayde',
      origin: { month: 'ADAR', day: 10, year: 5785 },
      count: 5,
      conventions: { adarOrdinaryYahrzeitInLeapYear: 'adar_i' },
    });
    expect(both.length).toBeGreaterThan(single.length);

    const result = plan({ desired: single, actual: both.map(syncedRow) });
    // The extra Adar II observances are deleted; the rest are untouched.
    expect(result.summary.delete).toBe(both.length - single.length);
    expect(result.summary.create).toBe(0);
    const deleted = result.actions.filter((a) => a.type === 'delete');
    for (const action of deleted) {
      const event = both.find((e) => e.key === action.occurrenceKey)!;
      expect(event.sequence).toBe(1);
    }
  });

  it('does not try to delete something that was never written', () => {
    const desired = desiredEvents();
    const orphan: StoredDestinationEvent = {
      occurrenceKey: 'orphan-never-written',
      destinationCalendarId: DESTINATION,
      externalCalendarId: null,
      externalEventId: null,
      contentHash: 'x'.repeat(32),
      syncStatus: 'pending',
      attemptCount: 1,
      startAtEpochMs: NOW + 86_400_000,
    };
    const result = plan({ desired, actual: [...desired.map(syncedRow), orphan] });
    expect(result.summary.delete).toBe(0);
    expect(byKey(result.actions).get('orphan-never-written')!.type).toBe('noop');
  });
});

describe('the past is preserved', () => {
  const past: StoredDestinationEvent = {
    occurrenceKey: 'past-occurrence',
    destinationCalendarId: DESTINATION,
    externalCalendarId: CALENDAR,
    externalEventId: 'hdpast',
    contentHash: 'a'.repeat(32),
    syncStatus: 'synced',
    attemptCount: 0,
    startAtEpochMs: Date.UTC(2020, 5, 1),
  };

  it('never deletes a past event by default', () => {
    const result = plan({ desired: desiredEvents(), actual: [past] });
    expect(result.summary.delete).toBe(0);
    const action = byKey(result.actions).get('past-occurrence')!;
    expect(action.type).toBe('noop');
    expect(action.reason).toBe('past_event_preserved');
  });

  it('deletes a past event when the user explicitly asks to rewrite history', () => {
    const result = plan({
      desired: desiredEvents(),
      actual: [past],
      pastEventPolicy: 'update_all',
    });
    expect(result.summary.delete).toBe(1);
  });

  it('honours a from-date policy', () => {
    const cutoff = Date.UTC(2019, 0, 1);
    const result = plan({
      desired: desiredEvents(),
      actual: [past],
      pastEventPolicy: { from: cutoff },
    });
    // The past event is after the cutoff, so it is in scope.
    expect(result.summary.delete).toBe(1);

    const laterCutoff = plan({
      desired: desiredEvents(),
      actual: [past],
      pastEventPolicy: { from: Date.UTC(2021, 0, 1) },
    });
    expect(laterCutoff.summary.delete).toBe(0);
  });

  it('does not create or update a desired event that has already finished', () => {
    // Generate from an earlier clock so the first occurrence is behind "now".
    const stale = generateOccurrences({
      sourceRecordId: 'record-1',
      type: 'birthday',
      displayName: 'David',
      origin: { month: 'NISAN', day: 10 },
      location: jerusalem,
      displayMode: 'exact_sunset',
      count: 3,
      nowEpochMs: Date.UTC(2020, 0, 15),
      destinationCalendarId: DESTINATION,
    });
    if (stale.status !== 'ok') throw new Error('expected occurrences');
    const result = plan({ desired: stale.occurrences, actual: [] });
    const pastActions = result.actions.filter((a) => a.reason === 'past_event_preserved');
    expect(pastActions.length).toBeGreaterThan(0);
    for (const action of pastActions) expect(action.type).toBe('noop');
  });

  it('treats a stored row with unknown timing as future, so it is never orphaned', () => {
    const unknown: StoredDestinationEvent = { ...past, startAtEpochMs: null };
    const result = plan({ desired: desiredEvents(), actual: [unknown] });
    expect(result.summary.delete).toBe(1);
  });

  it('uses the covered Gregorian day when there is no instant (all-day events)', () => {
    const allDayPast: StoredDestinationEvent = {
      ...past,
      startAtEpochMs: null,
      gregorianDateEpochMs: Date.UTC(2020, 5, 1),
    };
    expect(plan({ desired: desiredEvents(), actual: [allDayPast] }).summary.delete).toBe(0);
  });
});

describe('an unconfirmed location blocks everything', () => {
  it('writes nothing and says why', () => {
    const result = plan({ desired: desiredEvents(), locationConfirmed: false });
    expect(result.summary.writes).toBe(0);
    expect(result.blocked?.reason).toBe('location_not_confirmed');
    expect(result.blocked?.message).toMatch(/calculated from a place, not from a time zone/);
    for (const action of result.actions) {
      expect(action.type).toBe('skip');
      if (action.type === 'skip') expect(action.blocking).toBe(true);
    }
  });

  it('blocks even if the caller claims confirmation but the events disagree', () => {
    // Defence in depth: the engine stamps a warning on every event rendered for
    // an unconfirmed location, and the planner trusts the stricter signal.
    const unconfirmed = generateOccurrences({
      sourceRecordId: 'record-1',
      type: 'birthday',
      displayName: 'David',
      origin: { month: 'NISAN', day: 10 },
      location: getSeedLocation('seed:jerusalem')!, // not passed through confirmLocation
      displayMode: 'exact_sunset',
      count: 3,
      nowEpochMs: NOW,
      destinationCalendarId: DESTINATION,
    });
    if (unconfirmed.status !== 'ok') throw new Error('expected occurrences');
    const result = plan({ desired: unconfirmed.occurrences, locationConfirmed: true });
    expect(result.blocked?.reason).toBe('location_not_confirmed');
    expect(result.summary.writes).toBe(0);
  });

  it('reports every affected occurrence so the user sees the scope', () => {
    const desired = desiredEvents();
    const result = plan({ desired, actual: desired.map(syncedRow), locationConfirmed: false });
    expect(result.actions).toHaveLength(desired.length);
  });

  it('proceeds normally once the location is confirmed', () => {
    expect(plan({ desired: desiredEvents(), locationConfirmed: true }).blocked).toBeUndefined();
  });
});

describe('disconnected destinations stop rather than hammer', () => {
  it.each(['needs_reauth', 'revoked'] as const)('blocks when the connection is %s', (status) => {
    const result = plan({ desired: desiredEvents(), connectionStatus: status });
    expect(result.blocked?.reason).toBe('destination_disconnected');
    expect(result.summary.writes).toBe(0);
    expect(result.blocked?.message).toMatch(/safe in Hebrew Dates/);
  });

  it('blocks when the destination calendar has been deleted', () => {
    const result = plan({ desired: desiredEvents(), connectionStatus: 'calendar_missing' });
    expect(result.blocked?.reason).toBe('destination_disconnected');
    expect(result.blocked?.message).toMatch(/no longer exists/);
  });

  it('blocks before the dedicated calendar has been created', () => {
    const result = plan({ desired: desiredEvents(), externalCalendarId: null });
    expect(result.blocked?.reason).toBe('calendar_not_created_yet');
  });
});

describe('retries and backoff', () => {
  function failedRow(event: DestinationEvent, over: Partial<StoredDestinationEvent> = {}) {
    return {
      ...syncedRow(event),
      syncStatus: 'failed' as const,
      attemptCount: 2,
      nextAttemptAtEpochMs: NOW - 1000,
      ...over,
    };
  }

  it('retries a failed write once its backoff has elapsed', () => {
    const desired = desiredEvents();
    const result = plan({ desired, actual: desired.map((e) => failedRow(e)) });
    expect(result.summary.update).toBe(desired.length);
    for (const action of result.actions) expect(action.reason).toBe('retry_after_failure');
  });

  it('waits while the backoff has not elapsed', () => {
    const desired = desiredEvents();
    const result = plan({
      desired,
      actual: desired.map((e) => failedRow(e, { nextAttemptAtEpochMs: NOW + 60_000 })),
    });
    expect(result.summary.writes).toBe(0);
    for (const action of result.actions) {
      expect(action.type).toBe('skip');
      expect(action.reason).toBe('backoff_not_elapsed');
      if (action.type === 'skip') expect(action.blocking).toBe(false);
    }
  });

  it('gives up after the attempt limit and marks it blocking', () => {
    const desired = desiredEvents();
    const result = plan({
      desired,
      actual: desired.map((e) => failedRow(e, { attemptCount: 6 })),
      maxAttempts: 6,
    });
    expect(result.summary.writes).toBe(0);
    for (const action of result.actions) {
      expect(action.reason).toBe('attempt_limit_reached');
      if (action.type === 'skip') expect(action.blocking).toBe(true);
    }
  });

  it('applies the attempt limit to never-written rows too', () => {
    const desired = desiredEvents();
    const result = plan({
      desired,
      actual: desired.map((e) => ({
        ...failedRow(e, { attemptCount: 9 }),
        externalEventId: null,
      })),
    });
    expect(result.summary.create).toBe(0);
    for (const action of result.actions) expect(action.reason).toBe('attempt_limit_reached');
  });

  it('treats retry_scheduled the same as failed', () => {
    const desired = desiredEvents();
    const result = plan({
      desired,
      actual: desired.map((e) => failedRow(e, { syncStatus: 'retry_scheduled' })),
    });
    expect(result.summary.update).toBe(desired.length);
  });

  it('computes capped exponential backoff', () => {
    expect(nextAttemptAt(1, 0)).toBe(30_000);
    expect(nextAttemptAt(2, 0)).toBe(60_000);
    expect(nextAttemptAt(3, 0)).toBe(120_000);
    expect(nextAttemptAt(20, 0)).toBe(6 * 60 * 60 * 1000);
    // Monotonic, never negative, and anchored to the clock passed in.
    expect(nextAttemptAt(0, 5_000)).toBe(35_000);
  });
});

describe('write budget and ordering', () => {
  it('orders writes nearest-first so a truncated pass is still useful', () => {
    const desired = desiredEvents({ count: 20 });
    const actions = plan({ desired, actual: [] }).actions;
    const writeOrder = actions
      .filter((a) => a.type === 'create')
      .map((a) => desired.find((e) => e.key === a.occurrenceKey)!.timing!.startEpochMs);
    const sorted = [...writeOrder].sort((a, b) => a - b);
    expect(writeOrder).toEqual(sorted);
  });

  it('stops at the write budget and reports that more work remains', () => {
    const desired = desiredEvents({ count: 20 });
    const result = plan({ desired, actual: [], maxWrites: 5 });
    expect(result.summary.writes).toBe(5);
    expect(result.hasMoreWork).toBe(true);
    expect(result.summary.skip).toBe(desired.length - 5);
    for (const action of result.actions.filter((a) => a.type === 'skip')) {
      expect(action.reason).toBe('write_budget_exhausted');
      if (action.type === 'skip') expect(action.blocking).toBe(false);
    }
  });

  it('keeps the nearest years when the budget truncates', () => {
    const desired = desiredEvents({ count: 20 });
    const result = plan({ desired, actual: [], maxWrites: 3 });
    const written = result.actions
      .filter((a) => a.type === 'create')
      .map((a) => desired.find((e) => e.key === a.occurrenceKey)!.hebrewYear);
    const earliestThree = [...desired]
      .sort((a, b) => a.timing!.startEpochMs - b.timing!.startEpochMs)
      .slice(0, 3)
      .map((e) => e.hebrewYear);
    expect(written).toEqual(earliestThree);
  });

  it('does not let noops consume the budget', () => {
    const desired = desiredEvents({ count: 20 });
    // All but two already synced; a budget of 2 must still cover both writes.
    const actual = desired.slice(2).map(syncedRow);
    const result = plan({ desired, actual, maxWrites: 2 });
    expect(result.summary.create).toBe(2);
    expect(result.hasMoreWork).toBe(false);
  });

  it('reports no more work when the budget was not reached', () => {
    expect(plan({ desired: desiredEvents(), maxWrites: 100 }).hasMoreWork).toBe(false);
  });
});

describe('all-day events', () => {
  it('plans them like any other event', () => {
    const desired = desiredEvents({ displayMode: 'two_day_all_day' });
    const result = plan({ desired, actual: [] });
    expect(result.summary.create).toBe(desired.length);
  });

  it('orders them by their covered day', () => {
    const desired = desiredEvents({ displayMode: 'two_day_all_day', count: 10 });
    const order = plan({ desired, actual: [] })
      .actions.filter((a) => a.type === 'create')
      .map((a) => desired.find((e) => e.key === a.occurrenceKey)!.allDay.startDate);
    expect(order).toEqual([...order].sort());
  });
});

describe('cross-destination safety', () => {
  it('refuses a desired event belonging to another calendar', () => {
    const desired = desiredEvents({ destinationCalendarId: 'someone-elses-calendar' });
    expect(() => plan({ desired })).toThrow(/belongs to destination/);
  });

  it('refuses a stored row belonging to another calendar', () => {
    const desired = desiredEvents();
    const foreign = { ...syncedRow(desired[0]!), destinationCalendarId: 'other' };
    expect(() => plan({ desired, actual: [foreign] })).toThrow(/belongs to destination/);
  });

  it('refuses duplicate keys on either side', () => {
    const desired = desiredEvents();
    expect(() => plan({ desired: [...desired, desired[0]!] })).toThrow(/Duplicate desired/);
    expect(() =>
      plan({ desired, actual: [syncedRow(desired[0]!), syncedRow(desired[0]!)] }),
    ).toThrow(/Duplicate stored/);
  });
});

describe('the family case: independent plans per member', () => {
  it('plans each member separately, and one member s failure does not affect another', () => {
    const jlm = desiredEvents({ location: jerusalem, destinationCalendarId: 'dest-jlm' });
    const nyc = desiredEvents({ location: newYork, destinationCalendarId: 'dest-nyc' });

    const jlmPlan = planSync({
      destinationCalendarId: 'dest-jlm',
      externalCalendarId: 'cal-jlm',
      desired: jlm,
      actual: jlm.map((e) => ({ ...syncedRow(e), destinationCalendarId: 'dest-jlm' })),
      nowEpochMs: NOW,
      locationConfirmed: true,
    });
    const nycPlan = planSync({
      destinationCalendarId: 'dest-nyc',
      externalCalendarId: 'cal-nyc',
      desired: nyc,
      actual: [],
      nowEpochMs: NOW,
      // This member has not confirmed their location yet.
      locationConfirmed: false,
    });

    expect(jlmPlan.summary.writes).toBe(0);
    expect(jlmPlan.blocked).toBeUndefined();
    expect(nycPlan.blocked?.reason).toBe('location_not_confirmed');
  });

  it('gives the two members different external event IDs for the same anniversary', () => {
    const jlm = desiredEvents({ destinationCalendarId: 'dest-jlm' });
    const nyc = desiredEvents({ destinationCalendarId: 'dest-nyc' });
    expect(jlm[0]!.key).toBe(nyc[0]!.key);
    expect(jlm[0]!.googleEventId).not.toBe(nyc[0]!.googleEventId);
  });
});

describe('empty and degenerate inputs', () => {
  it('produces an empty plan for an empty dataset', () => {
    const result = plan({ desired: [], actual: [] });
    expect(result.actions).toEqual([]);
    expect(result.summary.writes).toBe(0);
    expect(result.hasMoreWork).toBe(false);
  });

  it('deletes everything when a record is removed entirely', () => {
    const previous = desiredEvents();
    const result = plan({ desired: [], actual: previous.map(syncedRow) });
    expect(result.summary.delete).toBe(previous.length);
  });

  it('blocks an empty desired set too, when the destination is disconnected', () => {
    const result = plan({ desired: [], actual: [], connectionStatus: 'revoked' });
    expect(result.blocked?.reason).toBe('destination_disconnected');
  });
});
