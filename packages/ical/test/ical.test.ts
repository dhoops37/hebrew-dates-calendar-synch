import { describe, expect, it } from 'vitest';
import { generateOccurrences, getSeedLocation, type Occurrence } from '@hebrew-dates/engine';
import {
  backupFilename,
  compactDate,
  escapeText,
  foldLine,
  formatTrigger,
  formatUtcTimestamp,
  renderCalendar,
} from '../src/index';

const jerusalem = getSeedLocation('seed:jerusalem')!;
const tromso = getSeedLocation('seed:tromso')!;
const NOW = Date.UTC(2025, 0, 15, 12, 0, 0);
const GENERATED_AT = Date.UTC(2025, 0, 15, 12, 30, 0);

function occurrences(overrides: Partial<Parameters<typeof generateOccurrences>[0]> = {}) {
  const result = generateOccurrences({
    sourceRecordId: 'record-1',
    type: 'birthday',
    displayName: 'David',
    origin: { month: 'NISAN', day: 10 },
    location: jerusalem,
    displayMode: 'exact_sunset',
    count: 3,
    nowEpochMs: NOW,
    ...overrides,
  });
  if (result.status !== 'ok') throw new Error('expected occurrences');
  return result.occurrences;
}

function render(items: Occurrence[], overrides: Partial<Parameters<typeof renderCalendar>[0]> = {}) {
  return renderCalendar({
    calendarName: 'Hebrew Dates',
    occurrences: items,
    displayMode: 'exact_sunset',
    timezoneId: 'Asia/Jerusalem',
    generatedAtEpochMs: GENERATED_AT,
    ...overrides,
  });
}

/** Unfold continuation lines so assertions can target logical properties. */
function logicalLines(ics: string): string[] {
  return ics.replace(/\r\n /g, '').split('\r\n');
}

describe('calendar structure', () => {
  const ics = render(occurrences());

  it('is a well-formed VCALENDAR with CRLF endings', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // No bare LF anywhere.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it('declares the required calendar properties', () => {
    const lines = logicalLines(ics);
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('CALSCALE:GREGORIAN');
    expect(lines.some((line) => line.startsWith('PRODID:'))).toBe(true);
    expect(lines).toContain('X-WR-TIMEZONE:Asia/Jerusalem');
    expect(lines).toContain('X-WR-CALNAME:Hebrew Dates');
  });

  it('emits one VEVENT per occurrence, each properly closed', () => {
    const begins = ics.match(/BEGIN:VEVENT/g) ?? [];
    const ends = ics.match(/END:VEVENT/g) ?? [];
    expect(begins).toHaveLength(3);
    expect(ends).toHaveLength(3);
  });

  it('tells subscribing clients how often to refresh', () => {
    expect(logicalLines(ics)).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT24H');
    expect(logicalLines(ics)).toContain('X-PUBLISHED-TTL:PT24H');
  });
});

describe('timed events (exact sunset mode)', () => {
  const items = occurrences();
  const lines = logicalLines(render(items));

  it('uses UTC instants so no VTIMEZONE is needed', () => {
    const dtstart = lines.filter((line) => line.startsWith('DTSTART'));
    expect(dtstart).toHaveLength(3);
    for (const line of dtstart) {
      expect(line).toMatch(/^DTSTART:\d{8}T\d{6}Z$/);
    }
    expect(lines.some((line) => line.startsWith('BEGIN:VTIMEZONE'))).toBe(false);
    expect(lines.some((line) => line.includes('TZID='))).toBe(false);
  });

  it('places DTSTART and DTEND at the two calculated sunsets', () => {
    const first = items[0]!;
    expect(lines).toContain(`DTSTART:${formatUtcTimestamp(first.timing!.startEpochMs)}`);
    expect(lines).toContain(`DTEND:${formatUtcTimestamp(first.timing!.endEpochMs)}`);
    // Sanity: the UTC instant must correspond to the location-local ISO string.
    expect(new Date(first.timing!.startIso).getTime()).toBe(first.timing!.startEpochMs);
  });

  it('marks events transparent so they do not block availability', () => {
    expect(lines.filter((line) => line === 'TRANSP:TRANSPARENT')).toHaveLength(3);
  });

  it('names the calculation location in both LOCATION and DESCRIPTION', () => {
    expect(lines.some((line) => line.startsWith('LOCATION:Jerusalem'))).toBe(true);
    const description = lines.find((line) => line.startsWith('DESCRIPTION:'))!;
    expect(description).toContain('Calculation location: Jerusalem');
  });
});

describe('all-day events (two-day mode)', () => {
  const items = occurrences({ displayMode: 'two_day_all_day' });
  const lines = logicalLines(render(items, { displayMode: 'two_day_all_day' }));

  it('uses DATE values, not timestamps', () => {
    expect(lines.some((line) => line.startsWith('DTSTART;VALUE=DATE:'))).toBe(true);
    expect(lines.some((line) => line.startsWith('DTSTART:'))).toBe(false);
  });

  it('ends on the day after the second covered day, because DTEND is exclusive', () => {
    const first = items[0]!;
    const start = compactDate(first.allDay.startDate);
    const end = compactDate(first.allDay.endDateExclusive);
    expect(lines).toContain(`DTSTART;VALUE=DATE:${start}`);
    expect(lines).toContain(`DTEND;VALUE=DATE:${end}`);

    // Exactly two calendar days are covered.
    const toDate = (compact: string) =>
      Date.UTC(
        Number(compact.slice(0, 4)),
        Number(compact.slice(4, 6)) - 1,
        Number(compact.slice(6, 8)),
      );
    expect((toDate(end) - toDate(start)) / 86_400_000).toBe(2);
  });

  it('is one VEVENT per occurrence, not two', () => {
    expect((render(items, { displayMode: 'two_day_all_day' }).match(/BEGIN:VEVENT/g) ?? []).length).toBe(
      items.length,
    );
  });
});

describe('occurrences with no sunset', () => {
  it('degrades to an all-day event rather than being dropped or emitting an invalid time', () => {
    const items = occurrences({
      location: tromso,
      origin: { month: 'SIVAN', day: 25 },
      count: 2,
    });
    expect(items.every((item) => item.timing === null)).toBe(true);

    const lines = logicalLines(
      render(items, { timezoneId: 'Europe/Oslo', displayMode: 'exact_sunset' }),
    );
    expect(lines.filter((line) => line.startsWith('DTSTART;VALUE=DATE:'))).toHaveLength(2);
    expect(lines.some((line) => line.includes('Invalid'))).toBe(false);
    expect(lines.some((line) => line.includes('NaN'))).toBe(false);
  });
});

describe('identity and idempotency', () => {
  it('uses the stable occurrence key as the UID, so a re-import updates rather than duplicates', () => {
    const items = occurrences();
    const lines = logicalLines(render(items));
    for (const item of items) {
      expect(lines).toContain(`UID:${item.key}@hebrewdates.app`);
    }
    expect(new Set(lines.filter((line) => line.startsWith('UID:'))).size).toBe(items.length);
  });

  it('produces byte-identical output for identical input', () => {
    expect(render(occurrences())).toBe(render(occurrences()));
  });

  it('changes the file when the location changes but keeps every UID', () => {
    const before = render(occurrences());
    const after = render(occurrences({ location: getSeedLocation('seed:new-york')! }), {
      timezoneId: 'America/New_York',
    });
    expect(after).not.toBe(before);
    const uids = (ics: string) => logicalLines(ics).filter((line) => line.startsWith('UID:'));
    expect(uids(after)).toEqual(uids(before));
  });

  it('carries provenance for error reports without anything sensitive', () => {
    const lines = logicalLines(render(occurrences()));
    expect(lines.some((line) => line.startsWith('X-HEBREW-DATES-OCCURRENCE-KEY:'))).toBe(true);
    expect(lines.some((line) => line.startsWith('X-HEBREW-DATES-CALC-VERSION:'))).toBe(true);
    expect(lines.some((line) => line.startsWith('X-HEBREW-DATES-RULE:SAME_MONTH_AND_DAY'))).toBe(true);
  });
});

describe('reminders', () => {
  it('emits a VALARM per configured reminder', () => {
    const lines = logicalLines(
      render(occurrences(), {
        reminders: [
          { minutesBeforeStart: 1440, description: 'Tomorrow' },
          { minutesBeforeStart: 0, description: 'Now' },
        ],
      }),
    );
    expect(lines.filter((line) => line === 'BEGIN:VALARM')).toHaveLength(6);
    expect(lines).toContain('TRIGGER:-P1D');
    expect(lines).toContain('TRIGGER:-PT0M');
  });

  it('rounds reminders to whole days for all-day events, where clients anchor to midnight', () => {
    const items = occurrences({ displayMode: 'two_day_all_day' });
    const lines = logicalLines(
      render(items, {
        displayMode: 'two_day_all_day',
        reminders: [{ minutesBeforeStart: 90 }],
      }),
    );
    // 90 minutes before midnight is meaningless across clients; it becomes "at start".
    expect(lines).toContain('TRIGGER:-PT0M');
  });

  it('formats durations correctly', () => {
    expect(formatTrigger(0)).toBe('-PT0M');
    expect(formatTrigger(30)).toBe('-PT30M');
    expect(formatTrigger(90)).toBe('-PT1H30M');
    expect(formatTrigger(1440)).toBe('-P1D');
    expect(formatTrigger(10_080)).toBe('-P7D');
    expect(formatTrigger(1470)).toBe('-P1DT30M');
  });
});

describe('escaping and folding (RFC 5545 3.1 and 3.3.11)', () => {
  it('escapes backslashes, semicolons, commas and newlines', () => {
    expect(escapeText('a,b;c\\d')).toBe('a\\,b\\;c\\\\d');
    expect(escapeText('line one\nline two')).toBe('line one\\nline two');
    expect(escapeText('crlf\r\nhere')).toBe('crlf\\nhere');
  });

  it('never emits a raw newline inside a property value', () => {
    const ics = render(occurrences());
    for (const line of ics.split('\r\n')) {
      expect(line.includes('\n')).toBe(false);
    }
    // The multi-line description survives as escaped \n sequences. Checked
    // after unfolding, since a long DESCRIPTION is split across physical lines.
    expect(ics.replace(/\r\n /g, '')).toContain('\\nManaged by Hebrew Dates.');
  });

  it('folds every physical line to at most 75 octets', () => {
    const encoder = new TextEncoder();
    const ics = render(occurrences());
    for (const line of ics.split('\r\n')) {
      expect(encoder.encode(line).length, line).toBeLessThanOrEqual(75);
    }
  });

  it('folds on octet boundaries without splitting a multi-byte character', () => {
    // Hebrew is two bytes per character in UTF-8, so a character-based fold
    // would overflow the octet limit and a naive byte slice would corrupt text.
    const hebrew = `SUMMARY:${'א'.repeat(80)}`;
    const folded = foldLine(hebrew);
    const encoder = new TextEncoder();
    for (const line of folded.split('\r\n')) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
    // Unfolding restores the original exactly, with no replacement characters.
    expect(folded.replace(/\r\n /g, '')).toBe(hebrew);
    expect(folded).not.toContain('�');
  });

  it('leaves short lines untouched', () => {
    expect(foldLine('VERSION:2.0')).toBe('VERSION:2.0');
  });

  it('renders Hebrew titles intact through a full calendar', () => {
    const ics = render(occurrences(), { calendarName: 'תאריכים עבריים' });
    expect(ics.replace(/\r\n /g, '')).toContain('X-WR-CALNAME:תאריכים עבריים');
  });
});

describe('helpers', () => {
  it('formats UTC timestamps without punctuation', () => {
    expect(formatUtcTimestamp(Date.UTC(2027, 3, 16, 16, 8, 12))).toBe('20270416T160812Z');
  });

  it('compacts ISO dates', () => {
    expect(compactDate('2027-04-16')).toBe('20270416');
  });

  it('builds a readable backup filename', () => {
    expect(backupFilename('Family Hebrew Dates', GENERATED_AT)).toBe(
      'family-hebrew-dates-2025-01-15.ics',
    );
    expect(backupFilename('תאריכים', GENERATED_AT)).toBe('hebrew-dates-2025-01-15.ics');
  });
});

describe('a 50-year backup', () => {
  it('renders the full horizon the PRD promises', () => {
    const items = occurrences({ count: 50 });
    expect(items).toHaveLength(50);
    const ics = render(items);
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(50);
    // Spans five decades, which is the point of the backup.
    expect(items[49]!.gregorianDate.year - items[0]!.gregorianDate.year).toBeGreaterThanOrEqual(48);
  });
});
