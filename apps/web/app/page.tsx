import PreviewWorkbench from '@/components/PreviewWorkbench';
import { listLocations, listMonths } from '@/lib/preview';

export default function Home() {
  // Rendered on the server so the first paint already has the location
  // catalogue and the month list; no calculation happens in the browser.
  const locations = listLocations();
  const months = listMonths();

  return (
    <main className="page" id="main">
      <header className="masthead">
        <span className="phase-badge">Phase 1 · calculation prototype</span>
        <h1>Hebrew Dates</h1>
        <p>
          Enter a Hebrew birthday or yahrzeit once and see the next twenty Gregorian occurrences,
          each with its exact sunset-to-sunset window. No calendar account is connected and nothing
          is written anywhere: this stage exists to get the calculations right first.
        </p>
      </header>

      <PreviewWorkbench locations={locations} months={months} />

      <p className="footnote">
        Sunset times are calculated server-side with the NOAA solar algorithm at sea level for the
        selected coordinates, and rendered in that location&rsquo;s IANA time zone. Hebrew
        anniversary rules follow the standard calendrical convention (Reingold &amp; Dershowitz).
        Hebrew Dates provides calendar calculations, not halachic rulings; where customs differ the
        affected years are flagged rather than decided silently.
      </p>
    </main>
  );
}
