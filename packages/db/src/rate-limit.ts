/**
 * A fixed-window rate limiter in Postgres.
 *
 * `/auth/google/start` is the reason this exists. It is unauthenticated by
 * necessity — it is how someone signs in — and every call inserts an
 * `oauth_states` row holding a sealed PKCE verifier. Without a limit, a script
 * can make this application write to its own database indefinitely. Nothing is
 * disclosed by that, but the database is not free and the table is not
 * self-limiting.
 *
 * **Why Postgres and not memory.** Vercel runs many instances, each with its own
 * heap. An in-memory counter limits one instance rather than one caller, and
 * with enough instances that is indistinguishable from no limit. The counter has
 * to be somewhere shared, and the shared thing this application already has is
 * Postgres.
 *
 * **Why a fixed window.** A caller can burst across a window boundary — up to
 * twice the limit in a short span. That is an accepted trade: the purpose is to
 * stop a script hammering the endpoint, not to smooth traffic precisely. A
 * sliding log would mean storing a timestamp per attempt, which is more rows
 * than the thing being protected.
 *
 * **Why one statement.** The whole check-and-increment is a single upsert with a
 * conditional reset, so two concurrent requests cannot both read "0 attempts"
 * and both proceed. Doing it in two queries would make the limit advisory.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from './schema';

export interface RateLimitDecision {
  allowed: boolean;
  /** Attempts recorded in the current window, including this one. */
  attempts: number;
  limit: number;
  /** When the current window ends and the counter resets. */
  resetsAt: Date;
  /** Seconds until reset, for a `Retry-After` header. */
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  /** Opaque key. The caller composes it, e.g. `auth.start:203.0.113`. */
  bucket: string;
  limit: number;
  windowMs: number;
  now?: Date;
}

/**
 * Count one attempt and say whether it is allowed.
 *
 * Always counts, including the attempt that trips the limit. A caller that
 * keeps hammering therefore keeps its counter high rather than letting it decay
 * while it is being refused.
 */
export async function consumeRateLimit(
  db: Kysely<Database>,
  options: RateLimitOptions,
): Promise<RateLimitDecision> {
  const now = options.now ?? new Date();
  const windowStartCutoff = new Date(now.getTime() - options.windowMs);

  // One statement. `ON CONFLICT` either starts a fresh window — when the stored
  // one has aged out — or increments the existing one, and the CASE decides
  // which inside the same atomic upsert.
  const result = await sql<{ window_start: Date; attempts: number }>`
    INSERT INTO rate_limits (bucket, window_start, attempts, updated_at)
         VALUES (${options.bucket}, ${now}, 1, ${now})
    ON CONFLICT (bucket) DO UPDATE
            SET window_start = CASE
                                 WHEN rate_limits.window_start <= ${windowStartCutoff}
                                 THEN ${now}
                                 ELSE rate_limits.window_start
                               END,
                attempts     = CASE
                                 WHEN rate_limits.window_start <= ${windowStartCutoff}
                                 THEN 1
                                 ELSE rate_limits.attempts + 1
                               END,
                updated_at   = ${now}
      RETURNING window_start, attempts
  `.execute(db);

  const row = result.rows[0];
  if (!row) {
    // Cannot happen: the statement always returns its row. Failing open is the
    // right call regardless — a broken limiter must not lock everybody out of
    // signing in.
    return {
      allowed: true,
      attempts: 0,
      limit: options.limit,
      resetsAt: new Date(now.getTime() + options.windowMs),
      retryAfterSeconds: 0,
    };
  }

  const resetsAt = new Date(row.window_start.getTime() + options.windowMs);
  return {
    allowed: row.attempts <= options.limit,
    attempts: row.attempts,
    limit: options.limit,
    resetsAt,
    retryAfterSeconds: Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000)),
  };
}

/** Read a bucket without counting against it. For tests and diagnostics. */
export async function peekRateLimit(
  db: Kysely<Database>,
  bucket: string,
): Promise<{ attempts: number; windowStart: Date } | undefined> {
  const row = await db
    .selectFrom('rate_limits')
    .select(['attempts', 'window_start'])
    .where('bucket', '=', bucket)
    .executeTakeFirst();
  return row ? { attempts: row.attempts, windowStart: row.window_start } : undefined;
}

/** Clear a bucket. Used by tests, and available to an operator. */
export async function resetRateLimit(db: Kysely<Database>, bucket: string): Promise<void> {
  await db.deleteFrom('rate_limits').where('bucket', '=', bucket).execute();
}

/**
 * Delete windows that have aged out.
 *
 * Run from the same cron as the session purge. Without it this table grows one
 * row per distinct caller and never shrinks.
 */
export async function purgeRateLimits(
  db: Kysely<Database>,
  params: { olderThanMs?: number; now?: Date } = {},
): Promise<number> {
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - (params.olderThanMs ?? 24 * 60 * 60 * 1000));
  const result = await db
    .deleteFrom('rate_limits')
    .where('window_start', '<', cutoff)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/* --------------------------------------------------------------- policies -- */

/**
 * The limits this application applies, in one place so they can be reviewed
 * together rather than found scattered across route handlers.
 */
export const RATE_LIMITS = {
  /**
   * Starting a sign-in. Twenty in fifteen minutes per IP prefix.
   *
   * A real person needs one, or a handful if they are switching accounts or
   * retrying a failed consent. Twenty leaves generous room for that — including
   * several people behind one office NAT, since the key is a /24 rather than a
   * full address — while stopping a script.
   */
  authStart: { limit: 20, windowMs: 15 * 60 * 1000 },
  /**
   * The OAuth callback. Higher, because a legitimate retry loop lands here and
   * a failure here is more confusing to a user mid-sign-in.
   */
  authCallback: { limit: 40, windowMs: 15 * 60 * 1000 },
  /**
   * Location search. Per signed-in user, and the real constraint is the
   * upstream geocoder's own usage policy rather than our database.
   */
  locationSearch: { limit: 60, windowMs: 5 * 60 * 1000 },
} as const;

export type RateLimitPolicy = keyof typeof RATE_LIMITS;

/** Apply a named policy to a subject. The normal way to call this module. */
export async function checkRateLimit(
  db: Kysely<Database>,
  policy: RateLimitPolicy,
  subject: string,
  now?: Date,
): Promise<RateLimitDecision> {
  const { limit, windowMs } = RATE_LIMITS[policy];
  return consumeRateLimit(db, {
    bucket: `${policy}:${subject}`,
    limit,
    windowMs,
    ...(now ? { now } : {}),
  });
}
