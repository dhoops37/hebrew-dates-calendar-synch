/**
 * The service context: everything a use case needs, passed explicitly.
 *
 * No module-level singletons and no global `db`. Each use case takes a context,
 * which is what lets the integration tests run the real code paths against a
 * real Postgres and a Google double with no environment variables at all —
 * and which stops a serverless function from accidentally sharing a connection
 * pool across invocations it should not.
 */
import type { Kysely } from 'kysely';
import type { Database } from '@hebrew-dates/db';
import type { KeyManager } from '@hebrew-dates/crypto';
import type { OAuthConfig } from '@hebrew-dates/google-client';
import { GoogleCalendarClient } from '@hebrew-dates/google-client';

/** Builds a Calendar client. Injected so tests can supply a fake `fetch`. */
export type CalendarClientFactory = (accessToken: string) => GoogleCalendarClient;

export interface ServiceContext {
  db: Kysely<Database>;
  keys: KeyManager;
  oauth: OAuthConfig;
  /** Public base URL, e.g. `https://hebrewdates.app`. Used for source links. */
  appUrl: string;
  /** Injected everywhere rather than calling `Date.now()` inside logic. */
  now: () => Date;
  calendarClient: CalendarClientFactory;
}

export interface BuildContextOptions {
  db: Kysely<Database>;
  keys: KeyManager;
  oauth: OAuthConfig;
  appUrl: string;
  now?: () => Date;
  calendarClient?: CalendarClientFactory;
}

export function buildContext(options: BuildContextOptions): ServiceContext {
  return {
    db: options.db,
    keys: options.keys,
    oauth: options.oauth,
    appUrl: options.appUrl.replace(/\/+$/, ''),
    now: options.now ?? (() => new Date()),
    calendarClient:
      options.calendarClient ??
      ((accessToken) =>
        new GoogleCalendarClient({
          accessToken,
          ...(options.oauth.fetch ? { fetch: options.oauth.fetch } : {}),
        })),
  };
}

/** The purposes used as envelope-encryption context. Never reuse a string. */
export const SECRET_PURPOSE = {
  refreshToken: 'google.refresh_token',
  codeVerifier: 'oauth.code_verifier',
} as const;
