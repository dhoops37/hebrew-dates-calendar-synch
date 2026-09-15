/**
 * Google OAuth 2.0, authorization-code flow with PKCE.
 *
 * Written against `fetch` rather than `googleapis` on purpose. The surface
 * needed is four endpoints, and the SDK's auth layer hides precisely what this
 * application must control: which scopes are requested, whether a refresh token
 * was actually issued, and how a failure is classified for retry. A 10 MB
 * dependency that obscures those is a poor trade in a serverless function.
 *
 * Security properties, and why each is here:
 *
 *  - **PKCE (S256).** The authorization code is useless without the verifier,
 *    so an intercepted redirect cannot be redeemed. Required for a public
 *    client and worth having for a confidential one.
 *  - **`state` is not handled here.** It is minted and consumed against the
 *    database (`oauth_states`), single-use, with the verifier stored encrypted
 *    beside it. Keeping CSRF state in a cookie would make it forgeable by
 *    anything that can set cookies for the domain.
 *  - **`nonce` in the ID token** binds the identity assertion to this specific
 *    authorization request.
 *  - **`access_type=offline` + `prompt=consent`** on first connect, because
 *    without them Google issues no refresh token and the calendar stops syncing
 *    the moment the access token expires — a failure that appears an hour after
 *    a successful-looking connect.
 *  - **ID token claims are validated, not its signature.** The token arrives in
 *    the response body of a direct server-to-server HTTPS call to Google's own
 *    token endpoint, so its provenance is already established by TLS; Google
 *    documents skipping signature verification in exactly this case. `iss`,
 *    `aud`, `exp` and `nonce` are still checked, because those catch a
 *    misconfigured client ID or a replayed response rather than a forged token.
 *    An ID token received any other way would need full JWKS verification.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { GoogleTransportError, toGoogleApiError } from './errors';
import { REQUESTED_SCOPE_STRING, checkScopes, type ScopeCheck } from './scopes';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;

/** Clock skew tolerated when checking ID token expiry. */
const CLOCK_SKEW_SECONDS = 60;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match a redirect URI registered in the Google Cloud Console exactly. */
  redirectUri: string;
  fetch?: typeof fetch;
}

export class OAuthConfigError extends Error {}
export class IdTokenError extends Error {}
export class MissingRefreshTokenError extends Error {}

export function assertOAuthConfig(config: OAuthConfig): void {
  const missing = (['clientId', 'clientSecret', 'redirectUri'] as const).filter(
    (key) => !config[key],
  );
  if (missing.length > 0) {
    throw new OAuthConfigError(
      `Google OAuth is not configured: missing ${missing.join(', ')}. Set ` +
        'GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI.',
    );
  }
  if (!config.redirectUri.startsWith('https://') && !isLocalhost(config.redirectUri)) {
    // Google itself refuses non-HTTPS redirects except on localhost, but
    // failing here gives a clear message instead of an opaque redirect_uri
    // mismatch at the consent screen.
    throw new OAuthConfigError(
      `GOOGLE_OAUTH_REDIRECT_URI must be https (or http://localhost): got "${config.redirectUri}".`,
    );
  }
}

/* ------------------------------------------------------------------ PKCE -- */

export interface PkcePair {
  /** Kept secret; stored encrypted until the callback. */
  verifier: string;
  /** Sent to Google in the authorization request. */
  challenge: string;
  method: 'S256';
}

export function createPkcePair(): PkcePair {
  // 32 random bytes → 43 base64url characters, within RFC 7636's 43-128 range.
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Random value binding the ID token to this authorization request. */
export function createNonce(): string {
  return randomBytes(16).toString('base64url');
}

/* --------------------------------------------------------- authorize URL -- */

export interface AuthorizationUrlParams {
  state: string;
  codeChallenge: string;
  nonce: string;
  /**
   * Force the consent screen. Needed on a first connect — and on a reconnect
   * after revocation — because Google only returns a refresh token when the
   * user actively consents.
   */
  forceConsent?: boolean;
  /** Pre-fills the account chooser on a reconnect. Never trusted as identity. */
  loginHint?: string;
}

export function buildAuthorizationUrl(
  config: OAuthConfig,
  params: AuthorizationUrlParams,
): string {
  assertOAuthConfig(config);

  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  const query = url.searchParams;
  query.set('client_id', config.clientId);
  query.set('redirect_uri', config.redirectUri);
  query.set('response_type', 'code');
  query.set('scope', REQUESTED_SCOPE_STRING);
  query.set('state', params.state);
  query.set('code_challenge', params.codeChallenge);
  query.set('code_challenge_method', 'S256');
  query.set('nonce', params.nonce);
  // Without offline access there is no refresh token, and sync dies silently an
  // hour after connecting.
  query.set('access_type', 'offline');
  // Ask Google to report every scope it granted, so a partially-declined
  // consent is detectable.
  query.set('include_granted_scopes', 'true');
  if (params.forceConsent !== false) query.set('prompt', 'consent');
  if (params.loginHint) query.set('login_hint', params.loginHint);

  return url.toString();
}

/* -------------------------------------------------------- token exchange -- */

export interface TokenResponse {
  accessToken: string;
  /** Absent on a refresh; required on a first connect. */
  refreshToken: string | undefined;
  expiresAt: Date;
  grantedScopes: string;
  scopeCheck: ScopeCheck;
  idToken: string | undefined;
  tokenType: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  token_type?: string;
}

/** Redeem an authorization code. Requires the PKCE verifier from the request. */
export async function exchangeCode(
  config: OAuthConfig,
  params: { code: string; codeVerifier: string; now?: Date },
): Promise<TokenResponse> {
  assertOAuthConfig(config);
  const body = new URLSearchParams({
    code: params.code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: params.codeVerifier,
  });
  return postToken(config, 'exchange authorization code', body, params.now);
}

/**
 * Exchange a refresh token for an access token.
 *
 * Google does not return a new refresh token here, so the stored one stays as
 * it is. An `invalid_grant` means the user revoked access or the token expired
 * from disuse, and `classify` maps it to `auth_required` so the account is
 * marked `needs_reauth` rather than retried.
 */
export async function refreshAccessToken(
  config: OAuthConfig,
  params: { refreshToken: string; now?: Date },
): Promise<TokenResponse> {
  assertOAuthConfig(config);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: 'refresh_token',
  });
  return postToken(config, 'refresh access token', body, params.now);
}

/**
 * Revoke a token at Google.
 *
 * Called on disconnect. Deleting our row without revoking would leave a live
 * grant listed in the user's Google account with nothing using it, which is
 * both untidy and a small standing risk.
 */
export async function revokeToken(
  config: OAuthConfig,
  token: string,
): Promise<{ revoked: boolean }> {
  const doFetch = config.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch (error) {
    throw new GoogleTransportError('revoke token', error);
  }

  // An already-invalid token returns 400. That is the desired end state, so it
  // is reported as revoked rather than thrown — a disconnect must not fail
  // because the grant was already gone.
  if (response.ok || response.status === 400) return { revoked: true };
  throw await toGoogleApiError('revoke token', response);
}

async function postToken(
  config: OAuthConfig,
  operation: string,
  body: URLSearchParams,
  now: Date | undefined,
): Promise<TokenResponse> {
  const doFetch = config.fetch ?? fetch;

  let response: Response;
  try {
    response = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (error) {
    throw new GoogleTransportError(operation, error);
  }

  if (!response.ok) throw await toGoogleApiError(operation, response);

  const raw = (await response.json().catch(() => {
    throw new GoogleTransportError(operation, new Error('token response was not JSON'));
  })) as RawTokenResponse;

  if (!raw.access_token) {
    throw new GoogleTransportError(
      operation,
      new Error('token response contained no access_token'),
    );
  }

  const issuedAt = now ?? new Date();
  // Default to 1 hour, Google's actual lifetime, and shave 60 seconds so a
  // token is never used in the instant it expires.
  const lifetimeSeconds = raw.expires_in ?? 3600;
  const grantedScopes = raw.scope ?? '';

  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: new Date(issuedAt.getTime() + Math.max(0, lifetimeSeconds - 60) * 1000),
    grantedScopes,
    scopeCheck: checkScopes(grantedScopes),
    idToken: raw.id_token,
    tokenType: raw.token_type ?? 'Bearer',
  };
}

/* -------------------------------------------------------------- identity -- */

export interface GoogleIdentity {
  /** Google's stable subject identifier. The account's real primary key. */
  subject: string;
  email: string | undefined;
  emailVerified: boolean;
  /** Google Workspace domain, when present. */
  hostedDomain: string | undefined;
}

interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  iat?: number;
  email?: string;
  email_verified?: boolean | string;
  nonce?: string;
  hd?: string;
}

/**
 * Validate an ID token's claims and read the identity out of it.
 *
 * See the module comment for why the signature is not verified here. The claims
 * that *are* checked catch the realistic failures: a token minted for a
 * different client ID, an expired one, and a response replayed against a
 * different authorization request.
 */
export function readIdentityFromIdToken(
  idToken: string,
  params: { clientId: string; expectedNonce?: string; now?: Date },
): GoogleIdentity {
  const claims = decodeJwtClaims(idToken);

  if (!claims.iss || !GOOGLE_ISSUERS.includes(claims.iss as (typeof GOOGLE_ISSUERS)[number])) {
    throw new IdTokenError(`ID token issuer "${claims.iss ?? '(none)'}" is not Google.`);
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(params.clientId)) {
    // Almost always a mismatched GOOGLE_OAUTH_CLIENT_ID between the
    // authorization request and the token exchange.
    throw new IdTokenError(
      'ID token was issued for a different OAuth client. Check that ' +
        'GOOGLE_OAUTH_CLIENT_ID matches the client that started the flow.',
    );
  }

  const nowSeconds = Math.floor((params.now ?? new Date()).getTime() / 1000);
  if (claims.exp === undefined || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw new IdTokenError('ID token has expired.');
  }
  if (claims.iat !== undefined && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new IdTokenError('ID token was issued in the future; check the server clock.');
  }

  if (params.expectedNonce !== undefined) {
    if (!claims.nonce || !constantTimeEquals(claims.nonce, params.expectedNonce)) {
      throw new IdTokenError(
        'ID token nonce does not match the authorization request it belongs to.',
      );
    }
  }

  if (!claims.sub) throw new IdTokenError('ID token has no subject.');

  // `email_verified` arrives as a boolean or the string "true" depending on
  // the flow, so both are accepted.
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';

  return {
    subject: claims.sub,
    email: claims.email,
    emailVerified,
    hostedDomain: claims.hd,
  };
}

/** Split a JWT and parse its payload. Does not verify the signature. */
export function decodeJwtClaims(token: string): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new IdTokenError('ID token is not a three-part JWT.');
  }
  try {
    const payload = Buffer.from(parts[1] as string, 'base64url').toString('utf8');
    const claims = JSON.parse(payload) as unknown;
    if (typeof claims !== 'object' || claims === null) {
      throw new IdTokenError('ID token payload is not an object.');
    }
    return claims as IdTokenClaims;
  } catch (error) {
    if (error instanceof IdTokenError) throw error;
    throw new IdTokenError('ID token payload could not be decoded.');
  }
}

/**
 * A first connect must yield a refresh token.
 *
 * Without one the calendar syncs for an hour and then stops, and the user sees
 * a connected account that quietly does nothing — so this is an error at
 * connect time, with the usual cause named.
 */
export function assertRefreshToken(tokens: TokenResponse): string {
  if (!tokens.refreshToken) {
    throw new MissingRefreshTokenError(
      'Google returned no refresh token. This happens when the user has already ' +
        'granted access and the authorization request omitted prompt=consent, or ' +
        'when access_type=offline was not set. Send the user through consent again.',
    );
  }
  return tokens.refreshToken;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isLocalhost(uri: string): boolean {
  try {
    const { hostname } = new URL(uri);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
