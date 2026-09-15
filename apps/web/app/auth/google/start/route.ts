/**
 * Start the Google sign-in flow.
 *
 * A GET that redirects, rather than a page with a form that posts: the whole
 * action is "send the user to Google", and the CSRF state lives in the
 * database rather than in a cookie, so there is nothing for a cross-site GET
 * to exploit — the worst it can do is send someone to Google's own consent
 * screen.
 */
import { NextResponse } from 'next/server';
import { beginGoogleSignIn } from '@hebrew-dates/service';
import { configProblems, context } from '../../../../lib/server';

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
