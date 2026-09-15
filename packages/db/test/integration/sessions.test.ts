/**
 * Sessions and OAuth state, against a real server.
 *
 * Two properties are security-critical and both are about what the database
 * does *not* hold: a leaked dump must not yield a usable session cookie, and an
 * OAuth callback must not be replayable. The second is enforced by
 * `DELETE … RETURNING`, which only Postgres can be trusted to make atomic — so
 * it is tested here, including under two simultaneous callbacks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OAUTH_STATE_TTL_MS,
  SESSION_TTL_MS,
  consumeOauthState,
  createSession,
  destroyAllSessionsForUser,
  destroySession,
  generateToken,
  hashToken,
  resolveSession,
  secretsMatch,
  storeOauthState,
} from '../../src/sessions';
import {
  createTestDatabase,
  describeWithDatabase,
  seedTenant,
  type TestDatabase,
  type Tenant,
} from '../helpers/database';

describe.runIf(describeWithDatabase)('sessions', () => {
  let harness: TestDatabase;
  let tenant: Tenant;

  beforeAll(async () => {
    harness = await createTestDatabase('sessions');
    tenant = await seedTenant(harness.db, 'sessions');
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  it('stores only the hash of the cookie, never the cookie', async () => {
    const { token } = await createSession(harness.db, { userId: tenant.userId });

    const rows = await harness.db
      .selectFrom('sessions')
      .select(['id', 'user_id'])
      .where('id', '=', hashToken(token))
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id.equals(hashToken(token))).toBe(true);
    // The plaintext token must appear nowhere in the row. A dump of this table
    // is therefore not a set of live sessions.
    expect(rows[0]?.id.toString('utf8')).not.toContain(token);
    expect(rows[0]?.id).toHaveLength(32);
  });

  it('resolves a live session to its user', async () => {
    const { token } = await createSession(harness.db, { userId: tenant.userId });
    await expect(resolveSession(harness.db, token)).resolves.toEqual({ userId: tenant.userId });
  });

  it('does not resolve an unknown or tampered token', async () => {
    const { token } = await createSession(harness.db, { userId: tenant.userId });
    await expect(resolveSession(harness.db, `${token}x`)).resolves.toBeUndefined();
    await expect(resolveSession(harness.db, generateToken())).resolves.toBeUndefined();
  });

  it('does not resolve a session past its expiry', async () => {
    const { token, expiresAt } = await createSession(harness.db, { userId: tenant.userId });
    const afterExpiry = new Date(expiresAt.getTime() + 1000);
    await expect(resolveSession(harness.db, token, afterExpiry)).resolves.toBeUndefined();
  });

  it('does not resolve a session belonging to a deleted user', async () => {
    // Account deletion must take effect immediately, not when the cookie
    // happens to expire.
    const doomed = await seedTenant(harness.db, 'sessions-doomed');
    const { token } = await createSession(harness.db, { userId: doomed.userId });
    await expect(resolveSession(harness.db, token)).resolves.toEqual({ userId: doomed.userId });

    await harness.db
      .updateTable('users')
      .set({ deleted_at: new Date() })
      .where('id', '=', doomed.userId)
      .execute();

    await expect(resolveSession(harness.db, token)).resolves.toBeUndefined();
  });

  it('does not write on every resolve, only when the expiry has moved enough', async () => {
    const { token } = await createSession(harness.db, { userId: tenant.userId });
    const before = await harness.db
      .selectFrom('sessions')
      .select(['expires_at', 'last_seen_at'])
      .where('id', '=', hashToken(token))
      .executeTakeFirstOrThrow();

    // Early in the session's life: no write, so a busy session does not issue a
    // database write on every single request.
    await resolveSession(harness.db, token);
    const unchanged = await harness.db
      .selectFrom('sessions')
      .select(['expires_at', 'last_seen_at'])
      .where('id', '=', hashToken(token))
      .executeTakeFirstOrThrow();
    expect(unchanged.expires_at.getTime()).toBe(before.expires_at.getTime());
    expect(unchanged.last_seen_at.getTime()).toBe(before.last_seen_at.getTime());

    // Past the halfway point: the sliding expiry is written, so an active user
    // is not signed out mid-use.
    const latish = new Date(before.expires_at.getTime() - SESSION_TTL_MS / 4);
    await resolveSession(harness.db, token, latish);
    const slid = await harness.db
      .selectFrom('sessions')
      .select(['expires_at', 'last_seen_at'])
      .where('id', '=', hashToken(token))
      .executeTakeFirstOrThrow();
    expect(slid.expires_at.getTime()).toBeGreaterThan(before.expires_at.getTime());
    expect(slid.last_seen_at.getTime()).toBe(latish.getTime());
  });

  it('revokes one session without touching the others', async () => {
    const keep = await createSession(harness.db, { userId: tenant.userId });
    const drop = await createSession(harness.db, { userId: tenant.userId });

    await destroySession(harness.db, drop.token);

    await expect(resolveSession(harness.db, drop.token)).resolves.toBeUndefined();
    await expect(resolveSession(harness.db, keep.token)).resolves.toEqual({
      userId: tenant.userId,
    });
  });

  it('revokes every session for a user, and nobody else\'s', async () => {
    const other = await seedTenant(harness.db, 'sessions-other');
    const mine = await createSession(harness.db, { userId: tenant.userId });
    const theirs = await createSession(harness.db, { userId: other.userId });

    await destroyAllSessionsForUser(harness.db, tenant.userId);

    await expect(resolveSession(harness.db, mine.token)).resolves.toBeUndefined();
    await expect(resolveSession(harness.db, theirs.token)).resolves.toEqual({
      userId: other.userId,
    });
  });

  it('stores at most a coarse IP prefix, and accepts none at all', async () => {
    const { token } = await createSession(harness.db, {
      userId: tenant.userId,
      ipPrefix: '203.0.113',
    });
    const row = await harness.db
      .selectFrom('sessions')
      .select('created_ip_prefix')
      .where('id', '=', hashToken(token))
      .executeTakeFirstOrThrow();
    expect(row.created_ip_prefix).toBe('203.0.113');

    const anonymous = await createSession(harness.db, { userId: tenant.userId });
    const anonymousRow = await harness.db
      .selectFrom('sessions')
      .select('created_ip_prefix')
      .where('id', '=', hashToken(anonymous.token))
      .executeTakeFirstOrThrow();
    expect(anonymousRow.created_ip_prefix).toBeNull();
  });

  it('removes sessions when the user row is deleted', async () => {
    const doomed = await seedTenant(harness.db, 'sessions-cascade');
    await createSession(harness.db, { userId: doomed.userId });
    await harness.db.deleteFrom('users').where('id', '=', doomed.userId).execute();

    const orphans = await harness.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', doomed.userId)
      .execute();
    expect(orphans).toHaveLength(0);
  });
});

describe.runIf(describeWithDatabase)('oauth state', () => {
  let harness: TestDatabase;
  let tenant: Tenant;

  beforeAll(async () => {
    harness = await createTestDatabase('oauth');
    tenant = await seedTenant(harness.db, 'oauth');
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  it('round-trips the encrypted verifier and the key id', async () => {
    const ciphertext = Buffer.from('pretend-envelope-ciphertext');
    const { state } = await storeOauthState(harness.db, {
      encryptedCodeVerifier: ciphertext,
      encryptionKeyId: 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/3',
      redirectPath: '/dashboard',
      userId: tenant.userId,
    });

    const consumed = await consumeOauthState(harness.db, state);
    expect(consumed?.encryptedCodeVerifier.equals(ciphertext)).toBe(true);
    // The key version travels with the ciphertext, which is what makes rotation
    // possible without re-reading every row.
    expect(consumed?.encryptionKeyId).toContain('cryptoKeyVersions/3');
    expect(consumed?.redirectPath).toBe('/dashboard');
    expect(consumed?.userId).toBe(tenant.userId);
  });

  it('stores only the hash of the state parameter', async () => {
    const { state } = await storeOauthState(harness.db, {
      encryptedCodeVerifier: Buffer.alloc(8, 1),
      encryptionKeyId: 'k/1',
    });
    const rows = await harness.db.selectFrom('oauth_states').select('state_hash').execute();
    expect(rows.some((row) => row.state_hash.equals(hashToken(state)))).toBe(true);
    expect(rows.every((row) => row.state_hash.toString('utf8') !== state)).toBe(true);
    await consumeOauthState(harness.db, state);
  });

  it('is single use, so a replayed callback finds nothing', async () => {
    const { state } = await storeOauthState(harness.db, {
      encryptedCodeVerifier: Buffer.alloc(8, 2),
      encryptionKeyId: 'k/1',
    });

    await expect(consumeOauthState(harness.db, state)).resolves.toBeDefined();
    // The replay. An intercepted authorisation code is worthless without the
    // PKCE verifier, and the verifier is gone.
    await expect(consumeOauthState(harness.db, state)).resolves.toBeUndefined();
  });

  it('is claimed by exactly one of two simultaneous callbacks', async () => {
    // The race that matters: two concurrent redemptions of the same state, on
    // separate connections. `DELETE … RETURNING` is atomic, so exactly one wins.
    const { state } = await storeOauthState(harness.db, {
      encryptedCodeVerifier: Buffer.alloc(8, 3),
      encryptionKeyId: 'k/1',
    });

    const first = harness.connect();
    const second = harness.connect();
    const results = await Promise.all([
      consumeOauthState(first, state),
      consumeOauthState(second, state),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses an expired state, and still consumes the row', async () => {
    const { state, expiresAt } = await storeOauthState(harness.db, {
      encryptedCodeVerifier: Buffer.alloc(8, 4),
      encryptionKeyId: 'k/1',
    });
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(OAUTH_STATE_TTL_MS);

    const consumed = await consumeOauthState(
      harness.db,
      state,
      new Date(expiresAt.getTime() + 1000),
    );
    expect(consumed).toBeUndefined();

    // Deleted regardless: an expired state is never usable, so leaving the row
    // behind would only accumulate ciphertext.
    const remaining = await harness.db
      .selectFrom('oauth_states')
      .select('state_hash')
      .where('state_hash', '=', hashToken(state))
      .execute();
    expect(remaining).toHaveLength(0);
  });

  it('allows a sign-in flow with no user attached yet', async () => {
    const { state } = await storeOauthState(harness.db, {
      encryptedCodeVerifier: Buffer.alloc(8, 5),
      encryptionKeyId: 'k/1',
    });
    const consumed = await consumeOauthState(harness.db, state);
    expect(consumed?.userId).toBeNull();
    expect(consumed?.redirectPath).toBeNull();
  });
});

describe('token helpers', () => {
  it('generates URL-safe tokens with no padding', () => {
    for (let index = 0; index < 20; index += 1) {
      const token = generateToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token).not.toContain('=');
      // 32 random bytes: enough that guessing is not a threat model.
      expect(token.length).toBeGreaterThanOrEqual(42);
    }
  });

  it('generates distinct tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(tokens.size).toBe(200);
  });

  it('compares secrets without leaking length-independent timing', () => {
    expect(secretsMatch('abcdef', 'abcdef')).toBe(true);
    expect(secretsMatch('abcdef', 'abcdeg')).toBe(false);
    // Different lengths must return false rather than throwing, which is what
    // `timingSafeEqual` does on mismatched buffers.
    expect(secretsMatch('abc', 'abcdef')).toBe(false);
    expect(secretsMatch('', '')).toBe(true);
  });
});
