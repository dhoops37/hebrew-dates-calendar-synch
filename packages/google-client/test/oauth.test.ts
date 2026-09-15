/**
 * The OAuth flow, end to end against a faithful Google double.
 *
 * The assertions concentrate on the failures that are silent in production:
 * a connect that yields no refresh token and therefore stops working an hour
 * later, a PKCE verifier that is not actually checked, and an ID token accepted
 * for the wrong client.
 */
import { describe, expect, it } from 'vitest';
import {
  GoogleApiError,
  GoogleTransportError,
  IdTokenError,
  MissingRefreshTokenError,
  OAuthConfigError,
  REQUESTED_SCOPES,
  SCOPE_CALENDAR_APP_CREATED,
  assertOAuthConfig,
  assertRefreshToken,
  buildAuthorizationUrl,
  checkScopes,
  createNonce,
  createPkcePair,
  exchangeCode,
  pkceChallenge,
  readIdentityFromIdToken,
  refreshAccessToken,
  revokeToken,
  type OAuthConfig,
} from '../src/index';
import { FakeGoogle } from './helpers/fake-google';

function setup(overrides: Partial<OAuthConfig> = {}) {
  const google = new FakeGoogle();
  const config: OAuthConfig = {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    redirectUri: google.redirectUri,
    fetch: google.fetch,
    ...overrides,
  };
  return { google, config };
}

/** Walk the whole flow the way the application will. */
async function connect(options: { forceConsent?: boolean } = {}) {
  const { google, config } = setup();
  const pkce = createPkcePair();
  const nonce = createNonce();
  const url = buildAuthorizationUrl(config, {
    state: 'state-value',
    codeChallenge: pkce.challenge,
    nonce,
    ...(options.forceConsent !== undefined ? { forceConsent: options.forceConsent } : {}),
  });
  const code = google.authorize(url);
  const tokens = await exchangeCode(config, { code, codeVerifier: pkce.verifier });
  return { google, config, pkce, nonce, tokens };
}

describe('configuration', () => {
  it('names every missing value at once', () => {
    expect(() =>
      assertOAuthConfig({ clientId: '', clientSecret: '', redirectUri: '' }),
    ).toThrow(/clientId, clientSecret, redirectUri/);
  });

  it('names the environment variables to set', () => {
    expect(() =>
      assertOAuthConfig({ clientId: 'a', clientSecret: '', redirectUri: 'https://x.test/cb' }),
    ).toThrow(/GOOGLE_OAUTH_CLIENT_SECRET/);
  });

  it('refuses a plain-http redirect but allows localhost', () => {
    expect(() =>
      assertOAuthConfig({
        clientId: 'a',
        clientSecret: 'b',
        redirectUri: 'http://hebrewdates.test/cb',
      }),
    ).toThrow(OAuthConfigError);
    expect(() =>
      assertOAuthConfig({
        clientId: 'a',
        clientSecret: 'b',
        redirectUri: 'http://localhost:3000/auth/google/callback',
      }),
    ).not.toThrow();
  });
});

describe('PKCE', () => {
  it('produces a verifier in the RFC 7636 length range', () => {
    for (let index = 0; index < 20; index += 1) {
      const { verifier } = createPkcePair();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('derives the challenge as base64url(sha256(verifier))', () => {
    const { verifier, challenge, method } = createPkcePair();
    expect(method).toBe('S256');
    expect(challenge).toBe(pkceChallenge(verifier));
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces a distinct verifier each time', () => {
    const verifiers = new Set(Array.from({ length: 100 }, () => createPkcePair().verifier));
    expect(verifiers.size).toBe(100);
  });
});

describe('the authorization URL', () => {
  it('requests only the scopes this product needs', () => {
    const { config } = setup();
    const url = new URL(
      buildAuthorizationUrl(config, {
        state: 's',
        codeChallenge: 'c',
        nonce: 'n',
      }),
    );
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toEqual([...REQUESTED_SCOPES]);
    // The narrow calendar scope, and no broader one.
    expect(scopes).toContain(SCOPE_CALENDAR_APP_CREATED);
    expect(scopes).not.toContain('https://www.googleapis.com/auth/calendar');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/calendar.events');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/calendar.readonly');
  });

  it('asks for offline access and consent, so a refresh token is issued', () => {
    const { config } = setup();
    const url = new URL(
      buildAuthorizationUrl(config, { state: 's', codeChallenge: 'c', nonce: 'n' }),
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
  });

  it('carries the PKCE challenge, the state and the nonce', () => {
    const { config } = setup();
    const url = new URL(
      buildAuthorizationUrl(config, {
        state: 'opaque-state',
        codeChallenge: 'the-challenge',
        nonce: 'the-nonce',
      }),
    );
    expect(url.searchParams.get('code_challenge')).toBe('the-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('opaque-state');
    expect(url.searchParams.get('nonce')).toBe('the-nonce');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('omits the consent prompt only when explicitly told to', () => {
    const { config } = setup();
    const url = new URL(
      buildAuthorizationUrl(config, {
        state: 's',
        codeChallenge: 'c',
        nonce: 'n',
        forceConsent: false,
      }),
    );
    expect(url.searchParams.get('prompt')).toBeNull();
  });

  it('passes a login hint through without treating it as identity', () => {
    const { config } = setup();
    const url = new URL(
      buildAuthorizationUrl(config, {
        state: 's',
        codeChallenge: 'c',
        nonce: 'n',
        loginHint: 'someone@example.test',
      }),
    );
    expect(url.searchParams.get('login_hint')).toBe('someone@example.test');
  });
});

describe('exchanging the authorization code', () => {
  it('returns an access token, a refresh token and the granted scopes', async () => {
    const { tokens } = await connect();
    expect(tokens.accessToken).toMatch(/^access-/);
    expect(tokens.refreshToken).toMatch(/^1\/\/refresh-/);
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.scopeCheck.sufficient).toBe(true);
    expect(tokens.scopeCheck.granted).toContain(SCOPE_CALENDAR_APP_CREATED);
  });

  it('expires the access token early, so it is never used at the boundary', async () => {
    const { tokens } = await connect();
    const lifetimeMs = tokens.expiresAt.getTime() - Date.now();
    // Google says 3599s; a 60s safety margin is subtracted.
    expect(lifetimeMs).toBeLessThan(3599 * 1000);
    expect(lifetimeMs).toBeGreaterThan(3400 * 1000);
  });

  it('fails if the PKCE verifier does not match', async () => {
    // The point of PKCE: a stolen code cannot be redeemed.
    const { google, config } = setup();
    const pkce = createPkcePair();
    const url = buildAuthorizationUrl(config, {
      state: 's',
      codeChallenge: pkce.challenge,
      nonce: createNonce(),
    });
    const code = google.authorize(url);

    const error = await exchangeCode(config, {
      code,
      codeVerifier: createPkcePair().verifier,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).kind).toBe('auth_required');
    expect((error as GoogleApiError).reason).toBe('invalid_grant');
  });

  it('cannot redeem the same code twice', async () => {
    const { google, config } = setup();
    const pkce = createPkcePair();
    const code = google.authorize(
      buildAuthorizationUrl(config, {
        state: 's',
        codeChallenge: pkce.challenge,
        nonce: createNonce(),
      }),
    );
    await expect(exchangeCode(config, { code, codeVerifier: pkce.verifier })).resolves.toBeDefined();
    await expect(exchangeCode(config, { code, codeVerifier: pkce.verifier })).rejects.toThrow(
      GoogleApiError,
    );
  });

  it('returns no refresh token when consent was not forced', async () => {
    // This is the failure that looks like success. It must be detectable.
    const { tokens } = await connect({ forceConsent: false });
    expect(tokens.refreshToken).toBeUndefined();
    expect(() => assertRefreshToken(tokens)).toThrow(MissingRefreshTokenError);
    expect(() => assertRefreshToken(tokens)).toThrow(/prompt=consent/);
  });

  it('reports a wrong client secret as an auth failure', async () => {
    const { google, config } = setup({ clientSecret: 'wrong-secret' });
    const pkce = createPkcePair();
    const code = google.authorize(
      buildAuthorizationUrl(
        { ...config, clientSecret: google.clientSecret },
        { state: 's', codeChallenge: pkce.challenge, nonce: createNonce() },
      ),
    );
    const error = await exchangeCode(config, { code, codeVerifier: pkce.verifier }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).kind).toBe('auth_required');
  });

  it('wraps a network failure as transient', async () => {
    const { google, config } = setup();
    google.networkFailures.push({ match: /oauth2\.googleapis\.com\/token/ });
    await expect(
      exchangeCode(config, { code: 'x', codeVerifier: 'y' }),
    ).rejects.toThrow(GoogleTransportError);
  });
});

describe('refreshing the access token', () => {
  it('exchanges a refresh token for a new access token', async () => {
    const { config, tokens } = await connect();
    const refreshed = await refreshAccessToken(config, {
      refreshToken: tokens.refreshToken as string,
    });
    expect(refreshed.accessToken).toMatch(/^access-/);
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    // Google does not reissue the refresh token, so the stored one stands.
    expect(refreshed.refreshToken).toBeUndefined();
  });

  it('classifies a revoked grant as needing re-authorisation, not a retry', async () => {
    // The user revoked access from their Google account page. Retrying would
    // fail forever; the account must be marked needs_reauth.
    const { google, config, tokens } = await connect();
    google.revokeGrant(tokens.refreshToken as string);

    const error = await refreshAccessToken(config, {
      refreshToken: tokens.refreshToken as string,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).kind).toBe('auth_required');
    expect((error as GoogleApiError).requiresReauth).toBe(true);
    expect((error as GoogleApiError).retryable).toBe(false);
  });

  it('classifies an unknown refresh token the same way', async () => {
    const { config } = setup();
    const error = await refreshAccessToken(config, {
      refreshToken: 'not-a-real-token',
    }).catch((caught: unknown) => caught);
    expect((error as GoogleApiError).kind).toBe('auth_required');
  });
});

describe('revoking', () => {
  it('revokes a live refresh token', async () => {
    const { config, tokens } = await connect();
    await expect(revokeToken(config, tokens.refreshToken as string)).resolves.toEqual({
      revoked: true,
    });
    await expect(
      refreshAccessToken(config, { refreshToken: tokens.refreshToken as string }),
    ).rejects.toThrow(GoogleApiError);
  });

  it('treats an already-invalid token as revoked', async () => {
    // A disconnect must not fail because the grant was already gone.
    const { config } = setup();
    await expect(revokeToken(config, 'already-gone')).resolves.toEqual({ revoked: true });
  });

  it('propagates a real server failure', async () => {
    const { google, config } = setup();
    google.failures.push({ match: /revoke/, status: 503 });
    await expect(revokeToken(config, 'x')).rejects.toThrow(GoogleApiError);
  });
});

describe('the ID token', () => {
  it('yields the subject and email from a real flow', async () => {
    const { config, nonce, tokens } = await connect();
    const identity = readIdentityFromIdToken(tokens.idToken as string, {
      clientId: config.clientId,
      expectedNonce: nonce,
    });
    expect(identity.subject).toBe('google-subject-1');
    expect(identity.email).toBe('google-subject-1@example.test');
    expect(identity.emailVerified).toBe(true);
  });

  it('refuses a token minted for a different client', async () => {
    // The realistic cause: GOOGLE_OAUTH_CLIENT_ID differing between the
    // authorization request and the exchange.
    const { google, config } = setup();
    const idToken = google.idToken({
      subject: 'someone',
      audience: 'a-different-client.apps.googleusercontent.com',
    });
    expect(() => readIdentityFromIdToken(idToken, { clientId: config.clientId })).toThrow(
      /different OAuth client/,
    );
  });

  it('refuses a token from a different issuer', () => {
    const { google, config } = setup();
    const idToken = google.idToken({ subject: 's', issuer: 'https://evil.test' });
    expect(() => readIdentityFromIdToken(idToken, { clientId: config.clientId })).toThrow(
      /is not Google/,
    );
  });

  it('accepts both issuer spellings Google uses', () => {
    const { google, config } = setup();
    for (const issuer of ['https://accounts.google.com', 'accounts.google.com']) {
      const idToken = google.idToken({ subject: 's', issuer });
      expect(readIdentityFromIdToken(idToken, { clientId: config.clientId }).subject).toBe('s');
    }
  });

  it('refuses an expired token', () => {
    const { google, config } = setup();
    const idToken = google.idToken({ subject: 's', expiresInSeconds: -3600 });
    expect(() => readIdentityFromIdToken(idToken, { clientId: config.clientId })).toThrow(
      /has expired/,
    );
  });

  it('tolerates a minute of clock skew', () => {
    const { google, config } = setup();
    const idToken = google.idToken({ subject: 's', expiresInSeconds: -30 });
    expect(readIdentityFromIdToken(idToken, { clientId: config.clientId }).subject).toBe('s');
  });

  it('refuses a token issued in the future', () => {
    const { google, config } = setup();
    const idToken = google.idToken({
      subject: 's',
      issuedAtSeconds: Math.floor(Date.now() / 1000) + 600,
    });
    expect(() => readIdentityFromIdToken(idToken, { clientId: config.clientId })).toThrow(
      /server clock/,
    );
  });

  it('refuses a mismatched nonce, so a response cannot be replayed', () => {
    const { google, config } = setup();
    const idToken = google.idToken({ subject: 's', nonce: 'the-real-nonce' });
    expect(() =>
      readIdentityFromIdToken(idToken, {
        clientId: config.clientId,
        expectedNonce: 'a-different-nonce',
      }),
    ).toThrow(/nonce does not match/);
  });

  it('refuses a missing nonce when one was expected', () => {
    const { google, config } = setup();
    const idToken = google.idToken({ subject: 's' });
    expect(() =>
      readIdentityFromIdToken(idToken, { clientId: config.clientId, expectedNonce: 'n' }),
    ).toThrow(IdTokenError);
  });

  it('refuses a malformed token', () => {
    const { config } = setup();
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', 'header.!!!.sig']) {
      expect(() => readIdentityFromIdToken(bad, { clientId: config.clientId })).toThrow(
        IdTokenError,
      );
    }
  });

  it('reads email_verified whether it is a boolean or a string', () => {
    const { google, config } = setup();
    const verified = google.idToken({ subject: 's', emailVerified: true });
    expect(readIdentityFromIdToken(verified, { clientId: config.clientId }).emailVerified).toBe(
      true,
    );

    const unverified = google.idToken({ subject: 's', emailVerified: false });
    expect(readIdentityFromIdToken(unverified, { clientId: config.clientId }).emailVerified).toBe(
      false,
    );
  });
});

describe('scope checking', () => {
  it('accepts a grant that includes the calendar scope', () => {
    const check = checkScopes(
      `openid https://www.googleapis.com/auth/userinfo.email ${SCOPE_CALENDAR_APP_CREATED}`,
    );
    expect(check.sufficient).toBe(true);
    expect(check.missing).toEqual([]);
  });

  it('reports a declined calendar scope, rather than syncing nothing silently', () => {
    // Google's consent screen lets a user untick scopes individually.
    const check = checkScopes('openid https://www.googleapis.com/auth/userinfo.email');
    expect(check.sufficient).toBe(false);
    expect(check.missing).toEqual([SCOPE_CALENDAR_APP_CREATED]);
  });

  it('handles an empty scope string', () => {
    const check = checkScopes('');
    expect(check.granted).toEqual([]);
    expect(check.sufficient).toBe(false);
  });

  it('ignores extra scopes Google adds via include_granted_scopes', () => {
    const check = checkScopes(
      `${SCOPE_CALENDAR_APP_CREATED} https://www.googleapis.com/auth/drive.file`,
    );
    expect(check.sufficient).toBe(true);
  });
});
