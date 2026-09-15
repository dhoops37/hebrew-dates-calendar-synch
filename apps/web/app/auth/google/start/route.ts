/**
 * Start the Google sign-in flow.
 *
 * A GET that redirects, rather than a page with a form that posts: the whole
 * action is "send the user to Google", and the CSRF state lives in the
 * database rather than in a cookie, so there is nothing for a cross-site GET
 * to exploit — the worst it can do is send someone to Google's own consent
 * screen.
 *
 * **Rate limited**, which is the one thing this route needs that the callback
 * does not. It is unauthenticated by necessity — it is how someone signs in —
 * and every call inserts an `oauth_states` row holding a sealed PKCE verifier.
 * Nothing is disclosed by hammering it, but the database is not free and the
 * table is not self-limiting. Twenty per /24 per fifteen minutes.
 */
import { NextResponse } from 'next/server';
import { checkRateLimit, recordAuditEvent } from '@hebrew-dates/db';
import { beginGoogleSignIn } from '@hebrew-dates/service';
import { configProblems, context, ipPrefix } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const problems = configProblems();
  if (problems.length > 0) {
    return NextResponse.json(
      {
        error: 'not_configured',
        missing: problems.map((problem) => problem.variable),
        message: 'Google sign-in is not configured on this deployment.',
      },
      { status: 503 },
    );
  }

  // A /24 rather than a full address, so several people behind one office NAT
  // share a generous bucket rather than each getting a tight one. 'unknown'
  // when there is no forwarded header at all, which groups those callers
  // together — correct, since they cannot be told apart.
  const subject = ipPrefix(request.headers.get('x-forwarded-for')) ?? 'unknown';

  const limit = await checkRateLimit(context().db, 'authStart', subject);
  if (!limit.allowed) {
    // Recorded once so a sustained attempt is visible in the audit trail. The
    // event carries only the coarse prefix and a count.
    if (limit.attempts === limit.limit + 1) {
      await recordAuditEvent(
        context().db,
        {
          action: 'auth.rate_limited',
          subjectType: 'user',
          subjectId: null,
          ipPrefix: subject,
          attempts: limit.attempts,
        },
        { actorUserId: null },
      );
    }

    return rateLimitedPage(limit.retryAfterSeconds);
  }

  const url = new URL(request.url);
  // Validated against an allow-list inside the service, so a crafted value
  // cannot turn this into an open redirect.
  const redirectPath = url.searchParams.get('next') ?? '/dashboard';

  const begun = await beginGoogleSignIn(context(), { redirectPath });
  return NextResponse.redirect(begun.authorizationUrl, {
    // Never cached: each visit must mint a fresh state and PKCE verifier.
    headers: { 'cache-control': 'no-store' },
  });
}

/**
 * A readable 429.
 *
 * HTML rather than JSON because a browser lands here, and plain hand-written
 * HTML because this route runs before any session exists and must work even if
 * something in the app's own rendering is broken.
 */
function rateLimitedPage(retryAfterSeconds: number): Response {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<title>Too many attempts — Hebrew Dates</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;` +
      `padding:0 1rem;color:#14161a}a{color:#1f4f8b}</style></head><body>` +
      `<h1>Too many sign-in attempts</h1>` +
      `<p>Please wait about ${minutes} minute${minutes === 1 ? '' : 's'} and try again.</p>` +
      `<p>If you are sharing a network with other people, one of them may have used up ` +
      `the shared allowance. It resets shortly.</p>` +
      `<p><a href="/">Back to Hebrew Dates</a></p></body></html>`,
    {
      status: 429,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(retryAfterSeconds),
      },
    },
  );
}
