/**
 * A stand-in for Google's OAuth and Calendar APIs.
 *
 * Written to be faithful about the behaviours this application depends on,
 * because those are the ones a naive mock gets wrong and a live test cannot
 * reproduce on demand:
 *
 *  - A **refresh token is only issued when `prompt=consent` was sent.** This is
 *    the single most consequential quirk of Google's OAuth: without it a
 *    connect appears to succeed and then stops working an hour later.
 *  - **Event IDs stay reserved after deletion.** Re-inserting a deleted ID
 *    returns 409, so an idempotent create must treat 409 as success.
 *  - **`calendar.app.created` only reaches app-created calendars.** Any other
 *    calendar ID returns 404, not 403 — which is what makes "is it missing or
 *    is it someone else's" indistinguishable, by design.
 *  - **403 covers both quota and permission**, with only `reason` telling them
 *    apart.
 *
 * It is a `fetch` implementation, so the code under test is exercised end to
 * end including URL construction, headers and JSON handling.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface FakeGoogleOptions {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  now?: () => number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
  authorization: string | undefined;
}

interface StoredEvent {
  id: string;
  status: 'confirmed' | 'cancelled';
  summary?: string;
  updated: string;
  extendedProperties?: { private?: Record<string, string> };
  payload: Record<string, unknown>;
}

interface StoredCalendar {
  id: string;
  summary: string;
  description?: string;
  timeZone?: string;
  createdByApp: boolean;
  events: Map<string, StoredEvent>;
  /** IDs that have ever existed here, including deleted ones. */
  usedEventIds: Set<string>;
}

/** A pending authorization, as Google would hold between redirect and callback. */
interface PendingAuthorization {
  code: string;
  codeChallenge: string;
  nonce: string;
  promptedForConsent: boolean;
  scope: string;
}

export class FakeGoogle {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly requests: RecordedRequest[] = [];

  /** Access tokens this instance has issued, and what they may reach. */
  readonly #accessTokens = new Map<string, { subject: string; scope: string; expiresAt: number }>();
  readonly #refreshTokens = new Map<string, { subject: string; scope: string; revoked: boolean }>();
  readonly #calendars = new Map<string, StoredCalendar>();
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #now: () => number;

  /** Queue a failure for the next matching request. */
  failures: { match: RegExp; status: number; reason?: string; times?: number }[] = [];
  /** Force a network-level failure for the next matching request. */
  networkFailures: { match: RegExp; times?: number }[] = [];
  /** Set to make list responses paginate. */
  pageSize: number | undefined;

  constructor(options: FakeGoogleOptions = {}) {
    this.clientId = options.clientId ?? 'test-client-id.apps.googleusercontent.com';
    this.clientSecret = options.clientSecret ?? 'test-client-secret';
    this.redirectUri = options.redirectUri ?? 'https://hebrewdates.test/auth/google/callback';
    this.#now = options.now ?? Date.now;
  }

  /** The `fetch` to inject into the client under test. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const headers = new Headers(init?.headers);

    this.requests.push({
      method,
      url,
      body: parseBody(rawBody, headers.get('content-type')),
      authorization: headers.get('authorization') ?? undefined,
    });

    const networkFailure = this.networkFailures.find((entry) => entry.match.test(url));
    if (networkFailure) {
      this.#consume(this.networkFailures, networkFailure);
      throw new TypeError('fetch failed');
    }

    const failure = this.failures.find((entry) => entry.match.test(url));
    if (failure) {
      this.#consume(this.failures, failure);
      return this.#errorResponse(failure.status, failure.reason);
    }

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return this.#handleToken(rawBody ?? '');
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) {
      return this.#handleRevoke(rawBody ?? '');
    }
    if (url.startsWith('https://www.googleapis.com/calendar/v3/')) {
      return this.#handleCalendar(method, url, parseJson(rawBody), headers);
    }

    return json({ error: 'not_found' }, 404);
  };

  /* --------------------------------------------- driving the OAuth flow -- */

  /**
   * Simulate the user completing the consent screen.
   *
   * Returns the `code` Google would put on the redirect. Reads the challenge
   * and `prompt` straight out of the authorization URL, so a missing
   * `prompt=consent` is reflected in what the token endpoint later returns.
   */
  authorize(authorizationUrl: string, options: { subject?: string } = {}): string {
    const url = new URL(authorizationUrl);
    const challenge = url.searchParams.get('code_challenge');
    const nonce = url.searchParams.get('nonce');
    const scope = url.searchParams.get('scope') ?? '';
    if (!challenge || !nonce) throw new Error('authorization URL lacks PKCE or nonce');
    if (url.searchParams.get('client_id') !== this.clientId) {
      throw new Error('authorization URL has the wrong client_id');
    }
    if (url.searchParams.get('redirect_uri') !== this.redirectUri) {
      throw new Error('authorization URL has the wrong redirect_uri');
    }

    const code = `code-${randomBytes(8).toString('hex')}`;
    this.#pending.set(code, {
      code,
      codeChallenge: challenge,
      nonce,
      // Google issues a refresh token only when the user actually consents.
      promptedForConsent: url.searchParams.get('prompt') === 'consent',
      scope,
    });
    this.#subjectForNextExchange = options.subject ?? 'google-subject-1';
    return code;
  }

  #subjectForNextExchange = 'google-subject-1';

  /** Revoke a grant, as a user would from their Google account page. */
  revokeGrant(refreshToken: string): void {
    const record = this.#refreshTokens.get(refreshToken);
    if (record) record.revoked = true;
  }

  /** Read back a stored calendar, for assertions. */
  calendar(id: string): StoredCalendar | undefined {
    return this.#calendars.get(id);
  }

  /** Every calendar this instance holds. */
  calendarIds(): string[] {
    return [...this.#calendars.keys()];
  }

  /** Pre-register a calendar the app did NOT create, to test scope limits. */
  addForeignCalendar(id: string, summary = "Someone else's calendar"): void {
    this.#calendars.set(id, {
      id,
      summary,
      createdByApp: false,
      events: new Map(),
      usedEventIds: new Set(),
    });
  }

  /** Add an event the app did not create, e.g. one the user added by hand. */
  addUserEvent(calendarId: string, id: string, summary: string): void {
    const calendar = this.#calendars.get(calendarId);
    if (!calendar) throw new Error(`no such calendar ${calendarId}`);
    calendar.events.set(id, {
      id,
      status: 'confirmed',
      summary,
      updated: new Date(this.#now()).toISOString(),
      payload: {},
    });
    calendar.usedEventIds.add(id);
  }

  /* ------------------------------------------------------------ handlers -- */

  #handleToken(rawBody: string): Response {
    const params = new URLSearchParams(rawBody);

    if (params.get('client_id') !== this.clientId) {
      return this.#oauthError(401, 'invalid_client', 'The OAuth client was not found.');
    }
    if (params.get('client_secret') !== this.clientSecret) {
      return this.#oauthError(401, 'invalid_client', 'Unauthorized.');
    }

    const grantType = params.get('grant_type');

    if (grantType === 'authorization_code') {
      const code = params.get('code') ?? '';
      const pending = this.#pending.get(code);
      // Single use, as Google's codes are.
      this.#pending.delete(code);
      if (!pending) {
        return this.#oauthError(400, 'invalid_grant', 'Bad Request');
      }
      if (params.get('redirect_uri') !== this.redirectUri) {
        return this.#oauthError(400, 'redirect_uri_mismatch', 'Bad Request');
      }

      const verifier = params.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== pending.codeChallenge) {
        // The PKCE check. This is what makes an intercepted code useless.
        return this.#oauthError(400, 'invalid_grant', 'code_verifier does not match.');
      }

      const subject = this.#subjectForNextExchange;
      const accessToken = this.#issueAccessToken(subject, pending.scope);
      // The quirk that matters: no consent, no refresh token.
      const refreshToken = pending.promptedForConsent
        ? this.#issueRefreshToken(subject, pending.scope)
        : undefined;

      return json({
        access_token: accessToken,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        expires_in: 3599,
        scope: pending.scope,
        token_type: 'Bearer',
        id_token: this.idToken({ subject, nonce: pending.nonce }),
      });
    }

    if (grantType === 'refresh_token') {
      const refreshToken = params.get('refresh_token') ?? '';
      const record = this.#refreshTokens.get(refreshToken);
      if (!record || record.revoked) {
        // Exactly what Google returns for a revoked or expired grant, and the
        // reason the account must be marked needs_reauth rather than retried.
        return this.#oauthError(400, 'invalid_grant', 'Token has been expired or revoked.');
      }
      return json({
        access_token: this.#issueAccessToken(record.subject, record.scope),
        expires_in: 3599,
        scope: record.scope,
        token_type: 'Bearer',
      });
    }

    return this.#oauthError(400, 'unsupported_grant_type', 'Bad Request');
  }

  #handleRevoke(rawBody: string): Response {
    const token = new URLSearchParams(rawBody).get('token') ?? '';
    const refresh = this.#refreshTokens.get(token);
    if (refresh) {
      refresh.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (this.#accessTokens.delete(token)) return new Response(null, { status: 200 });
    // An unknown token is already in the desired state.
    return this.#oauthError(400, 'invalid_token', 'Token is invalid.');
  }

  #handleCalendar(
    method: string,
    url: string,
    body: Record<string, unknown> | undefined,
    headers: Headers,
  ): Response {
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const token = this.#accessTokens.get(bearer);
    if (!token) {
      return this.#errorResponse(401, 'authError', 'Invalid Credentials');
    }
    if (token.expiresAt <= this.#now()) {
      return this.#errorResponse(401, 'authError', 'Invalid Credentials');
    }
    if (!token.scope.includes('calendar.app.created')) {
      return this.#errorResponse(403, 'insufficientPermissions', 'Insufficient Permission');
    }

    const path = new URL(url).pathname.replace('/calendar/v3/', '');
    const query = new URL(url).searchParams;

    // POST /calendars — create the app's own calendar.
    if (path === 'calendars' && method === 'POST') {
      const id = `hebrew-dates-${randomBytes(6).toString('hex')}@group.calendar.google.com`;
      this.#calendars.set(id, {
        id,
        summary: String(body?.summary ?? ''),
        ...(typeof body?.description === 'string' ? { description: body.description } : {}),
        ...(typeof body?.timeZone === 'string' ? { timeZone: body.timeZone } : {}),
        createdByApp: true,
        events: new Map(),
        usedEventIds: new Set(),
      });
      const created = this.#calendars.get(id) as StoredCalendar;
      return json({ id, summary: created.summary, timeZone: created.timeZone, kind: 'calendar#calendar' });
    }

    const calendarMatch = /^calendars\/([^/]+)(?:\/events(?:\/([^/]+))?)?$/.exec(path);
    if (!calendarMatch) return json({ error: { code: 404, message: 'Not Found' } }, 404);

    const calendarId = decodeURIComponent(calendarMatch[1] as string);
    const eventId = calendarMatch[2] ? decodeURIComponent(calendarMatch[2]) : undefined;
    const calendar = this.#calendars.get(calendarId);

    // Under calendar.app.created, a calendar the app did not create is simply
    // not visible — 404, not 403.
    if (!calendar || !calendar.createdByApp) {
      return this.#errorResponse(404, 'notFound', 'Not Found');
    }

    const isEventsPath = path.includes('/events');

    if (!isEventsPath) {
      if (method === 'GET') {
        return json({ id: calendar.id, summary: calendar.summary, timeZone: calendar.timeZone });
      }
      if (method === 'PATCH') {
        if (typeof body?.summary === 'string') calendar.summary = body.summary;
        if (typeof body?.timeZone === 'string') calendar.timeZone = body.timeZone;
        if (typeof body?.description === 'string') calendar.description = body.description;
        return json({ id: calendar.id, summary: calendar.summary, timeZone: calendar.timeZone });
      }
      if (method === 'DELETE') {
        this.#calendars.delete(calendarId);
        return new Response(null, { status: 204 });
      }
    }

    if (isEventsPath && eventId === undefined) {
      if (method === 'POST') {
        const id = String(body?.id ?? `generated-${randomBytes(6).toString('hex')}`);
        // Deleted IDs stay reserved. This is why an idempotent create must
        // treat 409 as success.
        if (calendar.usedEventIds.has(id)) {
          return this.#errorResponse(409, 'duplicate', 'The requested identifier already exists.');
        }
        calendar.events.set(id, {
          id,
          status: 'confirmed',
          ...(typeof body?.summary === 'string' ? { summary: body.summary } : {}),
          updated: new Date(this.#now()).toISOString(),
          ...(body?.extendedProperties
            ? { extendedProperties: body.extendedProperties as StoredEvent['extendedProperties'] }
            : {}),
          payload: body ?? {},
        });
        calendar.usedEventIds.add(id);
        return json({ id, status: 'confirmed', kind: 'calendar#event' });
      }

      if (method === 'GET') {
        return this.#listEvents(calendar, query);
      }
    }

    if (isEventsPath && eventId !== undefined) {
      const event = calendar.events.get(eventId);
      if (method === 'GET') {
        if (!event || event.status === 'cancelled') {
          return this.#errorResponse(404, 'notFound', 'Not Found');
        }
        return json(serialiseEvent(event));
      }
      if (method === 'PATCH') {
        if (!event) return this.#errorResponse(404, 'notFound', 'Not Found');
        // PATCH merges. A PUT would clear what it omits, which is why the
        // client uses PATCH.
        if (typeof body?.summary === 'string') event.summary = body.summary;
        if (body?.extendedProperties) {
          event.extendedProperties = body.extendedProperties as StoredEvent['extendedProperties'];
        }
        event.payload = { ...event.payload, ...(body ?? {}) };
        event.updated = new Date(this.#now()).toISOString();
        return json(serialiseEvent(event));
      }
      if (method === 'DELETE') {
        if (!event || event.status === 'cancelled') {
          return this.#errorResponse(404, 'notFound', 'Not Found');
        }
        event.status = 'cancelled';
        // The ID stays in usedEventIds: reserved forever.
        return new Response(null, { status: 204 });
      }
    }

    return json({ error: { code: 405, message: 'Method Not Allowed' } }, 405);
  }

  #listEvents(calendar: StoredCalendar, query: URLSearchParams): Response {
    const required = query.getAll('privateExtendedProperty');
    const showDeleted = query.get('showDeleted') !== 'false';

    let events = [...calendar.events.values()];
    if (!showDeleted) events = events.filter((event) => event.status !== 'cancelled');

    if (required.length > 0) {
      events = events.filter((event) =>
        required.every((pair) => {
          const separator = pair.indexOf('=');
          const key = pair.slice(0, separator);
          const value = pair.slice(separator + 1);
          return event.extendedProperties?.private?.[key] === value;
        }),
      );
    }

    const pageSize = this.pageSize ?? Number(query.get('maxResults') ?? 250);
    const pageToken = query.get('pageToken');
    const start = pageToken ? Number(pageToken) : 0;
    const page = events.slice(start, start + pageSize);
    const next = start + pageSize;

    return json({
      items: page.map(serialiseEvent),
      ...(next < events.length ? { nextPageToken: String(next) } : { nextSyncToken: 'sync-token-1' }),
    });
  }

  /* ------------------------------------------------------------- tokens -- */

  #issueAccessToken(subject: string, scope: string): string {
    const token = `access-${randomBytes(12).toString('hex')}`;
    this.#accessTokens.set(token, {
      subject,
      scope,
      expiresAt: this.#now() + 3600 * 1000,
    });
    return token;
  }

  #issueRefreshToken(subject: string, scope: string): string {
    const token = `1//refresh-${randomBytes(12).toString('hex')}`;
    this.#refreshTokens.set(token, { subject, scope, revoked: false });
    return token;
  }

  /** Mint an unsigned ID token, as the token endpoint would return. */
  idToken(params: {
    subject: string;
    nonce?: string;
    audience?: string;
    issuer?: string;
    email?: string;
    emailVerified?: boolean;
    expiresInSeconds?: number;
    issuedAtSeconds?: number;
  }): string {
    const nowSeconds = Math.floor(this.#now() / 1000);
    const claims = {
      iss: params.issuer ?? 'https://accounts.google.com',
      aud: params.audience ?? this.clientId,
      sub: params.subject,
      email: params.email ?? `${params.subject}@example.test`,
      email_verified: params.emailVerified ?? true,
      iat: params.issuedAtSeconds ?? nowSeconds,
      exp: nowSeconds + (params.expiresInSeconds ?? 3600),
      ...(params.nonce !== undefined ? { nonce: params.nonce } : {}),
    };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    // The signature is not verified by the code under test — see the comment in
    // src/oauth.ts — so a placeholder is honest here rather than misleading.
    return `${header}.${payload}.unverified-signature`;
  }

  /* -------------------------------------------------------------- errors -- */

  /** The Calendar API's error shape: nested object with an `errors` array. */
  #errorResponse(status: number, reason?: string, message?: string): Response {
    return json(
      {
        error: {
          code: status,
          message: message ?? reason ?? 'error',
          ...(reason
            ? { errors: [{ domain: 'global', reason, message: message ?? reason }] }
            : {}),
        },
      },
      status,
      reason === 'rateLimitExceeded' ? { 'retry-after': '2' } : undefined,
    );
  }

  /** The OAuth endpoints' error shape: flat `error` / `error_description`. */
  #oauthError(status: number, error: string, description: string): Response {
    return json({ error, error_description: description }, status);
  }

  #consume<T extends { times?: number }>(list: T[], entry: T): void {
    if (entry.times === undefined || entry.times <= 1) {
      list.splice(list.indexOf(entry), 1);
    } else {
      entry.times -= 1;
    }
  }
}

function serialiseEvent(event: StoredEvent): Record<string, unknown> {
  return {
    id: event.id,
    status: event.status,
    summary: event.summary,
    updated: event.updated,
    ...(event.extendedProperties ? { extendedProperties: event.extendedProperties } : {}),
  };
}

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function parseJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseBody(raw: string | undefined, contentType: string | null): unknown {
  if (!raw) return undefined;
  if (contentType?.includes('json')) return parseJson(raw);
  if (contentType?.includes('form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}
