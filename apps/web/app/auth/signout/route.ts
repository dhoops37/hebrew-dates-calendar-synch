/**
 * Sign out.
 *
 * POST only. A GET sign-out can be triggered by any page that can make the
 * browser issue a request — an `<img src>` is enough — which is a small but
 * real annoyance, and there is no reason to allow it.
 */
import { NextResponse } from 'next/server';
import { destroySession } from '@hebrew-dates/db';
import { SESSION_COOKIE, context, sessionToken } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const token = await sessionToken();
  if (token) {
    // Deleted server-side as well as cleared client-side: a cookie the browser
    // has forgotten is still a valid credential if it was ever captured.
    await destroySession(context().db, token);
  }

  const response = NextResponse.redirect(new URL('/', process.env.APP_URL as string), {
    headers: { 'cache-control': 'no-store' },
  });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
