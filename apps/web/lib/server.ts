/**
 * Server-side wiring: environment in, `ServiceContext` out.
 *
 * The only place that reads `process.env`. Everything below this file takes a
 * context, which is what lets the service layer be tested end to end with no
 * environment variables at all.
 *
 * Two things this file is careful about:
 *
 *  - **It never throws at import time.** A missing variable must produce a
 *    readable page saying which one, not a blank 500 from a module that failed
 *    to load. So configuration is read inside functions and the failure is a
 *    value, not a crash.
 *  - **The pool is cached per process.** Each serverless instance holds its own
 *    small pool; building a new one per request would exhaust Neon's connection
 *    limit under any load at all.
 */
import { cookies } from 'next/headers';
import { createDb, reserveThrottleSlot, type Database } from '@hebrew-dates/db';
import { resolveKeyManager } from '@hebrew-dates/crypto';
import {
  resolveGeocoder,
  type OutboundGate,
  type ResolvedGeocoder,
} from '@hebrew-dates/geocoding';
import type { OAuthConfig } from '@hebrew-dates/google-client';
import { buildContext, currentUser, type CurrentUser, type ServiceContext } from '@hebrew-dates/service';
import type { Kysely } from 'kysely';

export const SESSION_COOKIE = 'hd_session';

export interface ConfigProblem {
  variable: string;
  why: string;
}

/** Cached per process; a serverless instance reuses its own pool. */
let cachedDb: Kysely<Database> | undefined;
let cachedContext: ServiceContext | undefined;
/**
 * Cached because the Nominatim provider holds a request queue and a result
 * cache. Building a new one per request would defeat both, and would breach
 * the one-request-per-second policy the moment two requests overlapped.
 */
let cachedGeocoder: ResolvedGeocoder | undefined;

export function configProblems(): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const required: [string, string][] = [
    ['DATABASE_URL', 'the Neon connection string the app reads and writes with'],
    ['GOOGLE_OAUTH_CLIENT_ID', 'the OAuth client from Google Cloud Console'],
    ['GOOGLE_OAUTH_CLIENT_SECRET', 'the matching client secret'],
    [
      'GOOGLE_OAUTH_REDIRECT_URI',
      'must exactly match a redirect URI registered on that OAuth client',
    ],
    ['APP_URL', 'the public base URL, used for links back into the app'],
  ];
  for (const [variable, why] of required) {
    if (!process.env[variable]) problems.push({ variable, why });
  }

  // Either a KMS key or a local development key, never neither.
  if (!process.env.KMS_KEY_NAME && !process.env.LOCAL_ENVELOPE_MASTER_KEY) {
    problems.push({
      variable: 'KMS_KEY_NAME',
      why:
        'the Google Cloud KMS key that wraps stored OAuth tokens. For local ' +
        'development set LOCAL_ENVELOPE_MASTER_KEY instead (openssl rand -base64 32).',
    });
  }

  return problems;
}

export function oauthConfig(): OAuthConfig {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? '',
  };
}

export function database(): Kysely<Database> {
  if (!cachedDb) {
    cachedDb = createDb({
      connectionString: process.env.DATABASE_URL as string,
      // Small on purpose: each serverless instance holds its own pool, and a
      // large one multiplies into Neon's connection limit.
      maxConnections: 3,
    });
  }
  return cachedDb;
}

/**
 * The service context for this request.
 *
 * Throws only if configuration is missing, and the routes check
 * `configProblems()` first so that the user sees which variable rather than a
 * stack trace.
 */
export function context(): ServiceContext {
  if (!cachedContext) {
    const problems = configProblems();
    if (problems.length > 0) {
      throw new Error(
        `Hebrew Dates is not configured. Missing: ${problems
          .map((problem) => problem.variable)
          .join(', ')}.`,
      );
    }
    cachedContext = buildContext({
      db: database(),
      keys: resolveKeyManager().keys,
      oauth: oauthConfig(),
      appUrl: process.env.APP_URL as string,
      geocoder: geocoder().geocoder,
    });
  }
  return cachedContext;
}

/**
 * The place-search backend.
 *
 * Built once per process. Falls back to catalogue-only when
 * `GEOCODER_USER_AGENT` is unset, because OpenStreetMap's policy requires a
 * User-Agent that identifies the deployment and inventing a generic one on
 * someone's behalf is how an application gets blocked.
 *
 * The gate is the part that makes this compliant rather than merely polite.
 * OpenStreetMap's limit is one request per second from the *application*, and
 * this application is however many Vercel instances happen to be warm. So the
 * reservation lives in Postgres, which is the only thing all the instances
 * share, and each request takes its turn from there.
 */
export function geocoder(): ResolvedGeocoder {
  if (!cachedGeocoder) {
    cachedGeocoder = resolveGeocoder(process.env, {
      gate: postgresOutboundGate(),
      onPrimaryFailure: (error) => {
        // Logged, not swallowed: a geocoder that is quietly down means every
        // user silently gets 22 cities.
        console.warn(
          '[geocoding] live search failed, falling back to the built-in city list:',
          error instanceof Error ? error.message : error,
        );
      },
    });
  }
  return cachedGeocoder;
}

/**
 * The shared one-per-second reservation, as an `OutboundGate`.
 *
 * `maxWaitMs` is the interesting number. Six seconds means up to six requests
 * may be queued ahead of yours before the gate says "don't bother" and the
 * search degrades to the built-in city list. A user waiting six seconds for a
 * search is poor; a user waiting forty is broken, and silently getting 22
 * cities is better than either.
 */
function postgresOutboundGate(): OutboundGate {
  return {
    async reserve() {
      const slot = await reserveThrottleSlot(database(), {
        key: 'nominatim',
        // 1100ms rather than 1000: the policy is an absolute maximum, and clock
        // skew between instances should not be what puts us over it.
        minIntervalMs: 1100,
        maxWaitMs: 6_000,
      });
      return { granted: slot.granted, waitMs: slot.waitMs };
    },
  };
}

/** Which place-search backend is in use, for the diagnostics panel. */
export function geocoderBackend(): {
  description: string;
  liveSearchEnabled: boolean;
  globallyThrottled: boolean;
  attribution: { text: string; url: string; licence: string } | undefined;
} {
  const resolved = geocoder();
  return {
    description: resolved.description,
    liveSearchEnabled: resolved.liveSearchEnabled,
    globallyThrottled: resolved.globallyThrottled,
    attribution: resolved.attribution,
  };
}

/** Which encryption backend is in use, for the diagnostics panel. */
export function keyBackend(): { backend: string; description: string } | undefined {
  try {
    const resolved = resolveKeyManager();
    return { backend: resolved.backend, description: resolved.description };
  } catch {
    return undefined;
  }
}

export async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

/** The signed-in user, or undefined. "Not signed in" is an ordinary state. */
export async function signedInUser(): Promise<CurrentUser | undefined> {
  const token = await sessionToken();
  if (!token) return undefined;
  return currentUser(context(), token);
}

/**
 * Cookie attributes for the session.
 *
 * `httpOnly` so script cannot read it, `sameSite: 'lax'` so the OAuth redirect
 * back from Google still carries it while a cross-site POST does not, and
 * `secure` everywhere except local http development.
 */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: (process.env.APP_URL ?? '').startsWith('https://'),
    path: '/',
    expires: expiresAt,
  };
}

/**
 * A coarse client IP, for the session's provenance record.
 *
 * Three octets only. This is a personal-dates app, not an ad network, and a
 * full address is more than is needed to notice a session created somewhere
 * unexpected.
 */
export function ipPrefix(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const first = headerValue.split(',')[0]?.trim();
  if (!first) return null;
  if (first.includes(':')) {
    // IPv6: the first three groups are about as coarse as the IPv4 case.
    return first.split(':').slice(0, 3).join(':');
  }
  const octets = first.split('.');
  return octets.length === 4 ? octets.slice(0, 3).join('.') : null;
}
