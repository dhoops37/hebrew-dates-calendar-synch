/**
 * The audit log, as a closed set of typed events.
 *
 * The previous API took `{ action: string, detail: Record<string, unknown> }`,
 * which meant every future call site was one careless spread away from writing
 * a person's name, a relationship ("Grandfather"), a pair of coordinates or a
 * token into a table that is kept for years and read by operators. Nothing
 * stopped it and nothing would have noticed.
 *
 * So the shape is inverted. There is **one** exported writer, it accepts only a
 * member of the `AuditEvent` union, and each variant declares exactly which
 * fields it carries. Adding a field means editing this file, which is the point:
 * this file is where someone has to think about whether a value is safe to keep.
 *
 * Three layers of protection, deliberately overlapping:
 *
 *  1. **The union.** A call site cannot pass a field the variant does not
 *     declare, and cannot invent an action name.
 *  2. **The projection.** `toDetail` copies named fields one at a time. Even if
 *     a caller defeats the types — `as never`, a JSON round trip, a value read
 *     from a request body — only declared keys reach the database.
 *  3. **The value guard.** Every emitted value must be a boolean, a small
 *     number, or a string drawn from a bounded vocabulary (an identifier, a
 *     status, an IANA zone, a scope URL). Free text is rejected at run time,
 *     because free text is where a name ends up.
 *
 * What is deliberately never recorded: display names, Hebrew names,
 * relationships, notes, coordinates, email local parts, session tokens, refresh
 * tokens, PKCE verifiers, ciphertexts, and iCalendar feed secrets. The tests in
 * `audit.test.ts` assert each of those cannot be written.
 */
import type { Kysely } from 'kysely';
import type { Database } from './schema';

/* ------------------------------------------------------------- vocabulary -- */

/** A value safe to keep in an audit row for years. */
export type AuditValue = string | number | boolean;

/**
 * Where a subject id comes from.
 *
 * Only our own identifiers and Google's opaque ones. A UUID or a Google
 * calendar id says *which* record without saying anything about the person.
 */
export type AuditSubjectType =
  | 'user'
  | 'google_account'
  | 'destination_calendar'
  | 'source_record'
  | 'sync_job'
  | 'dataset';

/**
 * The events this application records. Adding one is a deliberate act.
 *
 * Each variant's fields are non-sensitive by construction: counts, statuses,
 * enum values, identifiers, IANA zones and scope URLs.
 */
export type AuditEvent =
  /* ------------------------------------------------------------ accounts -- */
  | {
      action: 'account.created';
      subjectType: 'google_account';
      subjectId: string;
      grantedScopes: string;
      scopeSufficient: boolean;
    }
  | {
      action: 'google.reconnected';
      subjectType: 'google_account';
      subjectId: string;
      grantedScopes: string;
      scopeSufficient: boolean;
    }
  | {
      action: 'google.disconnected';
      subjectType: 'google_account';
      subjectId: string;
      revokedAtGoogle: boolean;
      calendarDeleted: boolean;
    }
  | {
      action: 'google.needs_reauth';
      subjectType: 'google_account';
      subjectId: string;
      /** A classified failure kind, never the provider's message. */
      reason: 'invalid_grant' | 'insufficient_scope' | 'revoked' | 'unknown';
    }
  /* ------------------------------------------------------------ calendar -- */
  | {
      action: 'calendar.created';
      subjectType: 'destination_calendar';
      subjectId: string;
      /** Google's own opaque calendar id. Says nothing about the person. */
      googleCalendarId: string;
    }
  | {
      action: 'calendar.recreated';
      subjectType: 'destination_calendar';
      subjectId: string;
      googleCalendarId: string;
      /** Why the previous one was replaced. */
      reason: 'deleted_in_google';
    }
  | {
      action: 'calendar.deleted';
      subjectType: 'destination_calendar';
      subjectId: string;
    }
  /* ------------------------------------------------------------ location -- */
  | {
      action: 'location.confirmed';
      subjectType: 'destination_calendar';
      subjectId: string;
      /** The zone, never the coordinates and never the place's name. */
      timezoneId: string;
      source: 'user_selected' | 'geocoded' | 'timezone_suggestion' | 'calendar_timezone_hint';
      /** Which provider resolved it, when one did. */
      geocoder?: string;
    }
  /* --------------------------------------------------------------- dates -- */
  | {
      action: 'date.created';
      subjectType: 'source_record';
      subjectId: string;
      recordType: 'birthday' | 'personal_yahrzeit' | 'famous_yahrzeit';
      hebrewMonth: string;
      hebrewDay: number;
      /** Whether a year was supplied, not the year itself. */
      hasOriginalYear: boolean;
      /** Whether entry went through the Gregorian + sunset-status path. */
      enteredAsGregorian: boolean;
    }
  | {
      action: 'date.edited';
      subjectType: 'source_record';
      subjectId: string;
      /** Which fields changed, never their old or new values. */
      changedFields: string;
      /** True when the change moves the Hebrew date and so re-keys events. */
      dateChanged: boolean;
      occurrencesRegenerated: number;
    }
  | {
      action: 'date.paused';
      subjectType: 'source_record';
      subjectId: string;
      active: boolean;
    }
  | {
      action: 'date.deleted';
      subjectType: 'source_record';
      subjectId: string;
      futureEventsRemoved: number;
      pastEventsKept: number;
    }
  /* ---------------------------------------------------------------- sync -- */
  | {
      action: 'sync.completed';
      subjectType: 'destination_calendar';
      subjectId: string;
      created: number;
      updated: number;
      deleted: number;
      failed: number;
    }
  | {
      action: 'job.failed';
      subjectType: 'sync_job';
      subjectId: string;
      jobType: string;
      /** A classified kind, never the upstream error text. */
      failureKind: string;
    }
  /* -------------------------------------------------------------- limits -- */
  | {
      action: 'auth.rate_limited';
      subjectType: 'user';
      /** Always null: the subject is an unauthenticated caller. */
      subjectId: null;
      /** A coarse IP prefix, already truncated by the caller. */
      ipPrefix: string;
      attempts: number;
    };

export type AuditAction = AuditEvent['action'];

/**
 * The detail keys each action may emit.
 *
 * This is the projection allow-list — the thing that holds even when the types
 * are defeated. It is a plain data table rather than derived from the union,
 * because a runtime guard that is derived from the types it guards is not a
 * guard.
 */
const DETAIL_KEYS: Record<AuditAction, readonly string[]> = {
  'account.created': ['grantedScopes', 'scopeSufficient'],
  'google.reconnected': ['grantedScopes', 'scopeSufficient'],
  'google.disconnected': ['revokedAtGoogle', 'calendarDeleted'],
  'google.needs_reauth': ['reason'],
  'calendar.created': ['googleCalendarId'],
  'calendar.recreated': ['googleCalendarId', 'reason'],
  'calendar.deleted': [],
  'location.confirmed': ['timezoneId', 'source', 'geocoder'],
  'date.created': [
    'recordType',
    'hebrewMonth',
    'hebrewDay',
    'hasOriginalYear',
    'enteredAsGregorian',
  ],
  'date.edited': ['changedFields', 'dateChanged', 'occurrencesRegenerated'],
  'date.paused': ['active'],
  'date.deleted': ['futureEventsRemoved', 'pastEventsKept'],
  'sync.completed': ['created', 'updated', 'deleted', 'failed'],
  'job.failed': ['jobType', 'failureKind'],
  'auth.rate_limited': ['ipPrefix', 'attempts'],
};

/**
 * Every action this application can record.
 *
 * Derived from the allow-list table rather than written out again, so the two
 * cannot drift. A `satisfies` check against the union makes TypeScript complain
 * if a variant is added without an entry in `DETAIL_KEYS`.
 */
export const AUDIT_ACTIONS = Object.keys(DETAIL_KEYS) as AuditAction[];

export class UnsafeAuditValueError extends Error {}

/**
 * Strings that may appear in an audit row.
 *
 * Identifiers, enum values, IANA zones, scope URLs, comma-separated field
 * names. Notably **no spaces except in a scope list**, because a value with
 * spaces in it is almost always prose, and prose is how a name gets in.
 */
const SAFE_STRING = /^[A-Za-z0-9_.:/\-+@,]*$/;
const SAFE_SCOPE_LIST = /^[A-Za-z0-9_.:/\-+ ]*$/;

/**
 * Per-field limits, because one global limit is not enough.
 *
 * A Google refresh token has *exactly* the character shape of an identifier —
 * `1//0gWj8xQZ...` is letters, digits, slashes and underscores — so the
 * character class alone cannot tell a credential from an id. What does separate
 * them is length: every legitimate value here has a known, small bound, and
 * every credential is longer than the field it would be smuggled into.
 *
 * Keyed by field name rather than by action, because a field name means the
 * same thing wherever it appears.
 */
const FIELD_LIMITS: Record<string, number> = {
  // The one long value: three scope URLs, space separated.
  grantedScopes: 400,
  // `hebrewdates-9d045b7741bd@group.calendar.google.com` is about 50.
  googleCalendarId: 120,
  // The longest IANA zone is `America/Argentina/Buenos_Aires` at 30.
  timezoneId: 64,
  // A comma-separated list of this schema's own field names.
  changedFields: 200,
  ipPrefix: 45,
};

/** Anything not named above is an enum value or a short identifier. */
const DEFAULT_FIELD_LIMIT = 64;

/**
 * Shapes that are credentials, whatever field they arrive in.
 *
 * A short deny-list, not a classifier. The primary defence is the closed union
 * and the named projection — a token can only reach here if someone puts it in
 * a declared field on purpose. This catches the specific shapes that would
 * otherwise slip through a length check, and names them so the error is
 * unambiguous.
 */
const CREDENTIAL_SHAPES: { pattern: RegExp; what: string }[] = [
  { pattern: /^1\/\//, what: 'a Google refresh token' },
  { pattern: /^ya29\./, what: 'a Google access token' },
  { pattern: /^eyJ[A-Za-z0-9_-]{10,}\./, what: 'a JWT' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { pattern: /[?&](secret|token|key|password|sig|signature)=/i, what: 'a URL carrying a secret' },
  { pattern: /^[A-Za-z0-9+/]{40,}={0,2}$/, what: 'a long base64 blob' },
];

/**
 * Reject a value that does not belong in an audit row.
 *
 * Deliberately strict, and deliberately a throw rather than a silent drop: a
 * developer who tries to log a display name should find out immediately, in a
 * test, not months later when someone reads the table.
 */
function assertSafe(action: AuditAction, key: string, value: unknown): AuditValue {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new UnsafeAuditValueError(`${action}.${key} is not a finite number.`);
    }
    return value;
  }

  if (typeof value === 'string') {
    const limit = FIELD_LIMITS[key] ?? DEFAULT_FIELD_LIMIT;
    if (value.length > limit) {
      throw new UnsafeAuditValueError(
        `${action}.${key} is ${value.length} characters; the limit is ${limit}. The audit ` +
          'log holds identifiers, enum values and counts — anything longer is either ' +
          'free text or a credential, and neither belongs in a table kept for years.',
      );
    }

    for (const { pattern, what } of CREDENTIAL_SHAPES) {
      if (pattern.test(value)) {
        throw new UnsafeAuditValueError(
          `${action}.${key} looks like ${what}. Credentials must never reach the audit log.`,
        );
      }
    }

    const pattern = key === 'grantedScopes' ? SAFE_SCOPE_LIST : SAFE_STRING;
    if (!pattern.test(value)) {
      throw new UnsafeAuditValueError(
        `${action}.${key} contains characters the audit log does not accept. It holds ` +
          'identifiers, enum values, time zones and scope URLs — never free text, ' +
          'because free text is where a name ends up.',
      );
    }
    return value;
  }

  throw new UnsafeAuditValueError(
    `${action}.${key} is a ${value === null ? 'null' : typeof value}; audit values must be ` +
      'a string, a number or a boolean. An object would carry whatever was spread into it.',
  );
}

/**
 * Project an event onto the keys its action declares.
 *
 * Copies by name from the allow-list rather than spreading, so a field the
 * table does not list cannot reach the database however it got onto the object.
 */
export function toDetail(event: AuditEvent): Record<string, AuditValue> {
  const allowed = DETAIL_KEYS[event.action];
  if (!allowed) {
    throw new UnsafeAuditValueError(
      `"${String(event.action)}" is not a known audit action. Add it to AuditEvent and ` +
        'DETAIL_KEYS in packages/db/src/audit.ts.',
    );
  }

  const source = event as unknown as Record<string, unknown>;
  const detail: Record<string, AuditValue> = {};
  for (const key of allowed) {
    const value = source[key];
    // Optional fields are simply absent rather than written as null.
    if (value === undefined) continue;
    detail[key] = assertSafe(event.action, key, value);
  }
  return detail;
}

/* ----------------------------------------------------------------- writer -- */

export interface AuditWriteOptions {
  /** Null for a system action, which is an ordinary case for the worker. */
  actorUserId: string | null;
  at?: Date;
}

/**
 * Record one audit event.
 *
 * The only way to write this table. There is no escape hatch, and adding one
 * would defeat the whole arrangement — if a future need arises, add a variant
 * to `AuditEvent` instead.
 */
export async function recordAuditEvent(
  db: Kysely<Database>,
  event: AuditEvent,
  options: AuditWriteOptions,
): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      actor_user_id: options.actorUserId,
      action: event.action,
      subject_type: event.subjectType,
      subject_id: event.subjectId,
      detail: JSON.stringify(toDetail(event)) as unknown,
      ...(options.at ? { at: options.at } : {}),
    })
    .execute();
}

/** Read the trail for one subject. For an operator, and for the tests. */
export async function readAuditTrail(
  db: Kysely<Database>,
  params: { subjectType: AuditSubjectType; subjectId: string; limit?: number },
): Promise<{ at: Date; action: string; actorUserId: string | null; detail: unknown }[]> {
  const rows = await db
    .selectFrom('audit_log')
    .select(['at', 'action', 'actor_user_id', 'detail'])
    .where('subject_type', '=', params.subjectType)
    .where('subject_id', '=', params.subjectId)
    .orderBy('at', 'desc')
    .limit(params.limit ?? 50)
    .execute();

  return rows.map((row) => ({
    at: row.at,
    action: row.action,
    actorUserId: row.actor_user_id,
    detail: row.detail,
  }));
}
