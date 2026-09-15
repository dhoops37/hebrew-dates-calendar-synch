/**
 * The application-wide outbound gate.
 *
 * The property under test is the one the thing exists for: **across separate
 * connections** — standing in for separate Vercel instances — the slots handed
 * out are spaced by the minimum interval, and no two callers get the same slot.
 * A single-threaded test would pass against an implementation that does not
 * hold that at all, which is why the concurrency cases here use real
 * connections.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  peekThrottle,
  reserveThrottleSlot,
  resetThrottle,
} from '../../src/outbound-throttle';
import { createTestDatabase, describeWithDatabase, type TestDatabase } from '../helpers/database';

describe.runIf(describeWithDatabase)('the outbound throttle', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await createTestDatabase('throttle');
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  beforeEach(async () => {
    await resetThrottle(harness.db, 'test');
  });

  const policy = { key: 'test', minIntervalMs: 1000, maxWaitMs: 10_000 };

  it('lets the first request go immediately', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const slot = await reserveThrottleSlot(harness.db, { ...policy, now });

    // Nothing to space it from, and making a user wait a second for the first
    // search of the day would be a cost for no benefit.
    expect(slot.granted).toBe(true);
    expect(slot.waitMs).toBe(0);
  });

  it('spaces sequential requests by the minimum interval', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const first = await reserveThrottleSlot(harness.db, { ...policy, now });
    const second = await reserveThrottleSlot(harness.db, { ...policy, now });
    const third = await reserveThrottleSlot(harness.db, { ...policy, now });

    expect(first.waitMs).toBe(0);
    expect(second.waitMs).toBe(1000);
    expect(third.waitMs).toBe(2000);
  });

  it('never hands the same slot to two concurrent callers on separate connections', async () => {
    // The whole reason this is in Postgres rather than in a module-scope queue.
    // Ten simultaneous callers, as ten warm Vercel instances would be: the
    // slots must be distinct and exactly one interval apart.
    const now = new Date('2026-05-01T12:00:00Z');
    const connections = Array.from({ length: 10 }, () => harness.connect());

    const slots = await Promise.all(
      connections.map((connection) => reserveThrottleSlot(connection, { ...policy, now })),
    );

    expect(slots.every((slot) => slot.granted)).toBe(true);
    const waits = slots.map((slot) => slot.waitMs).sort((a, b) => a - b);
    expect(waits).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]);
  });

  it('lets the queue drain as time passes rather than holding the backlog', async () => {
    const start = new Date('2026-05-01T12:00:00Z');
    await reserveThrottleSlot(harness.db, { ...policy, now: start });
    await reserveThrottleSlot(harness.db, { ...policy, now: start });

    // Two slots taken means the marker is 2s out. Ten seconds later it is in
    // the past, so the next caller goes straight through.
    const later = new Date(start.getTime() + 10_000);
    const slot = await reserveThrottleSlot(harness.db, { ...policy, now: later });
    expect(slot.waitMs).toBe(0);
  });

  it('refuses rather than queueing when the backlog exceeds the caller budget', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    // Fill the queue to 5 seconds deep.
    for (let index = 0; index < 5; index += 1) {
      await reserveThrottleSlot(harness.db, { ...policy, now });
    }

    const impatient = await reserveThrottleSlot(harness.db, {
      ...policy,
      maxWaitMs: 2_000,
      now,
    });
    expect(impatient.granted).toBe(false);
    expect(impatient.queueDepthMs).toBe(5_000);
  });

  it('does not advance the queue for a caller it refused', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    for (let index = 0; index < 5; index += 1) {
      await reserveThrottleSlot(harness.db, { ...policy, now });
    }
    const before = await peekThrottle(harness.db, 'test', now);

    await reserveThrottleSlot(harness.db, { ...policy, maxWaitMs: 2_000, now });

    // A caller that stood down took no turn, so it must not have pushed the
    // queue out for everyone behind it. Otherwise a burst of refusals would
    // drive the backlog up without a single request being sent.
    expect(await peekThrottle(harness.db, 'test', now)).toBe(before);
  });

  it('keeps separate upstreams on separate budgets', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await reserveThrottleSlot(harness.db, { ...policy, now });
    await reserveThrottleSlot(harness.db, { ...policy, now });

    const other = await reserveThrottleSlot(harness.db, { ...policy, key: 'other', now });
    expect(other.waitMs).toBe(0);

    await resetThrottle(harness.db, 'other');
  });

  it('reports a queue depth without taking a slot', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    expect(await peekThrottle(harness.db, 'test', now)).toBe(0);

    await reserveThrottleSlot(harness.db, { ...policy, now });
    expect(await peekThrottle(harness.db, 'test', now)).toBe(1000);

    // Peeking twice must not move it.
    expect(await peekThrottle(harness.db, 'test', now)).toBe(1000);
  });
});
