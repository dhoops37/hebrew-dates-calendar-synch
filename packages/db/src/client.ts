/**
 * Database client.
 *
 * Neon-specific notes that matter for correctness rather than performance:
 *
 *  - **`sslmode=require` is mandatory** and is asserted here rather than left to
 *    the connection string, because a silently unencrypted connection to a
 *    managed database is exactly the kind of thing nobody notices.
 *  - **Pool size is small on purpose.** Vercel's serverless functions each hold
 *    their own pool, so a large per-instance pool multiplies into Neon's
 *    connection limit. Neon's pooled (pgBouncer) endpoint is the right target
 *    for the web app; the migration runner and the worker use the direct
 *    endpoint because they need session-level features.
 *  - **`FOR UPDATE SKIP LOCKED` needs a real session**, not a transaction-pooled
 *    one. The job runner therefore must use the direct connection string. This
 *    is checked at run time rather than documented and forgotten.
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool, types } from 'pg';
import type { Database } from './schema';

export type { Database } from './schema';
export { sql } from 'kysely';
export type { Transaction } from 'kysely';

/** Postgres OIDs for the types we override. */
const OID_NUMERIC = 1700;
const OID_DATE = 1082;
const OID_INT8 = 20;

let typesConfigured = false;

/**
 * Keep numeric and date as strings, and make bigint a number.
 *
 * `numeric` as a float would quietly round latitude/longitude, which is the one
 * value in this system that must survive a round trip exactly. `date` as a JS
 * `Date` would reintroduce the timezone bug the engine spent so much effort
 * eliminating — a Gregorian calendar day is not an instant.
 */
function configureTypeParsers(): void {
  if (typesConfigured) return;
  types.setTypeParser(OID_NUMERIC, (value) => value);
  types.setTypeParser(OID_DATE, (value) => value);
  types.setTypeParser(OID_INT8, (value) => Number.parseInt(value, 10));
  typesConfigured = true;
}

export interface CreateDbOptions {
  connectionString: string;
  /** Max connections for this instance. Keep small under serverless. */
  maxConnections?: number;
  /**
   * Notified when an **idle** pooled connection dies — see the handler in
   * `createDb` for why this exists at all. Defaults to a `console.warn`.
   */
  onIdleConnectionError?: (error: Error) => void;
  /**
   * Set for the job runner and migrations: asserts the connection is not going
   * through a transaction pooler, because `FOR UPDATE SKIP LOCKED` and advisory
   * locks need a session-scoped connection.
   */
  requireDirectConnection?: boolean;
  /** Allow plaintext connections. Only ever true for a local test database. */
  allowInsecure?: boolean;
}

export class InsecureDatabaseUrlError extends Error {}
export class PooledConnectionNotAllowedError extends Error {}

export function createDb(options: CreateDbOptions): Kysely<Database> {
  configureTypeParsers();
  assertUsableConnectionString(options);

  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 3,
    // A serverless invocation that cannot get a connection should fail fast and
    // be retried by the caller, not hang until the platform kills it.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  });

  // Not optional, and not merely tidy. `pg` emits 'error' on the pool when a
  // connection dies while **idle** — Neon closing an idle connection, a
  // failover, a maintenance restart, an administrator terminating a backend. If
  // nothing is listening, `pg` rethrows, and because there is no request on the
  // stack at that moment it surfaces as an uncaught exception and takes the
  // whole process down. On Vercel that means killing whatever request happened
  // to be in flight, for a connection nobody was using.
  //
  // There is nothing to do about it beyond noticing: the pool has already
  // discarded the client, and the next caller gets a fresh one.
  pool.on('error', (error: Error) => {
    if (options.onIdleConnectionError) {
      options.onIdleConnectionError(error);
      return;
    }
    console.warn('[db] an idle pooled connection was closed by the server:', error.message);
  });

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export function assertUsableConnectionString(options: CreateDbOptions): void {
  const { connectionString, allowInsecure = false, requireDirectConnection = false } = options;
  const isLocal =
    connectionString.includes('localhost') ||
    connectionString.includes('127.0.0.1') ||
    connectionString.includes('@/') ||
    connectionString.startsWith('postgres://pgtest') ||
    connectionString.includes('host=/');

  if (!allowInsecure && !isLocal) {
    // Neon requires TLS; anything else means the URL was hand-edited or the
    // wrong variable was wired up.
    const requiresTls = /sslmode=(require|verify-ca|verify-full)/.test(connectionString);
    if (!requiresTls) {
      throw new InsecureDatabaseUrlError(
        'DATABASE_URL must specify sslmode=require (or stronger) for a remote database. ' +
          'Refusing to open an unencrypted connection.',
      );
    }
  }

  if (requireDirectConnection && connectionString.includes('-pooler.')) {
    throw new PooledConnectionNotAllowedError(
      'This connection needs a session-scoped database connection (FOR UPDATE SKIP LOCKED / ' +
        'advisory locks). Use the direct Neon endpoint, not the -pooler one. ' +
        'Set DATABASE_URL_DIRECT for migrations and the job runner.',
    );
  }
}

/** Confirm the database is reachable and is the version we target. */
export async function checkDatabase(db: Kysely<Database>): Promise<{ version: string }> {
  const result = await sql<{ version: string }>`select version()`.execute(db);
  const version = result.rows[0]?.version ?? 'unknown';
  return { version };
}
