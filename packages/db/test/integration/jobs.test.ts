/**
 * The job queue, proved against a real server.
 *
 * `FOR UPDATE SKIP LOCKED` is the only thing stopping two concurrent Vercel Cron
 * invocations from doing the same sync twice — which would mean duplicate
 * writes to a user's calendar. That guarantee lives entirely in Postgres, so it
 * can only be tested against Postgres, and only with two genuinely separate
 * connections holding open transactions at the same time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  JOB_LEASE_MS,
  claimJobs,
  completeJob,
  enqueueJob,
  enqueueJobIfAbsent,
  listRecentJobs,
  purgeExpired,
  reclaimAbandonedJobs,
  requeueJob,
} from '../../src/jobs';
import { createSession, hashToken, storeOauthState } from '../../src/sessions';
import {
  createTestDatabase,
  describeWithDatabase,
  seedTenant,
  type TestDatabase,
  type Tenant,
} from '../helpers/database';

describe.runIf(describeWithDatabase)('job queue', () => {
  let harness: TestDatabase;
  let tenant: Tenant;

  beforeAll(async () => {
    harness = await createTestDatabase('jobs');
    tenant = await seedTenant(harness.db, 'jobs');
  }, 60_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  async function clearJobs(): Promise<void> {
    await harness.db.deleteFrom('sync_jobs').execute();
  }

  it('claims a due job and marks it running with an incremented attempt count', async () => {
    await clearJobs();
    await enqueueJob(harness.db, { datasetId: tenant.datasetId, jobType: 'initial_sync' });

    const claimed = await claimJobs(harness.db, { limit: 5 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('running');
    expect(claimed[0]?.attempt_count).toBe(1);
    expect(claimed[0]?.started_at).toBeInstanceOf(Date);
  });

  it('does not claim a job scheduled for the future', async () => {
    await clearJobs();
    const later = new Date(Date.now() + 60 * 60 * 1000);
    await enqueueJob(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'extend_horizon',
      scheduledAt: later,
    });

    expect(await claimJobs(harness.db, { limit: 5 })).toHaveLength(0);
    // The same job becomes claimable once the clock is past its schedule, which
    // is how backoff is expressed: there is no separate timer.
    expect(
      await claimJobs(harness.db, { limit: 5, now: new Date(later.getTime() + 1000) }),
    ).toHaveLength(1);
  });

  it('claims in nearest-first order', async () => {
    await clearJobs();
    const now = Date.now();
    await enqueueJob(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'reconcile',
      scheduledAt: new Date(now - 1000),
    });
    await enqueueJob(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'extend_horizon',
      scheduledAt: new Date(now - 60_000),
    });

    const claimed = await claimJobs(harness.db, { limit: 2 });
    expect(claimed.map((job) => job.job_type)).toEqual(['extend_horizon', 'reconcile']);
  });

  it('never hands the same job to two concurrent workers', async () => {
    await clearJobs();
    for (let index = 0; index < 4; index += 1) {
      await enqueueJob(harness.db, {
        datasetId: tenant.datasetId,
        jobType: 'reconcile',
        scheduledAt: new Date(Date.now() - (index + 1) * 1000),
      });
    }

    // Two separate connections, claiming at the same time. Without SKIP LOCKED
    // one of these would block on the other's row locks and then claim the same
    // rows, and the user would get duplicate calendar writes.
    const workerA = harness.connect();
    const workerB = harness.connect();
    const [claimedA, claimedB] = await Promise.all([
      claimJobs(workerA, { limit: 2 }),
      claimJobs(workerB, { limit: 2 }),
    ]);

    const ids = [...claimedA, ...claimedB].map((job) => job.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('skips rows another transaction is holding rather than waiting for them', async () => {
    await clearJobs();
    await enqueueJob(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'reconcile',
      scheduledAt: new Date(Date.now() - 5000),
    });
    await enqueueJob(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'recalculate',
      scheduledAt: new Date(Date.now() - 1000),
    });

    const holder = harness.connect();
    // Hold a row lock on the oldest job, then claim from another connection and
    // assert we got the *other* job immediately instead of blocking.
    const locked = await new Promise<string>((resolve, reject) => {
      void holder
        .transaction()
        .execute(async (trx) => {
          const row = await trx
            .selectFrom('sync_jobs')
            .select('id')
            .where('status', '=', 'queued')
            .orderBy('scheduled_at')
            .limit(1)
            .forUpdate()
            .executeTakeFirstOrThrow();
          resolve(row.id);
          // Keep the transaction open long enough for the claim below to run.
          await sql`SELECT pg_sleep(1)`.execute(trx);
        })
        .catch(reject);
    });

    const claimed = await claimJobs(harness.db, { limit: 5 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).not.toBe(locked);
  }, 15_000);

  it('does not enqueue a duplicate of a job that is still pending', async () => {
    await clearJobs();
    const first = await enqueueJobIfAbsent(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'reconcile',
      destinationCalendarId: tenant.destinationCalendarId,
    });
    const second = await enqueueJobIfAbsent(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'reconcile',
      destinationCalendarId: tenant.destinationCalendarId,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it('treats a dataset-wide job and a calendar-scoped job as different', async () => {
    await clearJobs();
    const wide = await enqueueJobIfAbsent(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'reconcile',
    });
    const scoped = await enqueueJobIfAbsent(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'reconcile',
      destinationCalendarId: tenant.destinationCalendarId,
    });
    expect(wide.created).toBe(true);
    expect(scoped.created).toBe(true);
    expect(scoped.job.id).not.toBe(wide.job.id);
  });

  it('enqueues again once the previous job has finished', async () => {
    await clearJobs();
    const first = await enqueueJobIfAbsent(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'recalculate',
    });
    await completeJob(harness.db, { jobId: first.job.id, status: 'succeeded' });

    const second = await enqueueJobIfAbsent(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'recalculate',
    });
    expect(second.created).toBe(true);
  });

  it('returns an abandoned job to the queue after its lease expires', async () => {
    await clearJobs();
    await enqueueJob(harness.db, { datasetId: tenant.datasetId, jobType: 'initial_sync' });
    const [claimed] = await claimJobs(harness.db, { limit: 1 });
    expect(claimed?.status).toBe('running');

    // Still within the lease: a slow-but-alive worker must not be interrupted.
    expect(await reclaimAbandonedJobs(harness.db)).toBe(0);

    // Past the lease: the function was killed mid-run, so the job must come
    // back rather than leaving the dataset permanently un-synced.
    const reclaimed = await reclaimAbandonedJobs(harness.db, {
      now: new Date(Date.now() + JOB_LEASE_MS + 1000),
    });
    expect(reclaimed).toBe(1);

    const again = await claimJobs(harness.db, { limit: 1 });
    expect(again).toHaveLength(1);
    // The attempt count survives, so repeated failures are visible.
    expect(again[0]?.attempt_count).toBe(2);
  });

  it('requeues a job that ran out of write budget, preserving its history', async () => {
    await clearJobs();
    await enqueueJob(harness.db, { datasetId: tenant.datasetId, jobType: 'extend_horizon' });
    const [claimed] = await claimJobs(harness.db, { limit: 1 });
    const resumeAt = new Date(Date.now() + 30_000);

    await requeueJob(harness.db, { jobId: claimed!.id, scheduledAt: resumeAt });
    const row = await harness.db
      .selectFrom('sync_jobs')
      .selectAll()
      .where('id', '=', claimed!.id)
      .executeTakeFirstOrThrow();

    expect(row.status).toBe('queued');
    expect(row.started_at).toBeNull();
    expect(row.attempt_count).toBe(1);
    expect(row.scheduled_at.getTime()).toBeCloseTo(resumeAt.getTime(), -2);
  });

  it('truncates a long error summary rather than failing the completion write', async () => {
    await clearJobs();
    const job = await enqueueJob(harness.db, {
      datasetId: tenant.datasetId,
      jobType: 'reconcile',
    });
    await completeJob(harness.db, {
      jobId: job.id,
      status: 'failed',
      errorSummary: 'x'.repeat(5000),
    });
    const row = await harness.db
      .selectFrom('sync_jobs')
      .select(['status', 'error_summary', 'completed_at'])
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();

    expect(row.status).toBe('failed');
    expect(row.error_summary).toHaveLength(500);
    expect(row.completed_at).toBeInstanceOf(Date);
  });

  it('lists recent jobs for one dataset only', async () => {
    await clearJobs();
    const other = await seedTenant(harness.db, 'jobs-other');
    await enqueueJob(harness.db, { datasetId: tenant.datasetId, jobType: 'reconcile' });
    await enqueueJob(harness.db, { datasetId: other.datasetId, jobType: 'reconcile' });

    const mine = await listRecentJobs(harness.db, { datasetId: tenant.datasetId });
    expect(mine).toHaveLength(1);
    expect(mine[0]?.dataset_id).toBe(tenant.datasetId);
  });

  it('purges expired sessions and oauth states, and keeps live ones', async () => {
    const live = await createSession(harness.db, { userId: tenant.userId });

    // An expired session is one whose expiry has simply passed — its
    // `created_at` is further in the past still. `session_expiry_is_in_the_future`
    // constrains expiry relative to creation, and it applies to UPDATE as well
    // as INSERT, so the row is written already aged rather than back-dated.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sixteenDaysAgo = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    await harness.db
      .insertInto('sessions')
      .values({
        id: hashToken('long-abandoned-session'),
        user_id: tenant.userId,
        created_at: thirtyDaysAgo,
        expires_at: sixteenDaysAgo,
        last_seen_at: sixteenDaysAgo,
      })
      .execute();

    await storeOauthState(harness.db, {
      encryptedCodeVerifier: Buffer.alloc(16, 7),
      encryptionKeyId: 'test-key/1',
    });

    const before = await harness.db
      .selectFrom('sessions')
      .select(harness.db.fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(before.count)).toBe(2);

    await purgeExpired(harness.db);

    const remaining = await harness.db.selectFrom('sessions').selectAll().execute();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id.equals(hashToken(live.token))).toBe(true);
    expect(remaining[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());

    // A live OAuth state is untouched: purging is by expiry, not wholesale.
    const states = await harness.db.selectFrom('oauth_states').selectAll().execute();
    expect(states).toHaveLength(1);
  });

  it('cascades jobs away when the dataset is deleted', async () => {
    const doomed = await seedTenant(harness.db, 'jobs-doomed');
    await enqueueJob(harness.db, { datasetId: doomed.datasetId, jobType: 'delete_events' });
    await harness.db.deleteFrom('datasets').where('id', '=', doomed.datasetId).execute();

    const orphans = await harness.db
      .selectFrom('sync_jobs')
      .select('id')
      .where('dataset_id', '=', doomed.datasetId)
      .execute();
    expect(orphans).toHaveLength(0);
  });
});
