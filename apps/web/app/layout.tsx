import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hebrew Dates — calculation prototype',
  description:
    'Phase 1 prototype: Hebrew birthdays and yahrzeits, sunset-to-sunset occurrences, no calendar integrations.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // `dir` is on the html element so that switching to Hebrew later is a single
  // attribute change; all layout uses logical properties (PRD 25, 31).
  return (
    <html lang="en" dir="ltr">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
