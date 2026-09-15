/**
 * Migration runner.
 *
 * Deliberately minimal and deliberately *not* an ORM's migration engine:
 *
 *  - Migrations are the plain `.sql` files in `db/migrations`, applied in
 *    filename order. They are the authoritative schema.
 *  - Each file runs inside its own transaction, and each file already contains
 *    `BEGIN`/`COMMIT`, so the runner executes the file as a single statement
 *    batch and lets Postgres own atomicity.
 *  - A checksum is recorded. Editing an applied migration is a mistake that is
 *    easy to make and expensive to debug, so it is detected and refused rather
 *    than silently ignored.
 *  - An advisory lock serialises concurrent runners, which matters because
 *    Vercel can start several instances of a deploy hook at once.
 *
 * The whole run is pinned to **one** connection. A `pg` pool hands out whichever
 * connection is free, so lock-then-migrate-then-unlock issued as three separate
 * queries could take the session-scoped advisory lock on one connection and run
 * the migrations on another — serialising nothing. `db.connection()` holds a
 * single session for the duration, which is also why this must not run through
 * Neon's transaction pooler.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Kysely, sql } from 'kysely';
import type { Database } from './schema';

/** Arbitrary but fixed: the advisory lock key for schema changes. */
const MIGRATION_LOCK_KEY = 8_147_236_915;

export interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export class MigrationChecksumMismatchError extends Error {}

export async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory);
  const files = entries.filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (filename) => {
      const contents = await readFile(join(directory, filename), 'utf8');
      return {
        filename,
        sql: contents,
        checksum: createHash('sha256').update(contents).digest('hex').slice(0, 32),
      };
    }),
  );
}

async function ensureMigrationsTable(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum   text NOT NULL
    )
  `.execute(db);
}

export async function migrate(
  db: Kysely<Database>,
  directory: string,
  options: { allowChecksumDrift?: boolean } = {},
): Promise<MigrationResult> {
  const migrations = await readMigrations(directory);

  return db.connection().execute(async (connection) => {
    // The lock comes first, before anything touches the catalogue. Two runners
    // both issuing `CREATE TABLE IF NOT EXISTS` at once race inside Postgres
    // itself and one fails on `pg_type_typname_nsp_index` — the check and the
    // create are not atomic together.
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`.execute(connection);
    try {
      await ensureMigrationsTable(connection);

      const applied = await connection
        .selectFrom('schema_migrations')
        .select(['filename', 'checksum'])
        .execute();
      const appliedByName = new Map(applied.map((row) => [row.filename, row.checksum]));

      const result: MigrationResult = { applied: [], alreadyApplied: [] };

      for (const migration of migrations) {
        const previousChecksum = appliedByName.get(migration.filename);
        if (previousChecksum !== undefined) {
          if (previousChecksum !== migration.checksum && !options.allowChecksumDrift) {
            throw new MigrationChecksumMismatchError(
              `${migration.filename} has changed since it was applied ` +
                `(recorded ${previousChecksum}, now ${migration.checksum}). ` +
                'Applied migrations are immutable: add a new migration instead.',
            );
          }
          result.alreadyApplied.push(migration.filename);
          continue;
        }

        // The file carries its own BEGIN/COMMIT, so it is executed as-is and
        // Postgres owns atomicity.
        try {
          await sql.raw(migration.sql).execute(connection);
        } catch (error) {
          // A statement inside the file failed, so the session is sitting in an
          // aborted transaction and will reject everything — including the
          // advisory unlock below, and every later query if this connection
          // goes back to the pool. Clear it before rethrowing.
          await sql`ROLLBACK`.execute(connection).catch(() => undefined);
          throw error;
        }

        await connection
          .insertInto('schema_migrations')
          .values({ filename: migration.filename, checksum: migration.checksum })
          .execute();
        result.applied.push(migration.filename);
      }

      return result;
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.execute(connection);
    }
  });
}

/** Every table the schema expects, for the parity check. */
export const EXPECTED_TABLES = [
  'audit_log',
  'calendar_locations',
  'datasets',
  'destination_calendars',
  'destination_events',
  'generated_occurrences',
  'google_accounts',
  'google_calendar_connections',
  'oauth_states',
  'outbound_throttle',
  'owner_members',
  'owners',
  'rate_limits',
  'reminder_rules',
  'schema_migrations',
  'sessions',
  'source_records',
  'sync_jobs',
  'users',
] as const;

export interface ColumnInfo {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}

/** Read the live catalogue, so tests can compare it with the Kysely types. */
export async function describeSchema(db: Kysely<Database>): Promise<ColumnInfo[]> {
  const result = await sql<ColumnInfo>`
    SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position
  `.execute(db);
  return result.rows;
}
