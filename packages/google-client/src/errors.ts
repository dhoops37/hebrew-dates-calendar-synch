/**
 * Classifying Google API failures.
 *
 * This is the file that decides whether a failed calendar write is retried,
 * abandoned, or escalated to "ask the user to reconnect". Getting it wrong is
 * expensive in both directions: retrying a permanent failure burns quota
 * forever and never succeeds, while abandoning a transient one silently leaves
 * a missing anniversary in someone's calendar.
 *
 * The classification is by `reason`, not by HTTP status alone, because Google
 * returns 403 for several unrelated conditions — quota exhausted (retry after a
 * wait), rate limited (retry sooner), and insufficient permissions (never
 * retry, the user must act). Treating them alike is the single most common way
 * to get this wrong.
 */

export type FailureKind =
  /** Transient. Retry with backoff. */
  | 'transient'
  /** Rate or quota limit. Retry with a longer backoff, and slow down. */
  | 'rate_limited'
  /** The grant is gone or invalid. The user must reconnect; do not retry. */
  | 'auth_required'
  /** The target no longer exists. Usually means "already deleted". */
  | 'not_found'
  /** The request itself is wrong. A bug; retrying cannot help. */
  | 'invalid_request'
  /** The resource already exists — for an idempotent create, a success. */
  | 'already_exists'
  /** Unclassified. Treated as permanent so it surfaces rather than looping. */
  | 'unknown';

export interface GoogleErrorDetail {
  domain?: string;
  reason?: string;
  message?: string;
}

export class GoogleApiError extends Error {
  readonly status: number;
  readonly kind: FailureKind;
  readonly reason: string | undefined;
  readonly details: GoogleErrorDetail[];
  /** Seconds to wait, when the response said so. */
  readonly retryAfterSeconds: number | undefined;
  /** What was being attempted, for the message shown in the dashboard. */
  readonly operation: string;

  constructor(params: {
    operation: string;
    status: number;
    kind: FailureKind;
    reason?: string;
    message: string;
    details?: GoogleErrorDetail[];
    retryAfterSeconds?: number;
  }) {
    super(`${params.operation} failed: ${params.message} (HTTP ${params.status})`);
    this.name = 'GoogleApiError';
    this.operation = params.operation;
    this.status = params.status;
    this.kind = params.kind;
    this.reason = params.reason;
    this.details = params.details ?? [];
    this.retryAfterSeconds = params.retryAfterSeconds;
  }

  /** Whether the sync runner should schedule another attempt. */
  get retryable(): boolean {
    return this.kind === 'transient' || this.kind === 'rate_limited';
  }

  /** Whether the user has to reconnect their Google account. */
  get requiresReauth(): boolean {
    return this.kind === 'auth_required';
  }
}

/** Reasons that mean the grant itself is no longer usable. */
const AUTH_REASONS = new Set([
  'authError',
  'invalid_grant',
  'invalid_token',
  'unauthorized_client',
  'insufficientPermissions',
  'forbiddenForServiceAccount',
  'requiredAccessLevel',
  'ACCESS_TOKEN_EXPIRED',
]);

/** Reasons that mean "slow down", not "stop". */
const RATE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'RESOURCE_EXHAUSTED',
  'backendError',
]);

/** Reasons that are permanent and mean the request was malformed. */
const INVALID_REASONS = new Set([
  'invalid',
  'invalidParameter',
  'badRequest',
  'required',
  'timeRangeEmpty',
  'invalidSharingRequest',
  'cannotChangeOrganizerOfInstance',
]);

/**
 * Classify a Google Calendar / OAuth failure.
 *
 * `reason` wins over `status` wherever the two disagree, because the reason is
 * specific and the status is not: `403 insufficientPermissions` must never be
 * retried while `403 rateLimitExceeded` must be.
 */
export function classify(status: number, reason: string | undefined): FailureKind {
  if (reason) {
    if (AUTH_REASONS.has(reason)) return 'auth_required';
    if (RATE_REASONS.has(reason)) return 'rate_limited';
    if (reason === 'notFound' || reason === 'deleted') return 'not_found';
    if (reason === 'duplicate' || reason === 'alreadyExists') return 'already_exists';
    if (INVALID_REASONS.has(reason)) return 'invalid_request';
  }

  // 409 on an event insert is Google saying "that event ID is taken", which for
  // an idempotent create is the outcome we wanted.
  if (status === 409) return 'already_exists';
  if (status === 401) return 'auth_required';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'invalid_request';
  // 403 with no usable reason: assume permission, not quota. Retrying a
  // permission error forever is worse than surfacing a quota error once.
  if (status === 403) return 'auth_required';
  if (status === 408) return 'transient';
  if (status >= 500) return 'transient';
  return 'unknown';
}

interface GoogleErrorBody {
  error?:
    | {
        code?: number;
        message?: string;
        status?: string;
        errors?: GoogleErrorDetail[];
      }
    | string;
  error_description?: string;
}

/**
 * Build a typed error from a failed response.
 *
 * The body is read as text first and only then parsed, because Google's error
 * bodies are not always JSON — a proxy or a quota rejection can return HTML,
 * and a JSON parse failure there must not mask the real status code.
 */
export async function toGoogleApiError(
  operation: string,
  response: Response,
): Promise<GoogleApiError> {
  const raw = await response.text().catch(() => '');
  let body: GoogleErrorBody | undefined;
  try {
    body = raw ? (JSON.parse(raw) as GoogleErrorBody) : undefined;
  } catch {
    body = undefined;
  }

  const details =
    typeof body?.error === 'object' && body.error?.errors ? body.error.errors : undefined;

  // The OAuth endpoints use `error`/`error_description` strings; the Calendar
  // API uses a nested object with an `errors` array. Both shapes appear here.
  const reason =
    details?.[0]?.reason ??
    (typeof body?.error === 'string' ? body.error : undefined) ??
    (typeof body?.error === 'object' ? body.error?.status : undefined);

  const message =
    (typeof body?.error === 'object' ? body.error?.message : undefined) ??
    body?.error_description ??
    (typeof body?.error === 'string' ? body.error : undefined) ??
    truncateForMessage(raw) ??
    response.statusText ??
    'no error body';

  return new GoogleApiError({
    operation,
    status: response.status,
    kind: classify(response.status, reason),
    ...(reason !== undefined ? { reason } : {}),
    message,
    ...(details !== undefined ? { details } : {}),
    ...(() => {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      return retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {};
    })(),
  });
}

/** `Retry-After` is either seconds or an HTTP date; both appear in the wild. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  // Decide which form it is *before* parsing either way. `Date.parse('-5')`
  // succeeds — it reads a year — so a nonsensical numeric value would otherwise
  // come back as 0, i.e. "retry immediately", which is the opposite of what a
  // rate limit is asking for. A numeric value is therefore never treated as a
  // date; if it is negative it is simply discarded and the caller's own backoff
  // applies.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.ceil(seconds) : undefined;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - now) / 1000));
}

/** Errors are stored and shown to users, so an HTML page must not land there. */
function truncateForMessage(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const collapsed = trimmed.replace(/\s+/g, ' ');
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}

/** A network-level failure, before any HTTP status existed. */
export class GoogleTransportError extends Error {
  readonly kind: FailureKind = 'transient';
  readonly retryable = true;
  constructor(operation: string, cause: unknown) {
    super(`${operation} could not reach Google: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'GoogleTransportError';
    this.cause = cause;
  }
}

/** Whether an arbitrary thrown value should be retried. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof GoogleApiError) return error.retryable;
  if (error instanceof GoogleTransportError) return true;
  return false;
}

/** Whether an arbitrary thrown value means the user must reconnect. */
export function requiresReauth(error: unknown): boolean {
  return error instanceof GoogleApiError && error.requiresReauth;
}
