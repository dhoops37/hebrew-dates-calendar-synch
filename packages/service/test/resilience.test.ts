/**
 * Failure and recovery.
 *
 * Everything here is a thing that will actually happen in production: a token
 * expires, a user revokes access from their Google account page, Google is
 * briefly unavailable, someone deletes the calendar by hand, a function is
 * killed halfway through a sync. Each has a specific correct behaviour, and
 * getting any of them wrong shows up as either duplicated events or a calendar
 * that silently stops updating.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorise, type DatasetAccess } from '@hebrew-dates/db';
import {
  addDateAndSync,
  beginGoogleSignIn,
  completeGoogleSignIn,
  confirmLocation,
  connectionHealth,
  dashboardView,
  ensureGoogleCalendar,
  liveAccessToken,
  runDueJobs,
  syncDestination,
} from '../src/index';
import { ReauthRequiredError, clearTokenCache } from '../src/tokens';
import { createHarness, hasDatabase, JERUSALEM, type Harness } from './helpers/harness';

const YAHRZEIT = {
  type: 'personal_yahrzeit' as const,
  displayName: 'Avraham ben Yitzchak',
  hebrewMonth: 'NISAN' as const,
  hebrewDay: 14,
  originalHebrewYear: 5750,
};

interface Session {
  userId: string;
  datasetId: string;
  destinationCalendarId: string;
  access: DatasetAccess;
}

async function setUpAccount(harness: Harness): Promise<Session> {
  const begun = await beginGoogleSignIn(harness.context);
  const code = harness.google.authorize(begun.authorizationUrl);
  const completed = await completeGoogleSignIn(harness.context, { code, state: begun.state });
  const access = await authorise(harness.context.db, {
    datasetId: completed.datasetId,
    userId: completed.userId,
    minimumRole: 'admin',
  });
  await confirmLocation(harness.context, access, {
    destinationCalendarId: completed.destinationCalendarId,
    userId: completed.userId,
    location: { ...JERUSALEM, source: 'user_selected' },
    calendarTimezoneHint: 'Asia/Jerusalem',
  });
  return {
    userId: completed.userId,
    datasetId: completed.datasetId,
    destinationCalendarId: completed.destinationCalendarId,
    access,
  };
}

describe.runIf(hasDatabase)('tokens', () => {
  let harness: Harness;
  let session: Session;

  beforeEach(async () => {
    clearTokenCache();
    harness = await createHarness('resilience-tokens');
    session = await setUpAccount(harness);
  }, 60_000);

  afterEach(async () => {
    await harness?.destroy();
  });

  it('refreshes the access token from the stored refresh token', async () => {
    const first = await liveAccessToken(harness.context, session.userId);
    expect(first.refreshed).toBe(true);
    expect(first.accessToken).toMatch(/^access-/);
  });

  it('reuses a cached token rather than refreshing on every call', async () => {
    // A single sync run makes dozens of calendar calls; refreshing for each
    // would be slow and would hit Google's token endpoint limits.
    await liveAccessToken(harness.context, session.userId);
    const tokenRequestsBefore = harness.google.requests.filter((request) =>
      request.url.includes('/token'),
    ).length;

    for (let index = 0; index < 5; index += 1) {
      const token = await liveAccessToken(harness.context, session.userId);
      expect(token.refreshed).toBe(false);
    }

    const after = harness.google.requests.filter((request) => request.url.includes('/token'));
    expect(after).toHaveLength(tokenRequestsBefore);
  });

  it('refreshes again once the cached token is near expiry', async () => {
    await liveAccessToken(harness.context, session.userId);
    // Past the 60-second safety margin before the hour is up.
    harness.advance(59 * 60 * 1000);
    const again = await liveAccessToken(harness.context, session.userId);
    expect(again.refreshed).toBe(true);
  });

  it('starts cold in a new instance, as a serverless invocation would', async () => {
    await liveAccessToken(harness.context, session.userId);
    clearTokenCache();
    const afterColdStart = await liveAccessToken(harness.context, session.userId);
    expect(afterColdStart.refreshed).toBe(true);
  });

  it('marks the account for re-authorisation when the user revokes access', async () => {
    // The realistic case: the user removed Hebrew Dates from their Google
    // account. No retry can fix it, so the app must say so once and stop.
    const account = await harness.db.selectFrom('google_accounts').selectAll().executeTakeFirstOrThrow();
    const token = await liveAccessToken(harness.context, session.userId);
    expect(token.accessToken).toBeTruthy();

    // Revoke every grant this fake issued for the account.
    for (const request of harness.google.requests) {
      const body = request.body as Record<string, string> | undefined;
      if (body?.refresh_token) harness.google.revokeGrant(body.refresh_token);
    }
    clearTokenCache();

    await expect(liveAccessToken(harness.context, session.userId)).rejects.toThrow(
      ReauthRequiredError,
    );

    const updated = await harness.db
      .selectFrom('google_accounts')
      .selectAll()
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(updated.connection_status).toBe('needs_reauth');
    expect(updated.last_error).toContain('revoked');

    const health = await connectionHealth(harness.context, session.userId);
    expect(health.connected).toBe(false);
    expect(health.status).toBe('needs_reauth');
  });

  it('refuses immediately once the account is marked, without calling Google', async () => {
    await harness.db
      .updateTable('google_accounts')
      .set({ connection_status: 'revoked' })
      .where('user_id', '=', session.userId)
      .execute();
    clearTokenCache();

    const before = harness.google.requests.length;
    await expect(liveAccessToken(harness.context, session.userId)).rejects.toThrow(/revoked/);
    expect(harness.google.requests.length).toBe(before);
  });

  it('stops pending events rather than accumulating retries against a dead grant', async () => {
    await ensureGoogleCalendar(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });

    // Leave one event needing work, then kill the grant.
    await harness.db
      .updateTable('destination_events')
      .set({ sync_status: 'pending' })
      .execute();
    for (const request of harness.google.requests) {
      const body = request.body as Record<string, string> | undefined;
      if (body?.refresh_token) harness.google.revokeGrant(body.refresh_token);
    }
    clearTokenCache();

    await expect(liveAccessToken(harness.context, session.userId)).rejects.toThrow(
      ReauthRequiredError,
    );

    const rows = await harness.db.selectFrom('destination_events').selectAll().execute();
    expect(rows.every((row) => row.sync_status === 'disconnected')).toBe(true);
  });
});

describe.runIf(hasDatabase)('sync failures', () => {
  let harness: Harness;
  let session: Session;

  beforeEach(async () => {
    clearTokenCache();
    harness = await createHarness('resilience-sync');
    session = await setUpAccount(harness);
    await ensureGoogleCalendar(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
  }, 60_000);

  afterEach(async () => {
    await harness?.destroy();
  });

  it('schedules a retry after a transient failure, and succeeds on the next pass', async () => {
    harness.google.failures.push({ match: /\/events$/, status: 503, times: 20 });

    const first = await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    expect(first.sync.failed).toBeGreaterThan(0);
    expect(first.sync.created).toBe(0);

    const failedRows = await harness.db.selectFrom('destination_events').selectAll().execute();
    expect(failedRows.every((row) => row.sync_status === 'retry_scheduled')).toBe(true);
    expect(failedRows.every((row) => row.next_attempt_at !== null)).toBe(true);
    expect(failedRows.every((row) => row.attempt_count > 0)).toBe(true);

    // Google recovers, and the backoff elapses.
    harness.google.failures = [];
    harness.advance(10 * 60 * 1000);

    const second = await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(second.created).toBeGreaterThan(0);
    expect(second.updated).toBe(0);
    expect(second.failed).toBe(0);

    const syncedRows = await harness.db.selectFrom('destination_events').selectAll().execute();
    expect(syncedRows.every((row) => row.sync_status === 'synced')).toBe(true);
    expect(syncedRows.every((row) => row.last_error === null)).toBe(true);
  });

  it('respects the backoff rather than retrying immediately', async () => {
    harness.google.failures.push({ match: /\/events$/, status: 503, times: 20 });
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    harness.google.failures = [];

    // No time has passed, so the next attempt is not yet due.
    const tooSoon = await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(tooSoon.created).toBe(0);
    expect(
      tooSoon.plan.actions.some(
        (action) => action.type === 'skip' && action.reason === 'backoff_not_elapsed',
      ),
    ).toBe(true);
  });

  it('marks a permanently-invalid event as failed rather than retrying forever', async () => {
    harness.google.failures.push({
      match: /\/events$/,
      status: 400,
      reason: 'invalid',
      times: 20,
    });

    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });

    const rows = await harness.db.selectFrom('destination_events').selectAll().execute();
    expect(rows.every((row) => row.sync_status === 'failed')).toBe(true);
    // No retry is scheduled: nothing about a malformed request improves by
    // waiting, and retrying burns the quota the rest of the sync needs.
    expect(rows.every((row) => row.next_attempt_at === null)).toBe(true);
  });

  it('shows a failure legibly on the dashboard', async () => {
    harness.google.failures.push({ match: /\/events$/, status: 503, times: 20 });
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });

    const view = await dashboardView(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
    });
    expect(view.counts.failed + view.counts.pending).toBeGreaterThan(0);
    expect(view.upcoming[0]?.syncStatusLabel).toMatch(/Waiting to retry/);
    expect(view.upcoming[0]?.lastError).toBeTruthy();
  });

  it('does not duplicate an event when a write succeeded but was not recorded', async () => {
    // The killed-function case. The event ID is derived from the occurrence
    // key, so the retried insert addresses the same event and Google answers
    // 409 — which is why the calendar ends up with one event, not two.
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    const calendarId = harness.google.calendarIds()[0] as string;
    const eventCountAfterFirstSync = harness.google.calendar(calendarId)?.events.size as number;

    // Simulate losing the record of the write: the row goes back to `creating`
    // with no external id, exactly as a killed function would leave it.
    await harness.db
      .updateTable('destination_events')
      .set({
        sync_status: 'creating',
        external_event_id: null,
        content_hash: '0'.repeat(32),
        last_synced_at: null,
      })
      .execute();

    const recovery = await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(recovery.failed).toBe(0);

    // The same number of events, and every row healthy again.
    expect(harness.google.calendar(calendarId)?.events.size).toBe(eventCountAfterFirstSync);
    const rows = await harness.db.selectFrom('destination_events').selectAll().execute();
    expect(rows.every((row) => row.sync_status === 'synced')).toBe(true);
    expect(rows.every((row) => row.external_event_id !== null)).toBe(true);
  });

  it('recreates the calendar and its events if the user deletes it in Google', async () => {
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    const originalCalendarId = harness.google.calendarIds()[0] as string;
    const originalEventCount = harness.google.calendar(originalCalendarId)?.events.size as number;

    // The user deletes the whole calendar from Google's own UI.
    const token = await liveAccessToken(harness.context, session.userId);
    await harness.context.calendarClient(token.accessToken).deleteCalendar(originalCalendarId);
    expect(harness.google.calendarIds()).toHaveLength(0);

    const recreated = await ensureGoogleCalendar(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(recreated.created).toBe(true);
    expect(recreated.googleCalendarId).not.toBe(originalCalendarId);

    // Every event went with the old calendar, so the rows must be recreated
    // rather than patched against a dead calendar id.
    const cleared = await harness.db.selectFrom('destination_events').selectAll().execute();
    expect(cleared.every((row) => row.external_event_id === null)).toBe(true);
    expect(cleared.every((row) => row.sync_status === 'pending')).toBe(true);

    const resynced = await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(resynced.created).toBe(originalEventCount);
    expect(harness.google.calendar(recreated.googleCalendarId)?.events.size).toBe(
      originalEventCount,
    );
  });

  it('updates an event in place when its content changes', async () => {
    const added = await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    const calendarId = harness.google.calendarIds()[0] as string;
    const eventIdsBefore = [...(harness.google.calendar(calendarId)?.events.keys() ?? [])];

    // A correction: the name was spelled wrong.
    await harness.db
      .updateTable('source_records')
      .set({ display_name: 'Avraham ben Yitzchak HaLevi' })
      .where('id', '=', added.sourceRecordId)
      .execute();

    const result = await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(result.updated).toBeGreaterThan(0);
    expect(result.created).toBe(0);
    expect(result.deleted).toBe(0);

    // The same events, patched — not deleted and recreated, which would lose
    // any reminder the user had set by hand and re-notify them.
    expect([...(harness.google.calendar(calendarId)?.events.keys() ?? [])]).toEqual(
      eventIdsBefore,
    );
    const event = [...(harness.google.calendar(calendarId)?.events.values() ?? [])][0];
    expect(event?.summary).toContain('HaLevi');
  });

  it('removes events when a date is deleted', async () => {
    const added = await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    const calendarId = harness.google.calendarIds()[0] as string;

    await harness.db
      .updateTable('source_records')
      .set({ active: false })
      .where('id', '=', added.sourceRecordId)
      .execute();

    const result = await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(result.deleted).toBeGreaterThan(0);

    // Future events are removed from the calendar.
    const events = [...(harness.google.calendar(calendarId)?.events.values() ?? [])];
    expect(events.some((event) => event.status === 'cancelled')).toBe(true);

    // Anything already past is deliberately left alone: a yahrzeit someone
    // observed last week should not vanish from their calendar retroactively.
    // The planner says so explicitly rather than by omission.
    const preserved = result.plan.actions.filter(
      (action) => action.reason === 'past_event_preserved',
    );
    expect(preserved.length).toBeGreaterThan(0);
    const stillConfirmed = events.filter((event) => event.status === 'confirmed');
    expect(stillConfirmed).toHaveLength(preserved.length);

    // Every row that was deleted is gone, so a later reconcile does not retry;
    // the preserved ones stay, so they are not recreated either.
    const rows = await harness.db.selectFrom('destination_events').selectAll().execute();
    expect(rows).toHaveLength(preserved.length);
  });

  it('honours the write budget and leaves the rest for the next pass', async () => {
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: { ...YAHRZEIT, horizonYears: 20 },
    });
    // Clear everything so the next pass has real work to truncate.
    await harness.db.deleteFrom('destination_events').execute();
    const calendarId = harness.google.calendarIds()[0] as string;
    const calendar = harness.google.calendar(calendarId);
    calendar?.events.clear();
    calendar?.usedEventIds.clear();

    const limited = await syncDestination(
      harness.context,
      session.access,
      { destinationCalendarId: session.destinationCalendarId, userId: session.userId },
      { maxWrites: 3 },
    );
    expect(limited.created).toBe(3);
    expect(limited.hasMoreWork).toBe(true);

    // Nearest-first, so a truncated pass keeps the years the user needs soonest.
    const written = await harness.db
      .selectFrom('destination_events')
      .innerJoin(
        'generated_occurrences',
        'generated_occurrences.id',
        'destination_events.generated_occurrence_id',
      )
      .select('generated_occurrences.gregorian_date as gregorian_date')
      .orderBy('generated_occurrences.gregorian_date')
      .execute();
    const allDates = await harness.db
      .selectFrom('generated_occurrences')
      .select('gregorian_date')
      .orderBy('gregorian_date')
      .execute();
    expect(written.map((row) => row.gregorian_date)).toEqual(
      allDates.slice(0, 3).map((row) => row.gregorian_date),
    );
  });
});

describe.runIf(hasDatabase)('the worker', () => {
  let harness: Harness;
  let session: Session;

  beforeEach(async () => {
    clearTokenCache();
    harness = await createHarness('resilience-worker');
    session = await setUpAccount(harness);
    await ensureGoogleCalendar(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
  }, 60_000);

  afterEach(async () => {
    await harness?.destroy();
  });

  it('does nothing when there is nothing to do', async () => {
    const result = await runDueJobs(harness.context);
    expect(result.claimed).toBe(0);
    expect(result.outcomes).toEqual([]);
  });

  it('requeues a job whose write budget ran out, without backoff', async () => {
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: { ...YAHRZEIT, horizonYears: 20 },
    });
    await harness.db.deleteFrom('destination_events').execute();
    const calendar = harness.google.calendar(harness.google.calendarIds()[0] as string);
    calendar?.events.clear();
    calendar?.usedEventIds.clear();
    await harness.db.deleteFrom('sync_jobs').execute();

    const { enqueueJob } = await import('@hebrew-dates/db');
    const job = await enqueueJob(harness.db, {
      datasetId: session.datasetId,
      jobType: 'reconcile',
      scheduledAt: harness.now(),
    });

    const result = await runDueJobs(harness.context, { maxWritesPerDestination: 2 });
    expect(result.outcomes[0]?.status).toBe('requeued');
    expect(result.outcomes[0]?.detail).toContain('more work remains');

    const requeued = await harness.db
      .selectFrom('sync_jobs')
      .selectAll()
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(requeued.status).toBe('queued');
    // Throughput limiting, not a failure: it comes back in seconds, not hours.
    expect(requeued.scheduled_at.getTime() - harness.now().getTime()).toBeLessThanOrEqual(10_000);
  });

  it('fails a job that needs re-authorisation instead of retrying it every tick', async () => {
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    await harness.db.deleteFrom('sync_jobs').execute();
    await harness.db.updateTable('destination_events').set({ sync_status: 'pending' }).execute();

    await harness.db
      .updateTable('google_accounts')
      .set({ connection_status: 'needs_reauth' })
      .where('user_id', '=', session.userId)
      .execute();
    clearTokenCache();

    const { enqueueJob } = await import('@hebrew-dates/db');
    await enqueueJob(harness.db, {
      datasetId: session.datasetId,
      jobType: 'reconcile',
      scheduledAt: harness.now(),
    });

    const result = await runDueJobs(harness.context);
    // No connected admin to act as, so the job fails rather than looping.
    expect(result.outcomes[0]?.status).toBe('failed');
  });

  it('reclaims a job whose worker was killed', async () => {
    const { enqueueJob, claimJobs } = await import('@hebrew-dates/db');
    await enqueueJob(harness.db, {
      datasetId: session.datasetId,
      jobType: 'reconcile',
      scheduledAt: harness.now(),
    });
    // Claimed and then abandoned, as a killed Vercel function would leave it.
    await claimJobs(harness.db, { limit: 1, now: harness.now() });

    const tooSoon = await runDueJobs(harness.context);
    expect(tooSoon.reclaimed).toBe(0);

    harness.advance(11 * 60 * 1000);
    const later = await runDueJobs(harness.context);
    expect(later.reclaimed).toBe(1);
    expect(later.claimed).toBe(1);
  });

  it('stops claiming work when its time budget runs out', async () => {
    const { enqueueJob } = await import('@hebrew-dates/db');
    for (const jobType of ['reconcile', 'recalculate', 'initial_sync'] as const) {
      await enqueueJob(harness.db, {
        datasetId: session.datasetId,
        jobType,
        scheduledAt: harness.now(),
      });
    }

    // Zero budget: nothing starts, and everything goes back to the queue rather
    // than being cut off halfway.
    const result = await runDueJobs(harness.context, { timeBudgetMs: -1 });
    expect(result.stoppedEarly).toBe(true);
    expect(result.outcomes.every((outcome) => outcome.status === 'requeued')).toBe(true);

    const queued = await harness.db
      .selectFrom('sync_jobs')
      .selectAll()
      .where('status', '=', 'queued')
      .execute();
    expect(queued).toHaveLength(3);
  });

  it('clears expired sessions and oauth states on every tick', async () => {
    const begun = await beginGoogleSignIn(harness.context);
    expect(begun.state).toBeTruthy();
    expect(await harness.db.selectFrom('oauth_states').selectAll().execute()).toHaveLength(1);

    harness.advance(60 * 60 * 1000);
    await runDueJobs(harness.context);
    expect(await harness.db.selectFrom('oauth_states').selectAll().execute()).toHaveLength(0);
  });
});
