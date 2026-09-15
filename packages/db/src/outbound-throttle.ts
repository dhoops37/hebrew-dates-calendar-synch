/**
 * An application-wide gate on outbound requests to a rate-limited upstream.
 *
 * This exists because of a distinction that is easy to miss. `rate-limit.ts`
 * limits *callers*: it counts what one client has asked of us and refuses when
 * they have had enough. This limits *us*: it bounds what the whole application
 * sends to somebody else's API, across every instance, whoever asked.
 *
 * OpenStreetMap's Nominatim is the case in hand. Its usage policy is an
 * absolute maximum of one request per second from an application, and exceeding
 * it is grounds for being blocked. A per-process throttle — which is what a
 * queue in module scope gives you — limits one Vercel instance; with N
 * instances live, N requests per second leave, and the policy does not care how
 * many instances we happen to be running.
 *
 * **Reservation, not refusal.** A caller does not ask "may I?" and get turned
 * away. It takes a *slot*: the earliest instant the next request may leave, and
 * pushes the marker one interval further for whoever comes next. Two instances
 * arriving together get slots one second apart rather than both being refused,
 * because a user searching for their town should not have their search fail
 * merely because somebody else searched 200ms ago.
 *
 * **Why a transaction rather than one statement.** The reservation has to be
 * read and conditionally advanced — conditionally, because a caller that would
 * have to wait a minute should stand down rather than join the queue, and
 * `ON CONFLICT DO UPDATE` cannot both compute that and report the prior value.
 * So it is `SELECT … FOR UPDATE` then `UPDATE`, in one transaction.
 *
 * That is safe on Neon's pooled endpoint: a transaction pooler pins a server
 * connection for the duration of a transaction, so the row lock taken by the
 * SELECT is still held by the same connection when the UPDATE runs. The rule
 * this must not break is holding a lock *across* transactions, which is why the
 * migration runner needs the direct endpoint and this does not.
 */
import type { Kysely } from 'kysely';
import type { Database } from './schema';

export interface ThrottleSlot {
  /**
   * False when the queue was already deeper than `maxWaitMs`. The caller should
   * not send — and no slot was taken, so declining costs the queue nothing.
   */
  granted: boolean;
  /** How long to wait before sending. Zero when the upstream is idle. */
  waitMs: number;
  /**
   * How far ahead of now the reservation already stood — the queue depth at the
   * moment of asking. Equal to `waitMs` when granted; larger when refused.
   */
  queueDepthMs: number;
}

export interface ReserveThrottleOptions {
  /** Which upstream, e.g. `nominatim`. One row per key. */
  key: string;
  /** Minimum spacing between requests. Nominatim's policy is one per second. */
  minIntervalMs: number;
  /**
   * How long a caller is willing to wait for its turn. Beyond this the slot is
   * refused rather than queued, so a burst degrades to the fallback path
   * instead of leaving users watching a spinner.
   */
  maxWaitMs: number;
  now?: Date;
}

/**
 * Take the next send slot for `key`.
 *
 * Returns how long to wait before sending. The slot is consumed whether or not
 * the caller then succeeds: a failed request still went out, and the upstream
 * counted it.
 */
export async function reserveThrottleSlot(
  db: Kysely<Database>,
  options: ReserveThrottleOptions,
): Promise<ThrottleSlot> {
  const now = options.now ?? new Date();

  return db.transaction().execute(async (trx) => {
    // Create the row if this is the first request this deployment has ever
    // made. `doNothing` rather than an update, because the select below is what
    // decides the slot and it must see whatever is already there.
    await trx
      .insertInto('outbound_throttle')
      .values({ throttle_key: options.key, next_available_at: now, updated_at: now })
      .onConflict((oc) => oc.column('throttle_key').doNothing())
      .execute();

    // FOR UPDATE is the whole mechanism: concurrent callers serialise here, so
    // each one sees the previous one's reservation rather than racing it.
    const row = await trx
      .selectFrom('outbound_throttle')
      .select('next_available_at')
      .where('throttle_key', '=', options.key)
      .forUpdate()
      .executeTakeFirstOrThrow();

    // An idle upstream means the marker is in the past, and the slot is now.
    const earliest = Math.max(row.next_available_at.getTime(), now.getTime());
    const queueDepthMs = earliest - now.getTime();

    if (queueDepthMs > options.maxWaitMs) {
      // Refuse *without* advancing the marker. A caller that stands down has
      // not taken a turn, so it must not push the queue out for everyone else.
      return { granted: false, waitMs: queueDepthMs, queueDepthMs };
    }

    await trx
      .updateTable('outbound_throttle')
      .set({
        next_available_at: new Date(earliest + options.minIntervalMs),
        updated_at: now,
      })
      .where('throttle_key', '=', options.key)
      .execute();

    return { granted: true, waitMs: queueDepthMs, queueDepthMs };
  });
}

/** The current queue depth in milliseconds, without taking a slot. */
export async function peekThrottle(
  db: Kysely<Database>,
  key: string,
  now: Date = new Date(),
): Promise<number> {
  const row = await db
    .selectFrom('outbound_throttle')
    .select('next_available_at')
    .where('throttle_key', '=', key)
    .executeTakeFirst();
  if (!row) return 0;
  return Math.max(0, row.next_available_at.getTime() - now.getTime());
}

/** Clear a reservation. For tests and for an operator unwedging a queue. */
export async function resetThrottle(db: Kysely<Database>, key: string): Promise<void> {
  await db.deleteFrom('outbound_throttle').where('throttle_key', '=', key).execute();
}
