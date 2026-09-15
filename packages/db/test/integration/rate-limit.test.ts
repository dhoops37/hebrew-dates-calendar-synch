/**
 * The rate limiter, against a real server.
 *
 * The property that matters is atomicity. Two concurrent requests must not both
 * read "0 attempts so far" and both be allowed, because that is exactly the
 * situation the limiter exists for — and it is the part that a single-threaded
 * test would never catch. So the concurrency case here uses genuinely separate
 * connections.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RATE_LIMITS,
  checkRateLimit,
  consumeRateLimit,
  peekRateLimit,
  purgeRateLimits,
  resetRateLimit,
} from '../../src/rate-limit';
import { createTestDatabase, describeWithDatabase, type TestDatabase } from '../helpers/database';

describe.runIf(describeWithDatabase)('rate limiter', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await createTestDatabase('ratelimit');
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  const policy = { limit: 3, windowMs: 60_000 };

  it('allows attempts up to the limit and refuses the next', async () => {
    const bucket = 'test:allow-then-refuse';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const decision = await consumeRateLimit(harness.db, { bucket, ...policy });
      expect(decision.allowed, `attempt ${attempt}`).toBe(true);
      expect(decision.attempts).toBe(attempt);
    }

    const refused = await consumeRateLimit(harness.db, { bucket, ...policy });
    expect(refused.allowed).toBe(false);
    expect(refused.attempts).toBe(4);
    expect(refused.limit).toBe(3);
  });

  it('keeps counting while refusing, so hammering does not let the counter decay', async () => {
    const bucket = 'test:keeps-counting';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await consumeRateLimit(harness.db, { bucket, ...policy });
    }
    const state = await peekRateLimit(harness.db, bucket);
    expect(state?.attempts).toBe(10);
  });

  it('resets once the window has passed', async () => {
    const bucket = 'test:window-reset';
    const start = new Date('2026-04-01T12:00:00Z');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await consumeRateLimit(harness.db, { bucket, ...policy, now: start });
    }
    expect((await consumeRateLimit(harness.db, { bucket, ...policy, now: start })).allowed).toBe(
      false,
    );

    // One second past the window: a fresh window, counting from one.
    const later = new Date(start.getTime() + policy.windowMs + 1000);
    const afterReset = await consumeRateLimit(harness.db, { bucket, ...policy, now: later });
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.attempts).toBe(1);
  });

  it('does not reset early, within the window', async () => {
    const bucket = 'test:no-early-reset';
    const start = new Date('2026-04-01T12:00:00Z');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await consumeRateLimit(harness.db, { bucket, ...policy, now: start });
    }

    // Most of the way through the window, but not past it.
    const nearlyOver = new Date(start.getTime() + policy.windowMs - 1000);
    const decision = await consumeRateLimit(harness.db, { bucket, ...policy, now: nearlyOver });
    expect(decision.allowed).toBe(false);
    expect(decision.attempts).toBe(4);
  });

  it('reports when the window resets, for a Retry-After header', async () => {
    const bucket = 'test:retry-after';
    const start = new Date('2026-04-01T12:00:00Z');
    const decision = await consumeRateLimit(harness.db, { bucket, ...policy, now: start });

    expect(decision.resetsAt.getTime()).toBe(start.getTime() + policy.windowMs);
    expect(decision.retryAfterSeconds).toBe(60);
    // Never zero or negative: a Retry-After of 0 invites an immediate retry.
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each bucket separately', async () => {
    // One noisy caller must not lock out everybody else.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await consumeRateLimit(harness.db, { bucket: 'test:noisy', ...policy });
    }
    const other = await consumeRateLimit(harness.db, { bucket: 'test:quiet', ...policy });
    expect(other.allowed).toBe(true);
    expect(other.attempts).toBe(1);
  });

  it('never lets two concurrent callers both slip past the limit', async () => {
    // The whole reason this lives in Postgres rather than in memory. Ten
    // simultaneous requests on separate connections against a limit of three:
    // exactly three may be allowed, and the counter must read exactly ten.
    const bucket = 'test:concurrent';
    const connections = Array.from({ length: 10 }, () => harness.connect());

    const decisions = await Promise.all(
      connections.map((connection) => consumeRateLimit(connection, { bucket, ...policy })),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(await peekRateLimit(harness.db, bucket)).toMatchObject({ attempts: 10 });
    // Every attempt got a distinct sequence number, so none was lost.
    expect(new Set(decisions.map((decision) => decision.attempts)).size).toBe(10);
  });

  it('can be cleared by an operator', async () => {
    const bucket = 'test:reset';
    await consumeRateLimit(harness.db, { bucket, ...policy });
    await resetRateLimit(harness.db, bucket);
    expect(await peekRateLimit(harness.db, bucket)).toBeUndefined();

    const afterReset = await consumeRateLimit(harness.db, { bucket, ...policy });
    expect(afterReset.attempts).toBe(1);
  });

  it('purges aged-out windows, keeping live ones', async () => {
    const now = new Date('2026-04-01T12:00:00Z');
    await consumeRateLimit(harness.db, {
      bucket: 'test:old',
      ...policy,
      now: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    });
    await consumeRateLimit(harness.db, { bucket: 'test:fresh', ...policy, now });

    const purged = await purgeRateLimits(harness.db, { now });
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await peekRateLimit(harness.db, 'test:old')).toBeUndefined();
    expect(await peekRateLimit(harness.db, 'test:fresh')).toBeDefined();
  });

  describe('the named policies', () => {
    it('applies the sign-in policy under its own prefixed bucket', async () => {
      const decision = await checkRateLimit(harness.db, 'authStart', '203.0.113');
      expect(decision.limit).toBe(RATE_LIMITS.authStart.limit);
      // Prefixed, so two policies on the same subject do not share a counter.
      expect(await peekRateLimit(harness.db, 'authStart:203.0.113')).toBeDefined();
      expect(await peekRateLimit(harness.db, 'authCallback:203.0.113')).toBeUndefined();
      expect(decision.allowed).toBe(true);
    });

    it('leaves a real person plenty of room', async () => {
      // Twenty sign-in starts in fifteen minutes. Someone switching accounts or
      // retrying a failed consent needs a handful; this must not be in their way.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const decision = await checkRateLimit(harness.db, 'authStart', '198.51.100');
        expect(decision.allowed).toBe(true);
      }
    });

    it('stops a script', async () => {
      let refusals = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const decision = await checkRateLimit(harness.db, 'authStart', '192.0.2');
        if (!decision.allowed) refusals += 1;
      }
      expect(refusals).toBe(40 - RATE_LIMITS.authStart.limit);
    });

    it('sets every policy to something a person would not hit', () => {
      for (const [name, limits] of Object.entries(RATE_LIMITS)) {
        expect(limits.limit, name).toBeGreaterThanOrEqual(20);
        expect(limits.windowMs, name).toBeGreaterThanOrEqual(60_000);
      }
    });
  });
});
