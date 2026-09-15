/**
 * An end-to-end harness: real Postgres, real crypto, a Google double.
 *
 * Everything except Google is the production code path. The database is a real
 * PostgreSQL 16 instance with the real migrations applied, the encryption is
 * real AES-256-GCM under a real (local) key manager, and the OAuth and Calendar
 * calls go through the real client to a `fetch` implementation that behaves
 * like Google.
 *
 * That combination is deliberate. The interesting failures in this system are
 * at the seams — a constraint that rejects a write, a token that cannot be
 * decrypted for the row it is in, a 409 treated as fatal — and a test that
 * mocked the database or the encryption would not see any of them.
 */
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { createDb, migrate, type Database } from '@hebrew-dates/db';
import { LocalKeyManager } from '@hebrew-dates/crypto';
import { GoogleCalendarClient, type OAuthConfig } from '@hebrew-dates/google-client';
import { buildContext, type ServiceContext } from '../../src/context';
import { FakeGoogle } from './fake-google';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', '..', '..', '..', 'db', 'migrations');

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasDatabase = Boolean(TEST_DATABASE_URL);

export interface Harness {
  db: Kysely<Database>;
  google: FakeGoogle;
  context: ServiceContext;
  oauth: OAuthConfig;
  /** Advance the injected clock. Nothing in the service reads the real one. */
  advance(milliseconds: number): void;
  setNow(date: Date): void;
  now(): Date;
  destroy(): Promise<void>;
}

export async function createHarness(
  label: string,
  options: { now?: Date } = {},
): Promise<Harness> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');

  const name = `hd_svc_${label}_${randomBytes(4).toString('hex')}`;
  const admin = createDb({ connectionString: TEST_DATABASE_URL, allowInsecure: true });
  try {
    await sql.raw(`CREATE DATABASE "${name}"`).execute(admin);
  } finally {
    await admin.destroy();
  }

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const connectionString = url.toString();

  const db = createDb({ connectionString, allowInsecure: true });
  await migrate(db, MIGRATIONS_DIR);

  let currentNow = options.now ?? new Date('2026-04-01T12:00:00Z');
  const google = new FakeGoogle({ now: () => currentNow.getTime() });

  const oauth: OAuthConfig = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    redirectUri: google.redirectUri,
    fetch: google.fetch,
  };

  const context = buildContext({
    db,
    // A real key manager doing real AES-256-GCM. Not a stub: the tests that
    // move a ciphertext between rows depend on the AAD actually being checked.
    keys: LocalKeyManager.ephemeral(),
    oauth,
    appUrl: 'https://hebrewdates.test',
    now: () => currentNow,
    calendarClient: (accessToken) =>
      new GoogleCalendarClient({
        accessToken,
        fetch: google.fetch,
        // No real sleeping in tests; retry behaviour itself is covered in
        // packages/google-client.
        sleep: async () => {},
      }),
  });

  return {
    db,
    google,
    context,
    oauth,
    advance(milliseconds) {
      currentNow = new Date(currentNow.getTime() + milliseconds);
    },
    setNow(date) {
      currentNow = date;
    },
    now() {
      return currentNow;
    },
    async destroy() {
      await db.destroy();
      const cleanup = createDb({ connectionString: TEST_DATABASE_URL, allowInsecure: true });
      try {
        await sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).execute(cleanup);
      } finally {
        await cleanup.destroy();
      }
    },
  };
}

/** Jerusalem, with elevation — the seed location the engine ships. */
export const JERUSALEM = {
  id: 'jerusalem',
  displayName: 'Jerusalem, Israel',
  countryCode: 'IL',
  latitude: 31.7781,
  longitude: 35.2352,
  timezoneId: 'Asia/Jerusalem',
  elevationMeters: 754,
  useElevation: true,
} as const;

/** Brooklyn, for the family case: one dataset, two cities. */
export const BROOKLYN = {
  id: 'brooklyn',
  displayName: 'Brooklyn, United States',
  countryCode: 'US',
  latitude: 40.6782,
  longitude: -73.9442,
  timezoneId: 'America/New_York',
  elevationMeters: 10,
  useElevation: true,
} as const;
