/**
 * Integration-test harness: a real PostgreSQL database per test file.
 *
 * These tests exist to prove the things only Postgres can prove — CHECK
 * constraints, unique indexes, `FOR UPDATE SKIP LOCKED`, cascade behaviour. A
 * mock would assert that our beliefs about the schema are self-consistent, which
 * is not the same as true, and the constraints here encode product rules ("a
 * yahrzeit on the 30th needs an origin year") that must not be bypassable.
 *
 * Set `TEST_DATABASE_URL` to an admin connection string. Without it the
 * integration suites skip rather than fail, so `pnpm test` still works on a
 * machine with no database.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createDb } from '../../src/client';
import { migrate } from '../../src/migrate';
import type { Database } from '../../src/schema';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', '..', '..', '..', 'db', 'migrations');

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasDatabase = Boolean(TEST_DATABASE_URL);

/** `describe.skipIf(!hasDatabase)` reads badly; this reads as intent. */
export const describeWithDatabase = hasDatabase;

function databaseUrlFor(name: string): string {
  const url = new URL(TEST_DATABASE_URL as string);
  url.pathname = `/${name}`;
  return url.toString();
}

export interface TestDatabase {
  db: Kysely<Database>;
  name: string;
  connectionString: string;
  /** A second client to the same database, for concurrency tests. */
  connect(): Kysely<Database>;
  destroy(): Promise<void>;
}

/**
 * Create a throwaway database, migrate it, and hand back a client.
 *
 * A database per test file rather than a shared one with truncation: the point
 * is to exercise the real migration against a real empty server, and isolation
 * means a failing test cannot poison its neighbours.
 */
export async function createTestDatabase(
  label: string,
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');

  const name = `hd_test_${label}_${randomBytes(4).toString('hex')}`;
  const admin = createDb({ connectionString: TEST_DATABASE_URL, allowInsecure: true });
  try {
    await sql.raw(`CREATE DATABASE "${name}"`).execute(admin);
  } finally {
    await admin.destroy();
  }

  const connectionString = databaseUrlFor(name);
  const extras: Kysely<Database>[] = [];
  // A connection terminated by `DROP DATABASE ... WITH (FORCE)` is expected
  // here, so it is not worth a warning per test file. Anything else still is.
  let tearingDown = false;
  const onIdleConnectionError = (error: Error) => {
    if (!tearingDown) {
      console.warn(`[test-db ${name}] idle connection closed by the server:`, error.message);
    }
  };
  const connect = (): Kysely<Database> => {
    const extra = createDb({
      connectionString,
      allowInsecure: true,
      maxConnections: 2,
      onIdleConnectionError,
    });
    extras.push(extra);
    return extra;
  };

  const db = createDb({ connectionString, allowInsecure: true, onIdleConnectionError });
  // The migration-runner tests need an empty server to migrate themselves.
  if (options.migrate !== false) await migrate(db, MIGRATIONS_DIR);

  return {
    db,
    name,
    connectionString,
    connect,
    async destroy() {
      tearingDown = true;
      await Promise.all(extras.map((extra) => extra.destroy()));
      await db.destroy();
      const cleanup = createDb({ connectionString: TEST_DATABASE_URL, allowInsecure: true });
      try {
        // `pool.end()` resolves once it has asked its clients to close, which is
        // not the same as the server having reaped the backends. Dropping while
        // one is still attached makes `WITH (FORCE)` terminate it, and the FATAL
        // lands on a socket that is still being read — reported as an unhandled
        // error and attributed to whichever file happened to be running. So
        // wait for the backends to actually go, and keep FORCE as the backstop.
        await waitForNoBackends(cleanup, name);
        await sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).execute(cleanup);
      } finally {
        await cleanup.destroy();
      }
    },
  };
}

/**
 * Wait until nothing is connected to `database`.
 *
 * Best effort: after two seconds it gives up and lets `WITH (FORCE)` deal with
 * whatever is left, because a hung teardown is worse than a stray warning.
 */
async function waitForNoBackends(
  admin: Kysely<Database>,
  database: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await sql<{ count: number }>`
      SELECT count(*)::int AS count
        FROM pg_stat_activity
       WHERE datname = ${database}
         AND pid <> pg_backend_pid()
    `.execute(admin);
    if ((result.rows[0]?.count ?? 0) === 0) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Assert that a write is refused by the database.
 *
 * Returns the constraint name so a test can pin *which* rule fired. Asserting
 * only "it threw" would pass if the row were rejected for an unrelated reason,
 * such as a typo in a column name.
 */
export async function expectRejection(
  action: () => Promise<unknown>,
): Promise<{ constraint?: string; code?: string; message: string }> {
  try {
    await action();
  } catch (error) {
    const pgError = error as { constraint?: string; code?: string; message: string };
    return {
      constraint: pgError.constraint,
      code: pgError.code,
      message: pgError.message,
    };
  }
  throw new Error('Expected the database to reject this write, but it succeeded.');
}

/* ------------------------------------------------------------- fixtures -- */

export interface Tenant {
  userId: string;
  ownerId: string;
  datasetId: string;
  destinationCalendarId: string;
}

/**
 * A fully-formed, independent tenant.
 *
 * Tenant-boundary tests need two of these that differ in every id, so the
 * fixture takes a suffix rather than hard-coding values.
 */
export async function seedTenant(
  db: Kysely<Database>,
  suffix: string,
  options: { kind?: 'individual' | 'household' } = {},
): Promise<Tenant> {
  const user = await db
    .insertInto('users')
    .values({ email: `user-${suffix}@example.test`, display_name: `User ${suffix}` })
    .returning('id')
    .executeTakeFirstOrThrow();

  const owner = await db
    .insertInto('owners')
    .values({ kind: options.kind ?? 'individual', name: `Owner ${suffix}` })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db
    .insertInto('owner_members')
    .values({ owner_id: owner.id, user_id: user.id, role: 'admin' })
    .execute();

  const dataset = await db
    .insertInto('datasets')
    .values({ owner_id: owner.id, name: `Dataset ${suffix}` })
    .returning('id')
    .executeTakeFirstOrThrow();

  const calendar = await db
    .insertInto('destination_calendars')
    .values({
      dataset_id: dataset.id,
      user_id: user.id,
      name: `Calendar ${suffix}`,
      destination_type: 'google',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return {
    userId: user.id,
    ownerId: owner.id,
    datasetId: dataset.id,
    destinationCalendarId: calendar.id,
  };
}

/** A confirmed location, which is what the sync planner requires. */
export async function seedConfirmedLocation(
  db: Kysely<Database>,
  params: { destinationCalendarId: string; userId: string; timezoneId?: string },
): Promise<string> {
  const row = await db
    .insertInto('calendar_locations')
    .values({
      destination_calendar_id: params.destinationCalendarId,
      display_name: 'Jerusalem, Israel',
      country_code: 'IL',
      latitude: '31.778100',
      longitude: '35.235200',
      elevation_meters: 754,
      timezone_id: params.timezoneId ?? 'Asia/Jerusalem',
      source: 'user_selected',
      confirmed_at: new Date(),
      confirmed_by_user_id: params.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
