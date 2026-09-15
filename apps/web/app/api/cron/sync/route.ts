/**
 * The background worker's HTTP entry point, called by Vercel Cron.
 *
 * Vercel Cron issues a plain GET, so the only thing standing between this and
 * the public internet is the shared secret. That matters more than it looks: an
 * unauthenticated caller could not read anything, but they could force
 * repeated syncs and burn the Google quota every real user depends on. So the
 * secret is **required** — a missing `CRON_SECRET` refuses rather than defaulting
 * to open.
 *
 * The worker itself is idempotent and bounded, so being called twice at once is
 * harmless: `FOR UPDATE SKIP LOCKED` means two invocations claim different jobs.
 */
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runDueJobs } from '@hebrew-dates/service';
import { configProblems, context } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

/**
 * Leaves headroom inside Vercel's function limit.
 *
 * The runner has its own, smaller time budget; this is the outer bound so the
 * platform does not kill a job mid-write and leave it to the lease expiry.
 */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Refusing beats running open. A cron endpoint anyone can call is a way to
    // exhaust the Google quota for every user of the deployment.
    return NextResponse.json(
      { error: 'CRON_SECRET is not set; refusing to run the worker.' },
      { status: 503 },
    );
  }

  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
  const presented = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!constantTimeEquals(presented, expected)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }

  if (configProblems().length > 0) {
    return NextResponse.json(
      { error: 'not_configured', missing: configProblems().map((problem) => problem.variable) },
      { status: 503 },
    );
  }

  const started = Date.now();
  try {
    const result = await runDueJobs(context());
    return NextResponse.json(
      {
        ok: true,
        durationMs: Date.now() - started,
        reclaimed: result.reclaimed,
        claimed: result.claimed,
        stoppedEarly: result.stoppedEarly,
        // Per-job outcomes, so a failing dataset is visible in the cron log
        // rather than only in the dashboard of the user it affects.
        outcomes: result.outcomes,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    // A 500 makes Vercel's cron log show the failure. The jobs themselves are
    // already safe: anything claimed and not completed returns to the queue
    // when its lease expires.
    return NextResponse.json(
      {
        ok: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : 'unknown error',
      },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
