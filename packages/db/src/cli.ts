#!/usr/bin/env node
/**
 * Migration CLI.
 *
 * `pnpm db:migrate` applies `db/migrations/*.sql` to whatever `DATABASE_URL`
 * points at, and `pnpm db:status` reports what is applied without changing
 * anything. Deliberately a script rather than a build step: applying a
 * migration to a production database should be something a person does
 * knowingly.
 *
 * Migrations and schema inspection need a session-scoped connection (advisory
 * locks), so this refuses Neon's pooled endpoint and asks for the direct one.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createDb } from './client.ts';
import { EXPECTED_TABLES, describeSchema, migrate, readMigrations } from './migrate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(join(here, '..', '..', '..', 'db', 'migrations'));

function connectionString(): string {
  // The direct endpoint is preferred and required; `DATABASE_URL` is accepted
  // so a local database needs no second variable.
  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Set DATABASE_URL_DIRECT (preferred) or DATABASE_URL. For Neon, use the DIRECT ' +
        'connection string, not the -pooler one: migrations take a session-scoped ' +
        'advisory lock, which a transaction pooler breaks.',
    );
  }
  return url;
}

async function run(): Promise<void> {
  const command = process.argv[2] ?? 'migrate';
  const directory = process.argv[3] ?? DEFAULT_MIGRATIONS_DIR;

  const db = createDb({
    connectionString: connectionString(),
    requireDirectConnection: true,
    maxConnections: 1,
  });

  try {
    if (command === 'migrate') {
      const result = await migrate(db, directory);
      for (const filename of result.alreadyApplied) {
        console.log(`  already applied  ${filename}`);
      }
      for (const filename of result.applied) {
        console.log(`  APPLIED          ${filename}`);
      }
      if (result.applied.length === 0) {
        console.log('\nNothing to do: the schema is up to date.');
      } else {
        console.log(`\nApplied ${result.applied.length} migration(s).`);
      }
      return;
    }

    if (command === 'status') {
      const onDisk = await readMigrations(directory);
      const columns = await describeSchema(db);
      const tables = new Set(columns.map((column) => column.table_name));

      const applied = tables.has('schema_migrations')
        ? await db.selectFrom('schema_migrations').select(['filename', 'checksum']).execute()
        : [];
      const appliedByName = new Map(applied.map((row) => [row.filename, row.checksum]));

      console.log('Migrations:');
      for (const file of onDisk) {
        const recorded = appliedByName.get(file.filename);
        const state =
          recorded === undefined
            ? 'PENDING'
            : recorded === file.checksum
              ? 'applied'
              : 'CHANGED SINCE APPLIED';
        console.log(`  ${state.padEnd(22)} ${file.filename}`);
      }

      const missing = EXPECTED_TABLES.filter((table) => !tables.has(table));
      console.log(`\nTables present: ${tables.size}`);
      if (missing.length > 0) console.log(`Missing tables: ${missing.join(', ')}`);
      return;
    }

    throw new Error(`Unknown command "${command}". Expected "migrate" or "status".`);
  } finally {
    await db.destroy();
  }
}

run().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
