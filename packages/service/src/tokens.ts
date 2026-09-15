/**
 * Getting a usable access token.
 *
 * Access tokens are never persisted. They last an hour, and storing them would
 * multiply the number of places a live credential exists for no benefit — the
 * refresh token can always mint another. So every request that touches Google
 * refreshes, holds the token in memory for the duration, and drops it.
 *
 * The in-process cache is per-instance and short-lived on purpose. A single
 * sync run makes dozens of calendar calls, and refreshing for each would be
 * both slow and a good way to hit Google's token endpoint limits. It is *not* a
 * durable store: a new serverless invocation starts cold, which is correct.
 *
 * When a refresh fails with `invalid_grant` the account is marked
 * `needs_reauth` immediately. That is the difference between a dashboard that
 * says "reconnect your Google account" and one that shows a growing pile of
 * retry failures for something no retry can fix.
 */
import type { GoogleAccountRow } from '@hebrew-dates/db';
import { recordAudit } from '@hebrew-dates/db';
import { open, openText, needsRewrap, rewrap } from '@hebrew-dates/crypto';
import { checkScopes, refreshAccessToken, requiresReauth } from '@hebrew-dates/google-client';
import { SECRET_PURPOSE, type ServiceContext } from './context';

export class NoGoogleAccountError extends Error {
  constructor() {
    super('No Google account is connected.');
  }
}

export class ReauthRequiredError extends Error {
  constructor(message = 'Your Google connection has expired. Please reconnect.') {
    super(message);
  }
}

/** Refresh a little before expiry rather than at it. */
const REFRESH_MARGIN_MS = 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Process-local cache, keyed by google_accounts.id.
 *
 * Module-level state, which is usually a smell — but here it is exactly right:
 * a serverless instance handling one sync run should reuse its token, and the
 * cache dying with the instance is the desired lifetime.
 */
const tokenCache = new Map<string, CachedToken>();

/** Exposed so tests can assert cold-start behaviour. */
export function clearTokenCache(): void {
  tokenCache.clear();
}

export interface LiveToken {
  accessToken: string;
  googleAccountId: string;
  expiresAt: Date;
  /** True when this call went to Google rather than using the cache. */
  refreshed: boolean;
}

/** Read and decrypt a stored refresh token. */
export async function readRefreshToken(
  context: ServiceContext,
  googleAccountId: string,
  userId: string,
): Promise<string> {
  const row = await context.db
    .selectFrom('google_accounts')
    .select(['encrypted_refresh_token', 'encryption_key_id'])
    .where('id', '=', googleAccountId)
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow(() => new NoGoogleAccountError());

  return openText(
    context.keys,
    { ciphertext: row.encrypted_refresh_token, keyId: row.encryption_key_id },
    // Bound to the user. A ciphertext moved to another user's row will not open.
    { purpose: SECRET_PURPOSE.refreshToken, subject: userId },
  );
}

/**
 * Get a live access token for a user's Google account.
 *
 * Also performs lazy key rotation: if the stored ciphertext was sealed under a
 * key version that is no longer primary, it is re-wrapped here. Doing it on the
 * read path means rotation completes as accounts are used, with no batch job
 * and no window where a record is unreadable.
 */
export async function liveAccessToken(
  context: ServiceContext,
  userId: string,
): Promise<LiveToken> {
  const account = await context.db
    .selectFrom('google_accounts')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!account) throw new NoGoogleAccountError();

  return liveAccessTokenForAccount(context, account);
}

export async function liveAccessTokenForAccount(
  context: ServiceContext,
  account: GoogleAccountRow,
): Promise<LiveToken> {
  if (account.connection_status !== 'connected') {
    throw new ReauthRequiredError(
      account.connection_status === 'revoked'
        ? 'Access to your Google Calendar was revoked. Please reconnect.'
        : 'Your Google connection needs to be renewed. Please reconnect.',
    );
  }

  const nowMs = context.now().getTime();
  const cached = tokenCache.get(account.id);
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > nowMs) {
    return {
      accessToken: cached.accessToken,
      googleAccountId: account.id,
      expiresAt: new Date(cached.expiresAtMs),
      refreshed: false,
    };
  }

  const sealed = {
    ciphertext: account.encrypted_refresh_token,
    keyId: account.encryption_key_id,
  };
  const secretContext = { purpose: SECRET_PURPOSE.refreshToken, subject: account.user_id };

  const refreshTokenBuffer = await open(context.keys, sealed, secretContext);
  let refreshToken: string;
  try {
    refreshToken = refreshTokenBuffer.toString('utf8');
  } finally {
    refreshTokenBuffer.fill(0);
  }

  let tokens;
  try {
    tokens = await refreshAccessToken(context.oauth, { refreshToken, now: context.now() });
  } catch (error) {
    if (requiresReauth(error)) {
      // The grant is gone. Retrying cannot help, so say so once and stop.
      await markNeedsReauth(context, account, error);
      throw new ReauthRequiredError();
    }
    throw error;
  }

  // Google does not re-issue the refresh token here, so the stored one stands.
  // What can change is the granted scope set, if the user edited permissions in
  // their Google account — so it is recorded rather than assumed unchanged.
  const scopeUpdate =
    tokens.grantedScopes && tokens.grantedScopes !== account.granted_scopes
      ? { granted_scopes: tokens.grantedScopes }
      : {};

  await context.db
    .updateTable('google_accounts')
    .set({
      access_token_expires_at: tokens.expiresAt,
      last_error: null,
      updated_at: context.now(),
      ...scopeUpdate,
    })
    .where('id', '=', account.id)
    .execute();

  await rewrapIfStale(context, account);

  tokenCache.set(account.id, {
    accessToken: tokens.accessToken,
    expiresAtMs: tokens.expiresAt.getTime(),
  });

  return {
    accessToken: tokens.accessToken,
    googleAccountId: account.id,
    expiresAt: tokens.expiresAt,
    refreshed: true,
  };
}

/**
 * Re-wrap a stored token under the current key version.
 *
 * Best effort: a KMS hiccup must not fail a sync. The record stays readable
 * under its old version either way, so the only cost of skipping is that it
 * gets re-wrapped on the next use.
 */
async function rewrapIfStale(
  context: ServiceContext,
  account: GoogleAccountRow,
): Promise<boolean> {
  try {
    const sealed = {
      ciphertext: account.encrypted_refresh_token,
      keyId: account.encryption_key_id,
    };
    if (!(await needsRewrap(context.keys, sealed))) return false;

    const rotated = await rewrap(context.keys, sealed, {
      purpose: SECRET_PURPOSE.refreshToken,
      subject: account.user_id,
    });
    await context.db
      .updateTable('google_accounts')
      .set({
        encrypted_refresh_token: rotated.ciphertext,
        encryption_key_id: rotated.keyId,
        updated_at: context.now(),
      })
      .where('id', '=', account.id)
      // Only if nobody else re-wrapped it first, so two concurrent syncs do not
      // fight over the row.
      .where('encryption_key_id', '=', account.encryption_key_id)
      .execute();
    return true;
  } catch {
    return false;
  }
}

async function markNeedsReauth(
  context: ServiceContext,
  account: GoogleAccountRow,
  error: unknown,
): Promise<void> {
  tokenCache.delete(account.id);
  const message = error instanceof Error ? error.message : String(error);
  await context.db
    .updateTable('google_accounts')
    .set({
      connection_status: 'needs_reauth',
      last_error: message.slice(0, 500),
      updated_at: context.now(),
    })
    .where('id', '=', account.id)
    .execute();

  // Every destination fed by this account stops rather than accumulating
  // retries against a grant that will never work again.
  await context.db
    .updateTable('destination_events')
    .set({ sync_status: 'disconnected', updated_at: context.now() })
    .where('destination_calendar_id', 'in', (eb) =>
      eb
        .selectFrom('google_calendar_connections')
        .select('destination_calendar_id')
        .where('google_account_id', '=', account.id),
    )
    .where('sync_status', 'in', ['pending', 'retry_scheduled', 'updating', 'deleting'])
    .execute();

  await recordAudit(context.db, {
    actorUserId: null,
    action: 'google.needs_reauth',
    subjectType: 'google_account',
    subjectId: account.id,
    detail: { reason: message.slice(0, 200) },
  });
}

/** Whether the stored grant still covers what the product needs. */
export async function connectionHealth(
  context: ServiceContext,
  userId: string,
): Promise<{
  connected: boolean;
  status: 'connected' | 'needs_reauth' | 'revoked' | 'not_connected';
  scopeSufficient: boolean;
  lastError: string | null;
  email: string | null;
}> {
  const account = await context.db
    .selectFrom('google_accounts')
    .select(['connection_status', 'granted_scopes', 'last_error', 'email'])
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (!account) {
    return {
      connected: false,
      status: 'not_connected',
      scopeSufficient: false,
      lastError: null,
      email: null,
    };
  }

  return {
    connected: account.connection_status === 'connected',
    status: account.connection_status,
    scopeSufficient: checkScopes(account.granted_scopes).sufficient,
    lastError: account.last_error,
    email: account.email,
  };
}
