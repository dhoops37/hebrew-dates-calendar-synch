/**
 * Failure classification.
 *
 * This table is the one that decides whether a stuck calendar retries or gives
 * up, so each case is pinned explicitly. The dangerous pair is 403
 * `rateLimitExceeded` (retry) and 403 `insufficientPermissions` (never retry):
 * the status is identical and treating them alike breaks the product in one
 * direction or the other.
 */
import { describe, expect, it } from 'vitest';
import {
  GoogleApiError,
  GoogleTransportError,
  classify,
  isRetryable,
  parseRetryAfter,
  requiresReauth,
  toGoogleApiError,
} from '../src/index';

/** The Calendar API's error shape. */
function calendarError(
  status: number,
  reason?: string,
  message = 'something went wrong',
  headers?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: status,
        message,
        ...(reason ? { errors: [{ domain: 'global', reason, message }] } : {}),
      },
    }),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  );
}

/** The OAuth endpoints' error shape. */
function oauthError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('classify', () => {
  it.each([
    ['rateLimitExceeded', 'rate_limited'],
    ['userRateLimitExceeded', 'rate_limited'],
    ['quotaExceeded', 'rate_limited'],
    ['dailyLimitExceeded', 'rate_limited'],
    ['backendError', 'rate_limited'],
  ])('treats 403 %s as %s, so it is retried', (reason, expected) => {
    expect(classify(403, reason)).toBe(expected);
  });

  it.each([
    ['insufficientPermissions', 'auth_required'],
    ['authError', 'auth_required'],
    ['forbiddenForServiceAccount', 'auth_required'],
    ['requiredAccessLevel', 'auth_required'],
  ])('treats 403 %s as %s, so it is not retried', (reason, expected) => {
    expect(classify(403, reason)).toBe(expected);
  });

  it('treats a bare 403 as a permission problem', () => {
    // A retry loop on a permission error runs forever and burns the quota the
    // rest of the sync needs. Failing closed is the cheaper mistake.
    expect(classify(403, undefined)).toBe('auth_required');
  });

  it('treats invalid_grant as needing re-authorisation', () => {
    // The user revoked access, or the refresh token expired from disuse.
    expect(classify(400, 'invalid_grant')).toBe('auth_required');
  });

  it('treats a duplicate event id as already existing', () => {
    expect(classify(409, 'duplicate')).toBe('already_exists');
    expect(classify(409, undefined)).toBe('already_exists');
  });

  it.each([404, 410])('treats %s as not found', (status) => {
    expect(classify(status, 'notFound')).toBe('not_found');
  });

  it.each([500, 502, 503, 504])('treats %s as transient', (status) => {
    expect(classify(status, undefined)).toBe('transient');
  });

  it('treats 429 as rate limited', () => {
    expect(classify(429, undefined)).toBe('rate_limited');
  });

  it('treats 408 as transient', () => {
    expect(classify(408, undefined)).toBe('transient');
  });

  it('treats 401 as needing re-authorisation', () => {
    expect(classify(401, undefined)).toBe('auth_required');
  });

  it('treats a malformed request as permanent', () => {
    expect(classify(400, 'invalid')).toBe('invalid_request');
    expect(classify(400, 'invalidParameter')).toBe('invalid_request');
    expect(classify(400, 'required')).toBe('invalid_request');
    expect(classify(400, undefined)).toBe('invalid_request');
  });

  it('lets the reason override the status where they disagree', () => {
    // 500 with an auth reason is not worth retrying; 400 with a rate reason is.
    expect(classify(500, 'authError')).toBe('auth_required');
    expect(classify(400, 'rateLimitExceeded')).toBe('rate_limited');
  });

  it('treats an unrecognised status as unknown, and therefore permanent', () => {
    // Surfacing an unclassified failure beats looping on it silently.
    expect(classify(418, undefined)).toBe('unknown');
    expect(isRetryable(new GoogleApiError({
      operation: 'x',
      status: 418,
      kind: 'unknown',
      message: 'm',
    }))).toBe(false);
  });
});

describe('building an error from a response', () => {
  it('reads the reason and message out of the Calendar API shape', async () => {
    const error = await toGoogleApiError(
      'insert event',
      calendarError(403, 'rateLimitExceeded', 'Rate Limit Exceeded'),
    );
    expect(error.kind).toBe('rate_limited');
    expect(error.reason).toBe('rateLimitExceeded');
    expect(error.status).toBe(403);
    expect(error.message).toContain('insert event failed');
    expect(error.message).toContain('Rate Limit Exceeded');
    expect(error.message).toContain('403');
    expect(error.retryable).toBe(true);
  });

  it('reads the flat OAuth error shape too', async () => {
    const error = await toGoogleApiError(
      'refresh access token',
      oauthError(400, 'invalid_grant', 'Token has been expired or revoked.'),
    );
    expect(error.reason).toBe('invalid_grant');
    expect(error.kind).toBe('auth_required');
    expect(error.requiresReauth).toBe(true);
    expect(error.message).toContain('expired or revoked');
  });

  it('keeps the error details for diagnosis', async () => {
    const error = await toGoogleApiError('patch event', calendarError(404, 'notFound', 'Not Found'));
    expect(error.details).toEqual([
      { domain: 'global', reason: 'notFound', message: 'Not Found' },
    ]);
  });

  it('names the operation, so a stored error says what was being attempted', async () => {
    const error = await toGoogleApiError('create calendar', calendarError(500));
    expect(error.operation).toBe('create calendar');
    expect(error.message.startsWith('create calendar failed')).toBe(true);
  });

  it('survives a non-JSON body', async () => {
    // A proxy or a quota rejection can return HTML; the status must not be lost.
    const response = new Response('<html><body>503 Service Unavailable</body></html>', {
      status: 503,
      headers: { 'content-type': 'text/html' },
    });
    const error = await toGoogleApiError('list events', response);
    expect(error.status).toBe(503);
    expect(error.kind).toBe('transient');
    expect(error.message).toContain('503 Service Unavailable');
  });

  it('survives an empty body', async () => {
    const error = await toGoogleApiError('delete event', new Response('', { status: 502 }));
    expect(error.status).toBe(502);
    expect(error.kind).toBe('transient');
  });

  it('truncates a long body, because the message is shown to users', async () => {
    const response = new Response('x'.repeat(5000), { status: 500 });
    const error = await toGoogleApiError('list events', response);
    // The operation prefix and status suffix are added on top of the 200-char cap.
    expect(error.message.length).toBeLessThan(300);
    expect(error.message).toContain('...');
  });

  it('collapses whitespace so a stored error stays one line', async () => {
    const response = new Response('line one\n\n   line two\n', { status: 500 });
    const error = await toGoogleApiError('list events', response);
    expect(error.message).toContain('line one line two');
    expect(error.message).not.toContain('\n');
  });

  it('picks up Retry-After', async () => {
    const error = await toGoogleApiError(
      'insert event',
      calendarError(429, 'rateLimitExceeded', 'slow down', { 'retry-after': '30' }),
    );
    expect(error.retryAfterSeconds).toBe(30);
  });
});

describe('parseRetryAfter', () => {
  it('reads a seconds value', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('1.5')).toBe(2);
  });

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-04-01T12:00:00Z');
    expect(parseRetryAfter('Wed, 01 Apr 2026 12:00:30 GMT', now)).toBe(30);
  });

  it('never returns a negative wait for a date in the past', () => {
    const now = Date.parse('2026-04-01T12:00:00Z');
    expect(parseRetryAfter('Wed, 01 Apr 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns undefined for a missing or unparseable value', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
  });
});

describe('the retry predicates', () => {
  const error = (kind: Parameters<typeof makeError>[0]) => makeError(kind);
  function makeError(kind: GoogleApiError['kind']): GoogleApiError {
    return new GoogleApiError({ operation: 'op', status: 500, kind, message: 'm' });
  }

  it('retries only transient and rate-limited failures', () => {
    expect(isRetryable(error('transient'))).toBe(true);
    expect(isRetryable(error('rate_limited'))).toBe(true);
    for (const kind of [
      'auth_required',
      'not_found',
      'invalid_request',
      'already_exists',
      'unknown',
    ] as const) {
      expect(isRetryable(error(kind)), kind).toBe(false);
    }
  });

  it('always retries a transport failure', () => {
    expect(isRetryable(new GoogleTransportError('op', new Error('ECONNRESET')))).toBe(true);
  });

  it('does not retry an arbitrary thrown value', () => {
    // A programming error must surface, not loop.
    expect(isRetryable(new TypeError('cannot read property'))).toBe(false);
    expect(isRetryable('a string')).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });

  it('flags only auth failures as needing re-authorisation', () => {
    expect(requiresReauth(error('auth_required'))).toBe(true);
    expect(requiresReauth(error('rate_limited'))).toBe(false);
    expect(requiresReauth(new GoogleTransportError('op', new Error('x')))).toBe(false);
    expect(requiresReauth(new Error('x'))).toBe(false);
  });

  it('describes a transport failure with its cause', () => {
    const error = new GoogleTransportError('insert event', new Error('ECONNRESET'));
    expect(error.message).toContain('insert event');
    expect(error.message).toContain('ECONNRESET');
    expect(error.kind).toBe('transient');
  });
});
