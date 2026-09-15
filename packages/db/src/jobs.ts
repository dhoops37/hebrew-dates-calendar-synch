/**
 * Postgres-backed job queue.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole mechanism: a worker claims rows nobody
 * else has locked, inside a transaction, so two concurrent Vercel Cron
 * invocations cannot claim the same job. No Redis, no broker — the workload is
 * thousands of writes a day, and `sync_jobs` was already in the design as the
 * audit trail.
 *
 * Two operational notes that are easy to get wrong:
 *
 *  - **The claim must run on a session-scoped connection.** Neon's pooled
 *    (pgBouncer) endpoint multiplexes transactions across connections, which
 *    breaks `FOR UPDATE`. `createDb({ requireDirectConnection: true })` enforces
 *    that for the worker.
 *  - **A claimed job must be released even if the worker dies.** Vercel can kill
 *    a function mid-run, so `running` jobs older than a lease window are
 *    reclaimed rather than left stuck forever.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database, JobStatus, JobType, SyncJobRow } from './schema';

/** How long a claimed job may stay `running` before it is considered abandoned. */
export const JOB_LEASE_MS = 10 * 60 * 1000;

export interface EnqueueJobInput {
  datasetId: string;
  destinationCalendarId?: string | null;
  jobType: JobType;
  scheduledAt?: Date;
}

export async function enqueueJob(
  db: Kysely<Database>,
  input: EnqueueJobInput,
): Promise<SyncJobRow> {
  return db
    .insertInto('sync_jobs')
    .values({
      dataset_id: input.datasetId,
      destination_calendar_id: input.destinationCalendarId ?? null,
      job_type: input.jobType,
      scheduled_at: input.scheduledAt ?? new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Enqueue only if an equivalent job is not already waiting.
 *
 * Without this, every page load that notices stale events would pile up another
 * reconcile. Equivalence is (dataset, destination, type, still-pending).
 */
export async function enqueueJobIfAbsent(
  db: Kysely<Database>,
  input: EnqueueJobInput,
): Promise<{ job: SyncJobRow; created: boolean }> {
  return db.transaction().execute(async (trx) => {
    let query = trx
      .selectFrom('sync_jobs')
      .selectAll()
      .where('dataset_id', '=', input.datasetId)
      .where('job_type', '=', input.jobType)
      .where('status', 'in', ['queued', 'running'] satisfies JobStatus[]);
    query =
      input.destinationCalendarId === undefined || input.destinationCalendarId === null
        ? query.where('destination_calendar_id', 'is', null)
        : query.where('destination_calendar_id', '=', input.destinationCalendarId);

    const existing = await query.executeTakeFirst();
    if (existing) return { job: existing, created: false };

    const job = await trx
      .insertInto('sync_jobs')
      .values({
        dataset_id: input.datasetId,
        destination_calendar_id: input.destinationCalendarId ?? null,
        job_type: input.jobType,
        scheduled_at: input.scheduledAt ?? new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { job, created: true };
  });
}

/**
 * Claim up to `limit` due jobs, nearest-first.
 *
 * Returns rows already marked `running`, so the caller owns them. If the caller
 * crashes, the lease expiry in `reclaimAbandonedJobs` puts them back.
 *
 * Two orderings are at work and only one comes from the database. The CTE's
 * `ORDER BY scheduled_at` decides *which* jobs are claimed — the oldest ones.
 * The order of `UPDATE … RETURNING` rows, however, is unspecified in Postgres,
 * so the batch is re-sorted here rather than leaving the caller to discover
 * that the hard way. A worker that runs out of time part-way through a batch
 * should have spent it on the most overdue work.
 */
export async function claimJobs(
  db: Kysely<Database>,
  params: { limit: number; now?: Date },
): Promise<SyncJobRow[]> {
  const now = params.now ?? new Date();
  const rows = await sql<SyncJobRow>`
    WITH claimed AS (
      SELECT id
        FROM sync_jobs
       WHERE status = 'queued'
         AND scheduled_at <= ${now}
       ORDER BY scheduled_at
       FOR UPDATE SKIP LOCKED
       LIMIT ${params.limit}
    )
    UPDATE sync_jobs
       SET status = 'running',
           started_at = ${now},
           attempt_count = attempt_count + 1
     WHERE id IN (SELECT id FROM claimed)
    RETURNING *
  `.execute(db);
  return [...rows.rows].sort(
    (left, right) => left.scheduled_at.getTime() - right.scheduled_at.getTime(),
  );
}

export async function completeJob(
  db: Kysely<Database>,
  params: { jobId: string; status: 'succeeded' | 'failed' | 'cancelled'; errorSummary?: string },
): Promise<void> {
  await db
    .updateTable('sync_jobs')
    .set({
      status: params.status,
      completed_at: new Date(),
      error_summary: params.errorSummary?.slice(0, 500) ?? null,
    })
    .where('id', '=', params.jobId)
    .execute();
}

/** Put a job back in the queue, e.g. because its write budget ran out. */
export async function requeueJob(
  db: Kysely<Database>,
  params: { jobId: string; scheduledAt: Date },
): Promise<void> {
  await db
    .updateTable('sync_jobs')
    .set({ status: 'queued', scheduled_at: params.scheduledAt, started_at: null })
    .where('id', '=', params.jobId)
    .execute();
}

/**
 * Return jobs whose worker died mid-run to the queue.
 *
 * Called at the start of every cron invocation. Without it, one killed function
 * leaves a dataset permanently un-synced with no visible error.
 */
export async function reclaimAbandonedJobs(
  db: Kysely<Database>,
  params: { now?: Date; leaseMs?: number } = {},
): Promise<number> {
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - (params.leaseMs ?? JOB_LEASE_MS));
  const result = await db
    .updateTable('sync_jobs')
    .set({ status: 'queued', started_at: null })
    .where('status', '=', 'running')
    .where('started_at', '<', cutoff)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function listRecentJobs(
  db: Kysely<Database>,
  params: { datasetId: string; limit?: number },
): Promise<SyncJobRow[]> {
  return db
    .selectFrom('sync_jobs')
    .selectAll()
    .where('dataset_id', '=', params.datasetId)
    .orderBy('created_at', 'desc')
    .limit(params.limit ?? 10)
    .execute();
}

/** Delete expired sessions and OAuth states. Cheap, and run from the same cron. */
export async function purgeExpired(db: Kysely<Database>, now = new Date()): Promise<void> {
  await db.deleteFrom('sessions').where('expires_at', '<', now).execute();
  await db.deleteFrom('oauth_states').where('expires_at', '<', now).execute();
}
