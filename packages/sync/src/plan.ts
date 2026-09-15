import type { DestinationEvent } from '@hebrew-dates/engine';

/** The lifecycle of one destination event, per PRD 27. */
export type SyncStatus =
  | 'pending'
  | 'creating'
  | 'synced'
  | 'updating'
  | 'deleting'
  | 'retry_scheduled'
  | 'failed'
  | 'disconnected';

/**
 * What the database records as currently existing in a destination calendar.
 * This is the "actual" side of the comparison — a projection of our own rows,
 * not a live read of Google.
 */
export interface StoredDestinationEvent {
  /** Occurrence key: the join between desired and actual. */
  occurrenceKey: string;
  destinationCalendarId: string;
  /** Provider calendar ID. Null before the first successful create. */
  externalCalendarId: string | null;
  /** Provider event ID. Null means nothing has been written yet. */
  externalEventId: string | null;
  /** Hash of the content last *successfully* written. */
  contentHash: string;
  syncStatus: SyncStatus;
  attemptCount: number;
  /** Earliest time a retry may be attempted, epoch ms. */
  nextAttemptAtEpochMs?: number | null;
  /**
   * Start of the event as written, epoch ms. Used to tell a past event from a
   * future one when deciding whether a deletion is allowed. Null for an all-day
   * event or one never written; `gregorianDateEpochMs` covers those.
   */
  startAtEpochMs?: number | null;
  /**
   * Midnight UTC of the Gregorian day the event covers. A coarse but reliable
   * "is this in the past" signal that works for all-day events too.
   */
  gregorianDateEpochMs?: number | null;
}

/** How far the planner is allowed to reach into the past. */
export type PastEventPolicy =
  /** Default. Past events are never created, updated or deleted. */
  | 'preserve'
  /** Rewrite history too — an explicit, user-initiated correction. */
  | 'update_all'
  /** Rewrite from a given instant forwards. */
  | { from: number };

export interface PlanSyncInput {
  destinationCalendarId: string;
  /** Provider calendar ID. Absent until the dedicated calendar exists. */
  externalCalendarId?: string | null;
  /** What the engine says should exist, for this destination only. */
  desired: DestinationEvent[];
  /** What our database says currently exists there. */
  actual: StoredDestinationEvent[];
  nowEpochMs: number;
  /**
   * Whether the user has confirmed this destination's calculation location.
   * When false, nothing is written: see the module docs, property 2.
   */
  locationConfirmed: boolean;
  /** Whether the destination is currently reachable (token valid, calendar exists). */
  connectionStatus?: 'connected' | 'needs_reauth' | 'revoked' | 'calendar_missing';
  pastEventPolicy?: PastEventPolicy;
  /**
   * Cap on writes in one pass, so a large first sync respects the provider's
   * per-calendar write rate. Actions are ordered nearest-first, so the cap
   * always keeps the years the user is about to need.
   */
  maxWrites?: number;
  /** Retry ceiling before an event is reported as permanently failed. */
  maxAttempts?: number;
}

export type SyncActionReason =
  | 'missing_in_destination'
  | 'content_changed'
  | 'previous_attempt_incomplete'
  | 'retry_after_failure'
  | 'no_longer_desired'
  | 'already_synced'
  | 'past_event_preserved'
  | 'backoff_not_elapsed'
  | 'location_not_confirmed'
  | 'destination_disconnected'
  | 'attempt_limit_reached'
  | 'write_budget_exhausted'
  | 'calendar_not_created_yet';

export type SyncAction =
  | {
      type: 'create';
      occurrenceKey: string;
      reason: SyncActionReason;
      event: DestinationEvent;
      /** Deterministic provider event ID to insert with. */
      externalEventId: string;
    }
  | {
      type: 'update';
      occurrenceKey: string;
      reason: SyncActionReason;
      event: DestinationEvent;
      externalEventId: string;
      /** Hash currently stored, for optimistic-concurrency logging. */
      previousContentHash: string;
    }
  | {
      type: 'delete';
      occurrenceKey: string;
      reason: SyncActionReason;
      externalEventId: string;
      externalCalendarId: string | null;
    }
  | { type: 'noop'; occurrenceKey: string; reason: SyncActionReason }
  /** Deliberately not attempted now. `blocking` marks a problem the user must fix. */
  | { type: 'skip'; occurrenceKey: string; reason: SyncActionReason; blocking: boolean };

export interface SyncPlan {
  destinationCalendarId: string;
  actions: SyncAction[];
  /** Counts by action type, for logging and for the dashboard. */
  summary: {
    create: number;
    update: number;
    delete: number;
    noop: number;
    skip: number;
    /** Writes the plan will actually issue: create + update + delete. */
    writes: number;
  };
  /**
   * Set when nothing can be written at all, with the reason. The caller should
   * surface this to the user rather than retrying.
   */
  blocked?: { reason: SyncActionReason; message: string };
  /** True when `maxWrites` truncated the plan, so another pass is needed. */
  hasMoreWork: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 6;

/** Statuses that mean a previous write was started but never confirmed. */
const INCOMPLETE_STATUSES: ReadonlySet<SyncStatus> = new Set([
  'pending',
  'creating',
  'updating',
  'deleting',
]);

/**
 * Decide the writes that bring one destination calendar in line with the
 * engine's output. Pure: same inputs, same plan, every time.
 */
export function planSync(input: PlanSyncInput): SyncPlan {
  const {
    destinationCalendarId,
    desired,
    actual,
    nowEpochMs,
    locationConfirmed,
    connectionStatus = 'connected',
    pastEventPolicy = 'preserve',
    maxWrites = Number.POSITIVE_INFINITY,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = input;
  const externalCalendarId = input.externalCalendarId ?? null;

  assertSingleDestination(destinationCalendarId, desired, actual);

  // ---- Whole-destination blocks. Checked before any per-event reasoning, so a
  // ---- blocked destination produces an explainable plan rather than a partial
  // ---- one that half-writes and half-fails.
  const block = detectBlock({ locationConfirmed, connectionStatus, externalCalendarId, desired });
  if (block) {
    // Every key mentioned on either side is reported as blocked, so the caller
    // can show the user exactly what is waiting on them rather than a count.
    const blockedKeys = new Set<string>([
      ...desired.map((event) => event.key),
      ...actual.map((row) => row.occurrenceKey),
    ]);
    const actions: SyncAction[] = [...blockedKeys].map((occurrenceKey) => ({
      type: 'skip',
      occurrenceKey,
      reason: block.reason,
      blocking: true,
    }));
    return {
      destinationCalendarId,
      actions,
      summary: summarise(actions),
      blocked: block,
      hasMoreWork: false,
    };
  }

  const actualByKey = new Map(actual.map((row) => [row.occurrenceKey, row]));
  const desiredByKey = new Map(desired.map((event) => [event.key, event]));

  // Nearest-first: the years the user is about to need are written before the
  // far end of the horizon, so a truncated pass still produces a useful calendar.
  const orderedDesired = [...desired].sort(
    (a, b) => desiredSortKey(a) - desiredSortKey(b),
  );

  const candidates: SyncAction[] = [];

  for (const event of orderedDesired) {
    const stored = actualByKey.get(event.key);
    candidates.push(
      decideForDesired({ event, stored, nowEpochMs, pastEventPolicy, maxAttempts }),
    );
  }

  // Anything stored but no longer desired: a deleted or paused record, a
  // convention change that dropped the second Adar, a shortened horizon.
  for (const stored of actual) {
    if (desiredByKey.has(stored.occurrenceKey)) continue;
    candidates.push(decideForOrphan({ stored, nowEpochMs, pastEventPolicy, externalCalendarId }));
  }

  // ---- Apply the write budget last, so noops and skips never consume it.
  const actions: SyncAction[] = [];
  let writes = 0;
  let truncated = false;
  for (const action of candidates) {
    if (action.type === 'noop' || action.type === 'skip') {
      actions.push(action);
      continue;
    }
    if (writes >= maxWrites) {
      truncated = true;
      actions.push({
        type: 'skip',
        occurrenceKey: action.occurrenceKey,
        reason: 'write_budget_exhausted',
        blocking: false,
      });
      continue;
    }
    actions.push(action);
    writes++;
  }

  return {
    destinationCalendarId,
    actions,
    summary: summarise(actions),
    hasMoreWork: truncated,
  };
}

function decideForDesired(args: {
  event: DestinationEvent;
  stored: StoredDestinationEvent | undefined;
  nowEpochMs: number;
  pastEventPolicy: PastEventPolicy;
  maxAttempts: number;
}): SyncAction {
  const { event, stored, nowEpochMs, pastEventPolicy, maxAttempts } = args;

  // The past is preserved by default: never create or update an event that has
  // already happened. Users are told their history will not be rewritten, and
  // rewriting it would also churn the calendar for no benefit.
  if (isPast(eventEndEpochMs(event), nowEpochMs, pastEventPolicy)) {
    return { type: 'noop', occurrenceKey: event.key, reason: 'past_event_preserved' };
  }

  if (!stored || !stored.externalEventId) {
    // Nothing written yet. The deterministic ID means that if a previous attempt
    // actually succeeded before timing out, the insert returns 409 and the
    // executor switches to update — no duplicate either way.
    if (stored && stored.attemptCount >= maxAttempts) {
      return {
        type: 'skip',
        occurrenceKey: event.key,
        reason: 'attempt_limit_reached',
        blocking: true,
      };
    }
    if (stored && !backoffElapsed(stored, nowEpochMs)) {
      return {
        type: 'skip',
        occurrenceKey: event.key,
        reason: 'backoff_not_elapsed',
        blocking: false,
      };
    }
    return {
      type: 'create',
      occurrenceKey: event.key,
      reason: stored ? 'previous_attempt_incomplete' : 'missing_in_destination',
      event,
      externalEventId: event.googleEventId,
    };
  }

  if (stored.syncStatus === 'failed' || stored.syncStatus === 'retry_scheduled') {
    if (stored.attemptCount >= maxAttempts) {
      return {
        type: 'skip',
        occurrenceKey: event.key,
        reason: 'attempt_limit_reached',
        blocking: true,
      };
    }
    if (!backoffElapsed(stored, nowEpochMs)) {
      return {
        type: 'skip',
        occurrenceKey: event.key,
        reason: 'backoff_not_elapsed',
        blocking: false,
      };
    }
    return {
      type: 'update',
      occurrenceKey: event.key,
      reason: 'retry_after_failure',
      event,
      externalEventId: stored.externalEventId,
      previousContentHash: stored.contentHash,
    };
  }

  if (stored.contentHash !== event.contentHash) {
    return {
      type: 'update',
      occurrenceKey: event.key,
      reason: 'content_changed',
      event,
      externalEventId: stored.externalEventId,
      previousContentHash: stored.contentHash,
    };
  }

  // Hash matches but the row was left mid-write by an interrupted run.
  if (INCOMPLETE_STATUSES.has(stored.syncStatus)) {
    return {
      type: 'update',
      occurrenceKey: event.key,
      reason: 'previous_attempt_incomplete',
      event,
      externalEventId: stored.externalEventId,
      previousContentHash: stored.contentHash,
    };
  }

  return { type: 'noop', occurrenceKey: event.key, reason: 'already_synced' };
}

function decideForOrphan(args: {
  stored: StoredDestinationEvent;
  nowEpochMs: number;
  pastEventPolicy: PastEventPolicy;
  externalCalendarId: string | null;
}): SyncAction {
  const { stored, nowEpochMs, pastEventPolicy, externalCalendarId } = args;

  // Never written, so there is nothing in the calendar to remove.
  if (!stored.externalEventId) {
    return { type: 'noop', occurrenceKey: stored.occurrenceKey, reason: 'no_longer_desired' };
  }

  if (isPast(storedEventEpochMs(stored), nowEpochMs, pastEventPolicy)) {
    return { type: 'noop', occurrenceKey: stored.occurrenceKey, reason: 'past_event_preserved' };
  }

  return {
    type: 'delete',
    occurrenceKey: stored.occurrenceKey,
    reason: 'no_longer_desired',
    externalEventId: stored.externalEventId,
    externalCalendarId: stored.externalCalendarId ?? externalCalendarId,
  };
}

function detectBlock(args: {
  locationConfirmed: boolean;
  connectionStatus: NonNullable<PlanSyncInput['connectionStatus']>;
  externalCalendarId: string | null;
  desired: DestinationEvent[];
}): SyncPlan['blocked'] {
  const { locationConfirmed, connectionStatus, externalCalendarId, desired } = args;

  // A location the user has not confirmed may simply be wrong, and a wrong
  // location is a wrong sunset in every year of the horizon. Refuse rather than
  // write something that looks authoritative.
  if (!locationConfirmed) {
    return {
      reason: 'location_not_confirmed',
      message:
        'The calculation location for this calendar has not been confirmed. Sunset is ' +
        'calculated from a place, not from a time zone, so confirm the location before ' +
        'any events are written.',
    };
  }

  // Belt and braces: the engine also flags this per event, and the two must
  // agree. If they ever do not, trust the stricter one.
  if (desired.some((event) => event.warnings.some((w) => w.code === 'LOCATION_NOT_CONFIRMED'))) {
    return {
      reason: 'location_not_confirmed',
      message:
        'Some events were calculated for an unconfirmed location. Confirm the calculation ' +
        'location before writing.',
    };
  }

  if (connectionStatus === 'needs_reauth' || connectionStatus === 'revoked') {
    return {
      reason: 'destination_disconnected',
      message:
        'This calendar is not connected. Reconnect the account; the generated dates are ' +
        'safe in Hebrew Dates until you do.',
    };
  }

  if (connectionStatus === 'calendar_missing') {
    return {
      reason: 'destination_disconnected',
      message:
        'The destination calendar no longer exists. Choose or create a calendar before ' +
        'syncing again.',
    };
  }

  if (!externalCalendarId) {
    return {
      reason: 'calendar_not_created_yet',
      message: 'The dedicated calendar has not been created yet.',
    };
  }

  return undefined;
}

/** All-day events have no instant; fall back to the civil day they cover. */
function eventEndEpochMs(event: DestinationEvent): number {
  if (event.timing) return event.timing.endEpochMs;
  return Date.parse(`${event.allDay.endDateExclusive}T00:00:00Z`);
}

function storedEventEpochMs(stored: StoredDestinationEvent): number {
  if (typeof stored.startAtEpochMs === 'number') return stored.startAtEpochMs;
  if (typeof stored.gregorianDateEpochMs === 'number') return stored.gregorianDateEpochMs;
  // Unknown timing: treat as future so it is not silently left behind. Deleting
  // a future event is recoverable; orphaning one forever is not.
  return Number.POSITIVE_INFINITY;
}

function isPast(epochMs: number, nowEpochMs: number, policy: PastEventPolicy): boolean {
  if (policy === 'update_all') return false;
  if (typeof policy === 'object') return epochMs < policy.from;
  return epochMs < nowEpochMs;
}

function backoffElapsed(stored: StoredDestinationEvent, nowEpochMs: number): boolean {
  const next = stored.nextAttemptAtEpochMs;
  if (next === null || next === undefined) return true;
  return nowEpochMs >= next;
}

function desiredSortKey(event: DestinationEvent): number {
  if (event.timing) return event.timing.startEpochMs;
  return Date.parse(`${event.allDay.startDate}T00:00:00Z`);
}

function summarise(actions: SyncAction[]): SyncPlan['summary'] {
  const summary = { create: 0, update: 0, delete: 0, noop: 0, skip: 0, writes: 0 };
  for (const action of actions) {
    summary[action.type]++;
  }
  summary.writes = summary.create + summary.update + summary.delete;
  return summary;
}

function assertSingleDestination(
  destinationCalendarId: string,
  desired: DestinationEvent[],
  actual: StoredDestinationEvent[],
): void {
  // A plan covers exactly one calendar. Mixing destinations would let one
  // member's events be written to another member's calendar, which is the worst
  // failure this system could have.
  for (const event of desired) {
    if (event.destinationCalendarId !== destinationCalendarId) {
      throw new Error(
        `Desired event ${event.key} belongs to destination ${event.destinationCalendarId}, ` +
          `not ${destinationCalendarId}`,
      );
    }
  }
  for (const row of actual) {
    if (row.destinationCalendarId !== destinationCalendarId) {
      throw new Error(
        `Stored event ${row.occurrenceKey} belongs to destination ${row.destinationCalendarId}, ` +
          `not ${destinationCalendarId}`,
      );
    }
  }
  const seen = new Set<string>();
  for (const event of desired) {
    if (seen.has(event.key)) {
      throw new Error(`Duplicate desired occurrence key ${event.key}`);
    }
    seen.add(event.key);
  }
  const seenActual = new Set<string>();
  for (const row of actual) {
    if (seenActual.has(row.occurrenceKey)) {
      throw new Error(`Duplicate stored occurrence key ${row.occurrenceKey}`);
    }
    seenActual.add(row.occurrenceKey);
  }
}

/**
 * Exponential backoff with a cap, for the executor to store on a failed write.
 * Deterministic; jitter is the caller's business so that the planner stays pure.
 */
export function nextAttemptAt(
  attemptCount: number,
  nowEpochMs: number,
  options: { baseMs?: number; maxMs?: number } = {},
): number {
  const base = options.baseMs ?? 30_000;
  const max = options.maxMs ?? 6 * 60 * 60 * 1000;
  const delay = Math.min(max, base * 2 ** Math.max(0, attemptCount - 1));
  return nowEpochMs + delay;
}
