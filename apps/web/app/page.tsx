import { redirect } from 'next/navigation';
import PreviewWorkbench from '@/components/PreviewWorkbench';
import { listLocations, listMonths } from '@/lib/preview';
import { configProblems, signedInUser } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;

  // A signed-in visitor wants their dashboard, not the calculator. Skipped
  // entirely when the deployment has no database configured, so the public
  // calculation prototype still works on its own.
  const configured = configProblems().length === 0;
  if (configured && !query.disconnected) {
    const user = await signedInUser();
    if (user) redirect('/dashboard');
  }

  // Rendered on the server so the first paint already has the location
  // catalogue and the month list; no calculation happens in the browser.
  const locations = listLocations();
  const months = listMonths();

  return (
    <main className="page" id="main">
      <header className="masthead">
        <span className="phase-badge">Hebrew birthdays &amp; yahrzeits</span>
        <h1>Hebrew Dates</h1>
        <p>
          Enter a Hebrew birthday or yahrzeit once and it appears on the correct Gregorian
          date every year, from sunset to sunset where you are. Free, and a gift to Klal
          Yisrael.
        </p>

        {query.disconnected ? (
          <p className="notice notice-ok">
            Your Google Calendar has been disconnected
            {query.calendar === 'deleted'
              ? ' and the Hebrew Dates calendar was removed.'
              : '. The Hebrew Dates calendar is still in your Google account.'}{' '}
            Your dates are still saved here.
          </p>
        ) : null}

        {configured ? (
          <p className="inline">
            <a className="cta" href="/auth/google/start">
              Add my dates to Google Calendar
            </a>
          </p>
        ) : (
          <p className="notice notice-warning">
            Calendar syncing is not configured on this deployment, so only the calculator
            below is available.
          </p>
        )}

        <p className="small muted">
          Hebrew Dates creates its own calendar in your Google account and writes only there.
          It cannot see or change your other calendars.
        </p>
      </header>

      <h2>Try the calculations first</h2>
      <p className="muted">
        No account needed. Nothing is written anywhere.
      </p>

      <PreviewWorkbench locations={locations} months={months} />

      <p className="footnote">
        Sunset times are calculated server-side with the NOAA solar algorithm for the
        selected coordinates, and rendered in that location&rsquo;s IANA time zone. Hebrew
        anniversary rules follow the standard calendrical convention (Reingold &amp;
        Dershowitz). Hebrew Dates provides calendar calculations, not halachic rulings; where
        customs differ the affected years are flagged rather than decided silently.
      </p>
    </main>
  );
}
