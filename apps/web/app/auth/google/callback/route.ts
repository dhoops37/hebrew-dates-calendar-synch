/**
 * The OAuth callback.
 *
 * Google sends the user back here with `code` and `state`. Everything
 * security-relevant happens in the service layer — the state is consumed
 * exactly once from the database, the PKCE verifier is unsealed, the ID token's
 * claims are checked — so this route's job is to turn the outcome into a
 * cookie and a redirect, and to turn a failure into something a person can
 * read.
 */
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@hebrew-dates/db';
import { completeGoogleSignIn } from '@hebrew-dates/service';
import {
  configProblems,
  context,
  ipPrefix,
  sessionCookieOptions,
} from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (configProblems().length > 0) {
    return errorPage('This deployment is not configured for Google sign-in yet.', 503);
  }

  // Higher than the start route's limit: a legitimate retry loop lands here,
  // and a refusal mid-sign-in is more confusing than one before it began.
  const subject = ipPrefix(request.headers.get('x-forwarded-for')) ?? 'unknown';
  const limit = await checkRateLimit(context().db, 'authCallback', subject);
  if (!limit.allowed) {
    return errorPage(
      'Too many sign-in attempts from your network. Please wait a few minutes and try again.',
      429,
    );
  }

  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) {
    // The user pressed "Cancel", or Google refused. Not an application fault,
    // so it gets a plain explanation rather than a 500.
    return errorPage(
      error === 'access_denied'
        ? 'Sign-in was cancelled. Hebrew Dates cannot add your dates without your permission.'
        : `Google reported a problem with sign-in: ${error}.`,
      400,
    );
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return errorPage('That sign-in link is incomplete. Please start again.', 400);
  }

  try {
    const result = await completeGoogleSignIn(context(), {
      code,
      state,
      ipPrefix: ipPrefix(request.headers.get('x-forwarded-for')),
    });

    const destination = new URL(result.redirectPath, process.env.APP_URL as string);
    if (!result.scopeCheck.sufficient) {
      // Signed in, but the calendar permission was declined. The dashboard
      // says so; silently syncing nothing would be worse.
      destination.searchParams.set('scope', 'insufficient');
    }

    const response = NextResponse.redirect(destination, {
      headers: { 'cache-control': 'no-store' },
    });
    response.cookies.set({
      ...sessionCookieOptions(result.sessionExpiresAt),
      value: result.sessionToken,
    });
    return response;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Sign-in failed.';
    return errorPage(message, 400);
  }
}

/**
 * A readable failure page.
 *
 * Deliberately plain HTML: this route runs before any session exists, and it
 * must work even if something in the app's own rendering is broken.
 */
function errorPage(message: string, status: number): Response {
  const escaped = message.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] as string;
  });

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<title>Sign-in problem — Hebrew Dates</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#14161a}` +
      `a{color:#1f4f8b}</style></head><body>` +
      `<h1>Sign-in problem</h1><p>${escaped}</p>` +
      `<p><a href="/auth/google/start">Try signing in again</a></p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
