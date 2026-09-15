/**
 * The migration runner, against a real server.
 *
 * Three properties matter operationally. Re-running must be a no-op, because
 * Vercel runs the deploy hook on every deploy. Editing an applied migration
 * must be refused, because it is an easy mistake with an expensive debugging
 * session attached. And two runners starting at once must not both apply the
 * same file, because a deploy can start several instances.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  InsecureDatabaseUrlError,
  PooledConnectionNotAllowedError,
  assertUsableConnectionString,
  checkDatabase,
} from '../../src/client';
import {
  EXPECTED_TABLES,
  MigrationChecksumMismatchError,
  migrate,
  readMigrations,
} from '../../src/migrate';
import {
  MIGRATIONS_DIR,
  createTestDatabase,
  describeWithDatabase,
  type TestDatabase,
} from '../helpers/database';

describe.runIf(describeWithDatabase)('migration runner', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await createTestDatabase('migrate');
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  it('has already applied every migration via the harness', async () => {
    const applied = await harness.db
      .selectFrom('schema_migrations')
      .select(['filename', 'checksum'])
      .orderBy('filename')
      .execute();
    const onDisk = await readMigrations(MIGRATIONS_DIR);

    expect(applied.map((row) => row.filename)).toEqual(onDisk.map((file) => file.filename));
    expect(applied.map((row) => row.checksum)).toEqual(onDisk.map((file) => file.checksum));
  });

  it('is a no-op when run again', async () => {
    const result = await migrate(harness.db, MIGRATIONS_DIR);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied.length).toBeGreaterThan(0);
  });

  it('runs migrations in filename order', async () => {
    const onDisk = await readMigrations(MIGRATIONS_DIR);
    const names = onDisk.map((file) => file.filename);
    expect(names).toEqual([...names].sort());
    // Ordering is load-bearing: 0002 references users(id) from 0001.
    expect(names[0]).toMatch(/^0001_/);
  });

  it('creates the version 16 features the schema relies on', async () => {
    const { version } = await checkDatabase(harness.db);
    expect(version).toContain('PostgreSQL');

    // citext for case-insensitive email, pgcrypto for gen_random_uuid.
    const extensions = await sql<{ extname: string }>`
      SELECT extname FROM pg_extension ORDER BY extname
    `.execute(harness.db);
    const names = extensions.rows.map((row) => row.extname);
    expect(names).toContain('citext');
  });

  it('refuses to re-apply a migration whose contents have changed', async () => {
    // A separate database, because the point is to migrate a fresh one and then
    // tamper with the file.
    const directory = await mkdtemp(join(tmpdir(), 'hd-migrations-'));
    const original = '-- first\nBEGIN;\nCREATE TABLE widgets (id int primary key);\nCOMMIT;\n';
    await writeFile(join(directory, '0001_widgets.sql'), original);

    const scratch = await createTestDatabase('checksum', { migrate: false });
    try {
      const first = await migrate(scratch.db, directory);
      expect(first.applied).toEqual(['0001_widgets.sql']);

      await writeFile(
        join(directory, '0001_widgets.sql'),
        `${original}-- an innocent-looking addition\n`,
      );

      await expect(migrate(scratch.db, directory)).rejects.toThrow(MigrationChecksumMismatchError);
      // The message has to say what to do, because this fires during a deploy.
      await expect(migrate(scratch.db, directory)).rejects.toThrow(/add a new migration instead/);

      // And it can be overridden deliberately, for the case where the drift is
      // known to be cosmetic.
      const forced = await migrate(scratch.db, directory, { allowChecksumDrift: true });
      expect(forced.alreadyApplied).toEqual(['0001_widgets.sql']);
    } finally {
      await scratch.destroy();
    }
  }, 60_000);

  it('applies a new migration without touching the applied ones', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hd-migrations-'));
    await writeFile(
      join(directory, '0001_a.sql'),
      'BEGIN;\nCREATE TABLE a (id int primary key);\nCOMMIT;\n',
    );

    const scratch = await createTestDatabase('incremental', { migrate: false });
    try {
      await migrate(scratch.db, directory);
      await writeFile(
        join(directory, '0002_b.sql'),
        'BEGIN;\nCREATE TABLE b (id int primary key, a_id int references a(id));\nCOMMIT;\n',
      );

      const second = await migrate(scratch.db, directory);
      expect(second.applied).toEqual(['0002_b.sql']);
      expect(second.alreadyApplied).toEqual(['0001_a.sql']);
    } finally {
      await scratch.destroy();
    }
  }, 60_000);

  it('rolls a failing migration back entirely', async () => {
    // Each file carries its own BEGIN/COMMIT, so a failure halfway through must
    // leave nothing behind — otherwise a retry hits "table already exists".
    const directory = await mkdtemp(join(tmpdir(), 'hd-migrations-'));
    await writeFile(
      join(directory, '0001_broken.sql'),
      'BEGIN;\nCREATE TABLE good (id int primary key);\nCREATE TABLE bad (id int references nonexistent(id));\nCOMMIT;\n',
    );

    const scratch = await createTestDatabase('rollback', { migrate: false });
    try {
      await expect(migrate(scratch.db, directory)).rejects.toThrow();

      const tables = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `.execute(scratch.db);
      expect(tables.rows.map((row) => row.table_name)).not.toContain('good');

      // Nothing recorded, so the fixed migration applies cleanly next time.
      const recorded = await scratch.db
        .selectFrom('schema_migrations')
        .select('filename')
        .execute();
      expect(recorded).toEqual([]);
    } finally {
      await scratch.destroy();
    }
  }, 60_000);

  it('serialises two concurrent runners so a file is applied once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hd-migrations-'));
    await writeFile(
      join(directory, '0001_concurrent.sql'),
      'BEGIN;\nCREATE TABLE concurrent (id int primary key);\nCOMMIT;\n',
    );

    const scratch = await createTestDatabase('concurrent', { migrate: false });
    try {
      // Two separate connections, as two deploy hooks would be. The advisory
      // lock is session-scoped, which is exactly why the migration connection
      // must not go through Neon's transaction pooler.
      const [first, second] = await Promise.all([
        migrate(scratch.connect(), directory),
        migrate(scratch.connect(), directory),
      ]);

      const appliedBoth = [...first.applied, ...second.applied];
      expect(appliedBoth).toEqual(['0001_concurrent.sql']);
    } finally {
      await scratch.destroy();
    }
  }, 60_000);

  it('lists every expected table after a real migration', async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name
    `.execute(harness.db);
    expect(tables.rows.map((row) => row.table_name)).toEqual([...EXPECTED_TABLES].sort());
  });

  it('leaves the applied migration files readable and unchanged on disk', async () => {
    // A guard against a runner that rewrites what it applies.
    const files = await readMigrations(MIGRATIONS_DIR);
    for (const file of files) {
      const contents = await readFile(join(MIGRATIONS_DIR, file.filename), 'utf8');
      expect(contents).toBe(file.sql);
    }
  });
});

describe('connection string safety', () => {
  it('refuses a remote database without TLS', () => {
    expect(() =>
      assertUsableConnectionString({
        connectionString: 'postgres://user:pw@ep-cool-forest-123.eu-central-1.aws.neon.tech/main',
      }),
    ).toThrow(InsecureDatabaseUrlError);
  });

  it('accepts a remote database with sslmode=require or stronger', () => {
    for (const mode of ['require', 'verify-ca', 'verify-full']) {
      expect(() =>
        assertUsableConnectionString({
          connectionString: `postgres://user:pw@ep-cool-forest-123.aws.neon.tech/main?sslmode=${mode}`,
        }),
      ).not.toThrow();
    }
  });

  it('allows a local database without TLS, and only a local one', () => {
    expect(() =>
      assertUsableConnectionString({ connectionString: 'postgres://pgtest@127.0.0.1:5432/hd' }),
    ).not.toThrow();
    expect(() =>
      assertUsableConnectionString({ connectionString: 'postgres://u@localhost:5432/hd' }),
    ).not.toThrow();
  });

  it('refuses a pooled endpoint where session state is required', () => {
    // `FOR UPDATE SKIP LOCKED` and advisory locks silently misbehave through
    // pgBouncer, so the worker and the migration runner assert against it.
    expect(() =>
      assertUsableConnectionString({
        connectionString:
          'postgres://user:pw@ep-cool-forest-123-pooler.aws.neon.tech/main?sslmode=require',
        requireDirectConnection: true,
      }),
    ).toThrow(PooledConnectionNotAllowedError);

    // The same URL is fine for the web app, which needs no session state.
    expect(() =>
      assertUsableConnectionString({
        connectionString:
          'postgres://user:pw@ep-cool-forest-123-pooler.aws.neon.tech/main?sslmode=require',
      }),
    ).not.toThrow();
  });

  it('names the variable to set, because this error appears at deploy time', () => {
    expect(() =>
      assertUsableConnectionString({
        connectionString:
          'postgres://user:pw@ep-cool-forest-123-pooler.aws.neon.tech/main?sslmode=require',
        requireDirectConnection: true,
      }),
    ).toThrow(/DATABASE_URL_DIRECT/);
  });
});
