/**
 * Sign-in and connecting a Google account.
 *
 * One flow does both, because for this product they are the same act: a user
 * signs in with Google *in order to* have a calendar written to. Splitting them
 * would mean two consent screens for one outcome.
 *
 * The state machine, and where each secret lives:
 *
 *   beginGoogleSignIn
 *     → PKCE verifier sealed with the envelope encryption, stored in
 *       `oauth_states` beside the sha256 of the `state` parameter
 *     → user is redirected to Google
 *
 *   completeGoogleSignIn
 *     → `state` is consumed from the database exactly once (DELETE … RETURNING),
 *       so a replayed callback finds nothing
 *     → verifier is unsealed and used to redeem the code
 *     → ID token claims are validated, including the nonce
 *     → refresh token is sealed and stored; the access token is NOT persisted
 *     → a session cookie value is returned once and never recoverable
 *
 * The `nonce` is carried inside the sealed verifier blob rather than in a
 * separate column: it is only ever needed together with the verifier, and
 * keeping them in one ciphertext means neither can be paired with the wrong
 * half of another request.
 */
import {
  AccessDeniedError,
  authorise,
  createPersonalDataset,
  consumeOauthState,
  createSession,
  destroyAllSessionsForUser,
  generateToken,
  hashToken,
  recordAuditEvent,
  resolveSession,
  seedDefaultReminders,
  storeOauthState,
  upsertUserByEmail,
  type DatasetAccess,
} from '@hebrew-dates/db';
import { open, seal } from '@hebrew-dates/crypto';
import {
  GoogleApiError,
  assertRefreshToken,
  buildAuthorizationUrl,
  createNonce,
  createPkcePair,
  exchangeCode,
  readIdentityFromIdToken,
  revokeToken,
  type ScopeCheck,
} from '@hebrew-dates/google-client';
import { SECRET_PURPOSE, type ServiceContext } from './context';
import { liveAccessToken, readRefreshToken } from './tokens';

export class SignInError extends Error {}
export class InsufficientScopeError extends Error {
  constructor(readonly scopeCheck: ScopeCheck) {
    super(
      'Google did not grant permission to manage calendars. Hebrew Dates needs the ' +
        '"See, create, and edit only the calendars created by this app" permission ' +
        'to add your dates. Please sign in again and leave that box ticked.',
    );
  }
}

/** Where the callback may send a user afterwards. An allow-list, not a filter. */
const ALLOWED_REDIRECT_PATHS = new Set(['/', '/dashboard', '/dates', '/settings', '/setup']);

export function sanitiseRedirectPath(path: string | null | undefined): string {
  if (!path) return '/dashboard';
  // An open redirect here would let a phishing page borrow this domain's
  // trust, so anything not explicitly listed is discarded rather than fixed up.
  return ALLOWED_REDIRECT_PATHS.has(path) ? path : '/dashboard';
}

export interface BeginSignInResult {
  authorizationUrl: string;
  /** Opaque value for the `state` query parameter. Not stored in a cookie. */
  state: string;
  expiresAt: Date;
}

export async function beginGoogleSignIn(
  context: ServiceContext,
  params: { redirectPath?: string; userId?: string; loginHint?: string } = {},
): Promise<BeginSignInResult> {
  const pkce = createPkcePair();
  const nonce = createNonce();

  // The `state` is minted here rather than inside `storeOauthState` because its
  // hash — the row's primary key — is what the sealed verifier is bound to. A
  // ciphertext lifted out of this row and pasted into another therefore fails
  // to decrypt, rather than handing an attacker a usable verifier.
  const state = generateToken();
  const sealed = await seal(context.keys, JSON.stringify({ verifier: pkce.verifier, nonce }), {
    purpose: SECRET_PURPOSE.codeVerifier,
    subject: stateSubject(state),
  });

  const stored = await storeOauthState(context.db, {
    state,
    encryptedCodeVerifier: sealed.ciphertext,
    encryptionKeyId: sealed.keyId,
    redirectPath: sanitiseRedirectPath(params.redirectPath),
    userId: params.userId ?? null,
    now: context.now(),
  });

  return {
    authorizationUrl: buildAuthorizationUrl(context.oauth, {
      state: stored.state,
      codeChallenge: pkce.challenge,
      nonce,
      // Always: a reconnect after revocation also needs a fresh refresh token.
      forceConsent: true,
      ...(params.loginHint ? { loginHint: params.loginHint } : {}),
    }),
    state: stored.state,
    expiresAt: stored.expiresAt,
  };
}

export interface CompleteSignInResult {
  userId: string;
  googleAccountId: string;
  /** Set as a cookie value. Shown to the caller once; not recoverable. */
  sessionToken: string;
  sessionExpiresAt: Date;
  redirectPath: string;
  /** True when this call created the account, so the UI can run setup. */
  isNewUser: boolean;
  datasetId: string;
  destinationCalendarId: string;
  scopeCheck: ScopeCheck;
}

export async function completeGoogleSignIn(
  context: ServiceContext,
  params: { code: string; state: string; ipPrefix?: string | null },
): Promise<CompleteSignInResult> {
  const now = context.now();

  // Single use. A replayed callback gets nothing, so an intercepted code cannot
  // be redeemed twice even if it were still valid.
  const stateRow = await consumeOauthState(context.db, params.state, now);
  if (!stateRow) {
    throw new SignInError(
      'This sign-in link has already been used or has expired. Please start again.',
    );
  }

  const unsealed = await open(
    context.keys,
    { ciphertext: stateRow.encryptedCodeVerifier, keyId: stateRow.encryptionKeyId },
    // Bound to the `state` the caller presented, which is also the row's key.
    // A verifier moved between rows cannot be opened.
    { purpose: SECRET_PURPOSE.codeVerifier, subject: stateSubject(params.state) },
  ).catch(() => {
    throw new SignInError('This sign-in could not be verified. Please start again.');
  });

  let verifier: string;
  let nonce: string;
  try {
    const parsed = JSON.parse(unsealed.toString('utf8')) as { verifier: string; nonce: string };
    verifier = parsed.verifier;
    nonce = parsed.nonce;
  } finally {
    unsealed.fill(0);
  }

  const tokens = await exchangeCode(context.oauth, {
    code: params.code,
    codeVerifier: verifier,
    now,
  });

  if (!tokens.idToken) {
    throw new SignInError('Google did not return an identity token; cannot sign in.');
  }
  const identity = readIdentityFromIdToken(tokens.idToken, {
    clientId: context.oauth.clientId,
    expectedNonce: nonce,
    now,
  });

  if (!identity.email || !identity.emailVerified) {
    // An unverified email would let someone claim an account by controlling a
    // Google account with an address they do not own.
    throw new SignInError(
      'Your Google account has no verified email address, so an account cannot be created.',
    );
  }

  // Store the grant even when the calendar scope was declined, so the dashboard
  // can say what is wrong rather than looping the user through consent blindly.
  const refreshToken = assertRefreshToken(tokens);

  const user = await upsertUserByEmail(context.db, {
    email: identity.email,
    displayName: identity.email.split('@')[0] ?? null,
  });

  const sealedRefresh = await seal(context.keys, refreshToken, {
    purpose: SECRET_PURPOSE.refreshToken,
    subject: user.id,
  });

  const account = await context.db
    .insertInto('google_accounts')
    .values({
      user_id: user.id,
      google_subject: identity.subject,
      email: identity.email,
      encrypted_refresh_token: sealedRefresh.ciphertext,
      encryption_key_id: sealedRefresh.keyId,
      access_token_expires_at: tokens.expiresAt,
      granted_scopes: tokens.grantedScopes,
      connection_status: 'connected',
      last_error: null,
    })
    .onConflict((oc) =>
      // Reconnecting replaces the stored token rather than adding a second row,
      // and clears the previous error so the dashboard stops showing it.
      oc.columns(['user_id', 'google_subject']).doUpdateSet({
        encrypted_refresh_token: sealedRefresh.ciphertext,
        encryption_key_id: sealedRefresh.keyId,
        access_token_expires_at: tokens.expiresAt,
        granted_scopes: tokens.grantedScopes,
        connection_status: 'connected',
        last_error: null,
        email: identity.email,
        updated_at: now,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();

  // A returning user keeps their dataset; a new one gets the whole structure.
  const existing = await context.db
    .selectFrom('datasets')
    .innerJoin('owner_members', 'owner_members.owner_id', 'datasets.owner_id')
    .innerJoin('destination_calendars', 'destination_calendars.dataset_id', 'datasets.id')
    .select(['datasets.id as dataset_id', 'destination_calendars.id as destination_calendar_id'])
    .where('owner_members.user_id', '=', user.id)
    .where('datasets.active', '=', true)
    .orderBy('datasets.created_at')
    .executeTakeFirst();

  let datasetId: string;
  let destinationCalendarId: string;
  if (existing) {
    datasetId = existing.dataset_id;
    destinationCalendarId = existing.destination_calendar_id;
  } else {
    const created = await createPersonalDataset(context.db, {
      userId: user.id,
      ownerName: identity.email,
      datasetName: 'My Hebrew dates',
      calendarName: 'Hebrew Dates',
    });
    datasetId = created.datasetId;
    destinationCalendarId = created.destinationCalendarId;
    await seedDefaultReminders(context.db, created.destinationCalendarId);
  }

  const session = await createSession(context.db, {
    userId: user.id,
    ipPrefix: params.ipPrefix ?? null,
    now,
  });

  await recordAuditEvent(
    context.db,
    {
      // Scopes only. Never the token, and never the email's local part.
      action: user.created ? 'account.created' : 'google.reconnected',
      subjectType: 'google_account',
      subjectId: account.id,
      grantedScopes: tokens.grantedScopes,
      scopeSufficient: tokens.scopeCheck.sufficient,
    },
    { actorUserId: user.id, at: now },
  );

  return {
    userId: user.id,
    googleAccountId: account.id,
    sessionToken: session.token,
    sessionExpiresAt: session.expiresAt,
    redirectPath: sanitiseRedirectPath(stateRow.redirectPath),
    isNewUser: user.created,
    datasetId,
    destinationCalendarId,
    scopeCheck: tokens.scopeCheck,
  };
}

/**
 * The encryption subject for an OAuth state row: the hash of its `state`.
 *
 * Using the row's own primary key means the ciphertext can only be opened by
 * someone who already holds the `state` value, and only in the row it was
 * written to.
 */
function stateSubject(state: string): string {
  return hashToken(state).toString('hex');
}

/* ------------------------------------------------------------- sessions -- */

export interface CurrentUser {
  userId: string;
  email: string;
  datasetId: string;
  destinationCalendarId: string;
  access: DatasetAccess;
}

/**
 * Resolve a session cookie to a user and their dataset access.
 *
 * Returns undefined rather than throwing for an absent or expired session,
 * because "not signed in" is an ordinary state on every page.
 */
export async function currentUser(
  context: ServiceContext,
  sessionToken: string | undefined,
): Promise<CurrentUser | undefined> {
  if (!sessionToken) return undefined;
  const session = await resolveSession(context.db, sessionToken, context.now());
  if (!session) return undefined;

  const row = await context.db
    .selectFrom('users')
    .innerJoin('owner_members', 'owner_members.user_id', 'users.id')
    .innerJoin('datasets', 'datasets.owner_id', 'owner_members.owner_id')
    .innerJoin('destination_calendars', 'destination_calendars.dataset_id', 'datasets.id')
    .select([
      'users.id as user_id',
      'users.email as email',
      'datasets.id as dataset_id',
      'destination_calendars.id as destination_calendar_id',
    ])
    .where('users.id', '=', session.userId)
    .where('users.deleted_at', 'is', null)
    .where('datasets.active', '=', true)
    .orderBy('datasets.created_at')
    .executeTakeFirst();
  if (!row) return undefined;

  const access = await authorise(context.db, {
    datasetId: row.dataset_id,
    userId: row.user_id,
    minimumRole: 'viewer',
  });

  return {
    userId: row.user_id,
    email: row.email,
    datasetId: row.dataset_id,
    destinationCalendarId: row.destination_calendar_id,
    access,
  };
}

/** Resolve a session or refuse. For routes that require sign-in. */
export async function requireUser(
  context: ServiceContext,
  sessionToken: string | undefined,
): Promise<CurrentUser> {
  const user = await currentUser(context, sessionToken);
  if (!user) throw new AccessDeniedError('Not signed in');
  return user;
}

/* ----------------------------------------------------------- disconnect -- */

export interface DisconnectResult {
  revokedAtGoogle: boolean;
  calendarDeleted: boolean;
}

/**
 * Disconnect a Google account.
 *
 * Revokes at Google as well as deleting locally: leaving a live grant listed in
 * someone's Google account with nothing using it is both untidy and a standing
 * risk. Optionally deletes the app's calendar, which is one call rather than
 * hundreds of event deletions that could half-finish.
 */
export async function disconnectGoogle(
  context: ServiceContext,
  params: { userId: string; deleteCalendar?: boolean },
): Promise<DisconnectResult> {
  const account = await context.db
    .selectFrom('google_accounts')
    .selectAll()
    .where('user_id', '=', params.userId)
    .executeTakeFirst();
  if (!account) return { revokedAtGoogle: false, calendarDeleted: false };

  let calendarDeleted = false;
  if (params.deleteCalendar) {
    const connection = await context.db
      .selectFrom('google_calendar_connections')
      .selectAll()
      .where('google_account_id', '=', account.id)
      .executeTakeFirst();

    if (connection?.google_calendar_id) {
      // Best effort: a failure here must not stop the disconnect. The user's
      // instruction was to disconnect, and a stranded calendar is recoverable
      // while a stuck grant is not.
      try {
        const { accessToken } = await liveAccessToken(context, params.userId);
        const client = context.calendarClient(accessToken);
        const result = await client.deleteCalendar(connection.google_calendar_id);
        calendarDeleted = result.deleted;
      } catch {
        calendarDeleted = false;
      }
    }
  }

  let revokedAtGoogle = false;
  try {
    const refreshToken = await readRefreshToken(context, account.id, params.userId);
    revokedAtGoogle = (await revokeToken(context.oauth, refreshToken)).revoked;
  } catch (error) {
    // An already-invalid grant is the desired end state.
    revokedAtGoogle = error instanceof GoogleApiError && error.kind === 'auth_required';
  }

  await context.db.deleteFrom('google_accounts').where('id', '=', account.id).execute();
  await destroyAllSessionsForUser(context.db, params.userId);

  await recordAuditEvent(
    context.db,
    {
      action: 'google.disconnected',
      subjectType: 'google_account',
      subjectId: account.id,
      revokedAtGoogle,
      calendarDeleted,
    },
    { actorUserId: params.userId, at: context.now() },
  );

  return { revokedAtGoogle, calendarDeleted };
}
