/**
 * The background worker, driven by Vercel Cron.
 *
 * No Redis and no broker: `sync_jobs` with `FOR UPDATE SKIP LOCKED` is enough
 * for a workload measured in thousands of writes a day, and that table was
 * already in the design as the audit trail. A queue would be a second source of
 * truth about what work exists.
 *
 * Every invocation does the same four things, in order:
 *
 *  1. Return abandoned jobs to the queue. Vercel can kill a function
 *     mid-run, and without this one killed invocation leaves a dataset
 *     permanently un-synced with no visible error.
 *  2. Claim a bounded batch.
 *  3. Run each job, stopping cleanly when the time budget runs out rather than
 *     being killed halfway through one.
 *  4. Requeue anything left over, so the next tick continues.
 *
 * Jobs are idempotent by construction — each one is "make the destination match
 * the dataset" — so a job that runs twice is harmless. That is what makes at
 * least-once delivery acceptable here.
 */
import {
  claimJobs,
  completeJob,
  enqueueJobIfAbsent,
  purgeExpired,
  reclaimAbandonedJobs,
  recordAuditEvent,
  requeueJob,
  systemAccess,
  type SyncJobRow,
} from '@hebrew-dates/db';
import { GoogleApiError, GoogleTransportError } from '@hebrew-dates/google-client';
import { nextAttemptAt } from '@hebrew-dates/sync';
import type { ServiceContext } from './context';
import { extendDatasetHorizon, DEFAULT_HORIZON_YEARS } from './records';
import { syncDataset, type SyncResult } from './sync';

/**
 * How long a run may take before it stops claiming more work.
 *
 * Under Vercel's default 60-second limit, leaving 15 seconds of headroom means
 * the last job finishes and is recorded rather than being cut off — which is
 * the difference between "one job left for next time" and "a job stuck in
 * running until its lease expires".
 */
export const DEFAULT_TIME_BUDGET_MS = 45_000;

/** Jobs claimed per invocation. */
export const DEFAULT_BATCH_SIZE = 5;

export interface RunJobsOptions {
  batchSize?: number;
  timeBudgetMs?: number;
  maxWritesPerDestination?: number;
}

export interface JobOutcome {
  jobId: string;
  jobType: SyncJobRow['job_type'];
  datasetId: string;
  status: 'succeeded' | 'failed' | 'requeued';
  detail: string;
}

export interface RunJobsResult {
  reclaimed: number;
  claimed: number;
  outcomes: JobOutcome[];
  /** True when the budget ran out with jobs still queued. */
  stoppedEarly: boolean;
}

export async function runDueJobs(
  context: ServiceContext,
  options: RunJobsOptions = {},
): Promise<RunJobsResult> {
  const startedAtMs = context.now().getTime();
  const budget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;

  // Cheap, and this is the only place that runs on a schedule.
  await purgeExpired(context.db, context.now());

  const reclaimed = await reclaimAbandonedJobs(context.db, { now: context.now() });
  const jobs = await claimJobs(context.db, {
    limit: options.batchSize ?? DEFAULT_BATCH_SIZE,
    now: context.now(),
  });

  const outcomes: JobOutcome[] = [];
  let stoppedEarly = false;

  for (const [index, job] of jobs.entries()) {
    if (context.now().getTime() - startedAtMs > budget) {
      // Put the rest back untouched rather than starting work that will be cut
      // off. The attempt count is preserved, so a genuinely slow job is still
      // visible as one.
      for (const remaining of jobs.slice(index)) {
        await requeueJob(context.db, {
          jobId: remaining.id,
          scheduledAt: context.now(),
        });
        outcomes.push({
          jobId: remaining.id,
          jobType: remaining.job_type,
          datasetId: remaining.dataset_id,
          status: 'requeued',
          detail: 'time budget exhausted before this job started',
        });
      }
      stoppedEarly = true;
      break;
    }

    outcomes.push(await runOneJob(context, job, options));
  }

  return { reclaimed, claimed: jobs.length, outcomes, stoppedEarly };
}

async function runOneJob(
  context: ServiceContext,
  job: SyncJobRow,
  options: RunJobsOptions,
): Promise<JobOutcome> {
  const access = systemAccess(job.dataset_id, job.id);
  const base = { jobId: job.id, jobType: job.job_type, datasetId: job.dataset_id } as const;

  try {
    const userId = await ownerUserIdFor(context, job.dataset_id);
    if (!userId) {
      // The dataset has no member who can authorise Google calls. Nothing to
      // retry, so it is recorded as failed rather than looping.
      await completeJob(context.db, {
        jobId: job.id,
        status: 'failed',
        errorSummary: 'dataset has no owning user',
      });
      return { ...base, status: 'failed', detail: 'dataset has no owning user' };
    }

    switch (job.job_type) {
      case 'extend_horizon':
      case 'recalculate': {
        const extended = await extendDatasetHorizon(context, access, {
          throughYears: DEFAULT_HORIZON_YEARS,
        });
        // New occurrences exist, so the calendars need another pass.
        await enqueueJobIfAbsent(context.db, {
          datasetId: job.dataset_id,
          jobType: 'reconcile',
          scheduledAt: context.now(),
        });
        await completeJob(context.db, { jobId: job.id, status: 'succeeded' });
        return {
          ...base,
          status: 'succeeded',
          detail: `extended ${extended.records} record(s), ${extended.occurrencesPersisted} occurrence(s)`,
        };
      }

      case 'initial_sync':
      case 'reconcile':
      case 'delete_events': {
        const results = await syncDataset(
          context,
          access,
          { userId },
          options.maxWritesPerDestination !== undefined
            ? { maxWrites: options.maxWritesPerDestination }
            : {},
        );
        return await finishSyncJob(context, job, base, results);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Retried with the same backoff schedule the events use, so the dashboard's
    // "next attempt" and the worker cannot disagree.
    await requeueJob(context.db, {
      jobId: job.id,
      scheduledAt: new Date(nextAttemptAt(job.attempt_count, context.now().getTime())),
    });
    await recordAuditEvent(
      context.db,
      {
        action: 'job.failed',
        subjectType: 'sync_job',
        subjectId: job.id,
        jobType: job.job_type,
        // A category, not the message: an upstream error body can contain a
        // calendar id, a URL with a token in it, or the user's own text.
        failureKind: classifyJobFailure(error),
      },
      { actorUserId: null, at: context.now() },
    );
    return { ...base, status: 'requeued', detail: message.slice(0, 200) };
  }
}

async function finishSyncJob(
  context: ServiceContext,
  job: SyncJobRow,
  base: { jobId: string; jobType: SyncJobRow['job_type']; datasetId: string },
  results: SyncResult[],
): Promise<JobOutcome> {
  const totals = results.reduce(
    (sum, result) => ({
      created: sum.created + result.created,
      updated: sum.updated + result.updated,
      deleted: sum.deleted + result.deleted,
      failed: sum.failed + result.failed,
      more: sum.more || result.hasMoreWork,
      needsReauth: sum.needsReauth || result.needsReauth,
    }),
    { created: 0, updated: 0, deleted: 0, failed: 0, more: false, needsReauth: false },
  );

  const detail =
    `created ${totals.created}, updated ${totals.updated}, ` +
    `deleted ${totals.deleted}, failed ${totals.failed}`;

  if (totals.needsReauth) {
    // No retry will help until the user reconnects, and the account has already
    // been marked. Failing the job stops it consuming a claim slot every tick.
    await completeJob(context.db, {
      jobId: job.id,
      status: 'failed',
      errorSummary: 'Google connection needs re-authorisation',
    });
    return { ...base, status: 'failed', detail: `${detail}; needs re-authorisation` };
  }

  if (totals.more) {
    // The write budget ran out. Come back promptly: this is throughput
    // limiting, not a failure, so it does not deserve exponential backoff.
    await requeueJob(context.db, {
      jobId: job.id,
      scheduledAt: new Date(context.now().getTime() + 5_000),
    });
    return { ...base, status: 'requeued', detail: `${detail}; more work remains` };
  }

  const blocked = results.find((result) => result.blocked);
  if (blocked?.blocked) {
    // Something the user must fix — an unconfirmed location, a missing
    // calendar. Recorded once rather than retried into the ground.
    await completeJob(context.db, {
      jobId: job.id,
      status: 'failed',
      errorSummary: `${blocked.blocked.reason}: ${blocked.blocked.message}`,
    });
    return { ...base, status: 'failed', detail: blocked.blocked.message };
  }

  await completeJob(context.db, { jobId: job.id, status: 'succeeded' });
  return { ...base, status: 'succeeded', detail };
}

/**
 * Reduce a job failure to a category for the audit log.
 *
 * The full message still goes to the job row's `error_summary` and to the cron
 * response, both of which are operator-facing and short-lived. The audit log is
 * kept for years, so it keeps the category only.
 */
function classifyJobFailure(error: unknown): string {
  if (error instanceof GoogleApiError) return `google.${error.kind}`;
  if (error instanceof GoogleTransportError) return 'google.transport';
  if (error instanceof Error) {
    // The class name, not the message: a constructor name is a fixed
    // vocabulary the developer chose, while a message is free text.
    return `error.${error.constructor.name.replace(/[^A-Za-z0-9]/g, '')}`;
  }
  return 'unknown';
}

/**
 * The user whose Google grant a job acts with.
 *
 * An admin member, preferring the one who owns the destination calendar. A job
 * has no session of its own, so it has to borrow an authorisation — and it must
 * be one that actually exists rather than any member of the dataset.
 */
async function ownerUserIdFor(
  context: ServiceContext,
  datasetId: string,
): Promise<string | undefined> {
  const row = await context.db
    .selectFrom('owner_members')
    .innerJoin('datasets', 'datasets.owner_id', 'owner_members.owner_id')
    .innerJoin('google_accounts', 'google_accounts.user_id', 'owner_members.user_id')
    .select('owner_members.user_id as user_id')
    .where('datasets.id', '=', datasetId)
    .where('owner_members.role', '=', 'admin')
    .where('google_accounts.connection_status', '=', 'connected')
    .orderBy('owner_members.joined_at')
    .executeTakeFirst();
  return row?.user_id;
}

/**
 * Queue the work that follows a first sync.
 *
 * The first two Hebrew years are written synchronously on the request that
 * creates a date, so the user sees their calendar populate immediately. The
 * remaining eighteen are queued: they matter, but not in the next two seconds.
 */
export async function queueInitialBackfill(
  context: ServiceContext,
  params: { datasetId: string },
): Promise<void> {
  await enqueueJobIfAbsent(context.db, {
    datasetId: params.datasetId,
    jobType: 'extend_horizon',
    scheduledAt: context.now(),
  });
}

/** Ask for a reconcile pass, coalescing with one already waiting. */
export async function requestReconcile(
  context: ServiceContext,
  params: { datasetId: string; destinationCalendarId?: string },
): Promise<void> {
  await enqueueJobIfAbsent(context.db, {
    datasetId: params.datasetId,
    jobType: 'reconcile',
    ...(params.destinationCalendarId !== undefined
      ? { destinationCalendarId: params.destinationCalendarId }
      : {}),
    scheduledAt: context.now(),
  });
}
