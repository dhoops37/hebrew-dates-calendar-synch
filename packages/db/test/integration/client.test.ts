/**
 * The connection pool's failure behaviour.
 *
 * One property, and it is the kind that only shows up in production: when a
 * pooled connection dies while **idle**, `pg` emits 'error' on the pool. If
 * nothing is listening it rethrows, and since there is no request on the stack
 * at that moment it becomes an uncaught exception and kills the process — on
 * Vercel, killing whatever request happened to be in flight, for a connection
 * nobody was using.
 *
 * Neon closes idle connections, fails over and restarts for maintenance, so
 * this is not a hypothetical. The test reproduces it with
 * `pg_terminate_backend`, which is what the platform does to a backend it wants
 * gone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../src/client';
import { createTestDatabase, describeWithDatabase, type TestDatabase } from '../helpers/database';

describe.runIf(describeWithDatabase)('the connection pool', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await createTestDatabase('client');
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  it('reports an idle connection killed by the server instead of crashing', async () => {
    const seen: Error[] = [];
    const db = createDb({
      connectionString: harness.connectionString,
      allowInsecure: true,
      maxConnections: 1,
      onIdleConnectionError: (error) => seen.push(error),
    });

    try {
      // Establish a connection and let it go idle in the pool.
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
      const pid = rows[0]?.pid as number;
      expect(pid).toBeTypeOf('number');

      // Kill it from outside, the way a platform restart would.
      await sql`SELECT pg_terminate_backend(${pid})`.execute(harness.db);

      // The pool notices asynchronously. Without a listener this is where the
      // process would have died.
      await waitFor(() => seen.length > 0);
      expect(seen[0]?.message).toContain('terminating connection');

      // And the pool recovers: the next caller gets a fresh connection.
      const after = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(db);
      expect(after.rows[0]?.ok).toBe(1);
    } finally {
      await db.destroy();
    }
  }, 30_000);
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('the pool never reported the closed connection');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
