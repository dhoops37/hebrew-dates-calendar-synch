/**
 * Sessions and OAuth state.
 *
 * Two hashing decisions worth stating:
 *
 *  - The **session cookie value is never stored.** The table holds its sha256,
 *    so a leaked database does not hand over live sessions.
 *  - The **OAuth `state` is stored as a hash** for the same reason, and the PKCE
 *    verifier beside it is encrypted, because for the ~10 minutes the flow is
 *    open it is a bearer secret.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from './schema';

/** Sessions last two weeks, refreshed on use. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** An OAuth round trip that takes longer than this has been abandoned. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function generateToken(bytes = 32): string {
  // base64url: URL- and cookie-safe with no escaping.
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export interface CreatedSession {
  /** Give this to the client once. It is not recoverable afterwards. */
  token: string;
  expiresAt: Date;
}

export async function createSession(
  db: Kysely<Database>,
  params: { userId: string; ipPrefix?: string | null; now?: Date },
): Promise<CreatedSession> {
  const now = params.now ?? new Date();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db
    .insertInto('sessions')
    .values({
      id: hashToken(token),
      user_id: params.userId,
      expires_at: expiresAt,
      created_ip_prefix: params.ipPrefix ?? null,
    })
    .execute();
  return { token, expiresAt };
}

export async function resolveSession(
  db: Kysely<Database>,
  token: string,
  now = new Date(),
): Promise<{ userId: string } | undefined> {
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select(['sessions.user_id as user_id', 'sessions.expires_at as expires_at'])
    .where('sessions.id', '=', hashToken(token))
    .where('users.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) return undefined;
  if (row.expires_at.getTime() <= now.getTime()) return undefined;

  // Sliding expiry, written only when it has moved enough to matter, so a busy
  // session does not issue a write on every request.
  const remaining = row.expires_at.getTime() - now.getTime();
  if (remaining < SESSION_TTL_MS / 2) {
    await db
      .updateTable('sessions')
      .set({ expires_at: new Date(now.getTime() + SESSION_TTL_MS), last_seen_at: now })
      .where('id', '=', hashToken(token))
      .execute();
  }
  return { userId: row.user_id };
}

export async function destroySession(db: Kysely<Database>, token: string): Promise<void> {
  await db.deleteFrom('sessions').where('id', '=', hashToken(token)).execute();
}

export async function destroyAllSessionsForUser(
  db: Kysely<Database>,
  userId: string,
): Promise<void> {
  await db.deleteFrom('sessions').where('user_id', '=', userId).execute();
}

export interface StoredOauthState {
  state: string;
  expiresAt: Date;
}

export async function storeOauthState(
  db: Kysely<Database>,
  params: {
    encryptedCodeVerifier: Buffer;
    encryptionKeyId: string;
    redirectPath?: string | null;
    userId?: string | null;
    now?: Date;
  },
): Promise<StoredOauthState> {
  const now = params.now ?? new Date();
  const state = generateToken();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS);
  await db
    .insertInto('oauth_states')
    .values({
      state_hash: hashToken(state),
      encrypted_code_verifier: params.encryptedCodeVerifier,
      encryption_key_id: params.encryptionKeyId,
      redirect_path: params.redirectPath ?? null,
      user_id: params.userId ?? null,
      expires_at: expiresAt,
    })
    .execute();
  return { state, expiresAt };
}

/**
 * Consume an OAuth state exactly once.
 *
 * The DELETE … RETURNING is the single-use guarantee: a replayed callback finds
 * nothing, so an intercepted authorisation code cannot be redeemed twice.
 */
export async function consumeOauthState(
  db: Kysely<Database>,
  state: string,
  now = new Date(),
): Promise<
  | {
      encryptedCodeVerifier: Buffer;
      encryptionKeyId: string;
      redirectPath: string | null;
      userId: string | null;
    }
  | undefined
> {
  const row = await db
    .deleteFrom('oauth_states')
    .where('state_hash', '=', hashToken(state))
    .returning([
      'encrypted_code_verifier',
      'encryption_key_id',
      'redirect_path',
      'user_id',
      'expires_at',
    ])
    .executeTakeFirst();
  if (!row) return undefined;
  if (row.expires_at.getTime() <= now.getTime()) return undefined;
  return {
    encryptedCodeVerifier: row.encrypted_code_verifier,
    encryptionKeyId: row.encryption_key_id,
    redirectPath: row.redirect_path,
    userId: row.user_id,
  };
}

/** Constant-time compare, for anywhere a secret is checked outside the database. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
