/**
 * @hebrew-dates/ical
 *
 * Renders generated occurrences as an RFC 5545 calendar. Used for two things:
 *
 *   1. The 50-year `.ics` backup (PRD 8.5), which is the mitigation for
 *      "the application shuts down" and for "Google authorization revoked".
 *   2. The private subscription feed for Apple Calendar (PRD 12.2), in Phase 4.
 *
 * Both come from the same renderer over the same occurrences, so a backup can
 * never disagree with what the live feed would have said.
 *
 * ## Decisions worth knowing about
 *
 * **Timed events are emitted in UTC (`...Z`), not with a `TZID`.** A `TZID`
 * reference obliges the file to carry a full `VTIMEZONE` component including
 * historical daylight-saving rules, and a wrong or stale `VTIMEZONE` shifts
 * every event by an hour in a way that is very hard to notice. A UTC instant is
 * unambiguous and every tested client renders it in the viewer's own zone. The
 * consequence, which is correct but worth stating: a subscriber travelling
 * abroad sees the event at the local time *equivalent* to sunset back home,
 * because that is the moment the Hebrew date actually began. The calculation
 * location and both sunset times are named in the description either way.
 *
 * **All-day `DTEND` is exclusive** (`VALUE=DATE`), per RFC 5545 3.8.2.2. A
 * two-day event covering the 16th and 17th ends on the 18th.
 *
 * **`UID` is the occurrence key**, so re-importing a backup updates the same
 * events rather than duplicating them — the same property that makes
 * synchronisation idempotent.
 */
import type { DisplayMode, Occurrence } from '@hebrew-dates/engine';

export interface IcsReminder {
  /** Minutes before the event start. 0 means at the start. */
  minutesBeforeStart: number;
  description?: string;
}

export interface RenderCalendarOptions {
  /** Shown by clients as the calendar name. */
  calendarName: string;
  occurrences: Occurrence[];
  displayMode: DisplayMode;
  /** IANA zone of the calculation location, advertised to clients as a hint. */
  timezoneId: string;
  /**
   * Injected so output is byte-stable in tests and so a regenerated backup with
   * unchanged content produces an unchanged file.
   */
  generatedAtEpochMs: number;
  reminders?: IcsReminder[];
  /** Bumped when the content of an event changes, per RFC 5545 3.8.7.4. */
  sequence?: number;
  /** How often a subscribing client is asked to refresh. */
  refreshIntervalHours?: number;
  /** Domain used in UIDs. Must be stable forever. */
  uidDomain?: string;
}

const PRODID = '-//Hebrew Dates//Calculation Engine 1.0//EN';

export function renderCalendar(options: RenderCalendarOptions): string {
  const {
    calendarName,
    occurrences,
    displayMode,
    timezoneId,
    generatedAtEpochMs,
    reminders = [],
    sequence = 0,
    refreshIntervalHours = 24,
    uidDomain = 'hebrewdates.app',
  } = options;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${escapeText(timezoneId)}`,
    `X-WR-CALDESC:${escapeText(
      `Hebrew birthdays and yahrzeits, calculated for ${timezoneId}. Managed by Hebrew Dates.`,
    )}`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refreshIntervalHours}H`,
    `X-PUBLISHED-TTL:PT${refreshIntervalHours}H`,
  ];

  for (const occurrence of occurrences) {
    lines.push(
      ...renderEvent({
        occurrence,
        displayMode,
        generatedAtEpochMs,
        reminders,
        sequence,
        uidDomain,
      }),
    );
  }

  lines.push('END:VCALENDAR');

  // RFC 5545 requires CRLF line endings and lines folded at 75 octets.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

interface RenderEventArgs {
  occurrence: Occurrence;
  displayMode: DisplayMode;
  generatedAtEpochMs: number;
  reminders: IcsReminder[];
  sequence: number;
  uidDomain: string;
}

function renderEvent(args: RenderEventArgs): string[] {
  const { occurrence, displayMode, generatedAtEpochMs, reminders, sequence, uidDomain } = args;

  // An occurrence with no sunset (polar latitudes) cannot be a timed event, so
  // it degrades to the all-day representation rather than being dropped.
  const timed = displayMode === 'exact_sunset' && occurrence.timing !== null;

  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${occurrence.key}@${uidDomain}`,
    `DTSTAMP:${formatUtcTimestamp(generatedAtEpochMs)}`,
    `SEQUENCE:${sequence}`,
  ];

  if (timed) {
    lines.push(`DTSTART:${formatUtcTimestamp(occurrence.timing!.startEpochMs)}`);
    lines.push(`DTEND:${formatUtcTimestamp(occurrence.timing!.endEpochMs)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(occurrence.allDay.startDate)}`);
    // Exclusive, per RFC 5545 3.8.2.2.
    lines.push(`DTEND;VALUE=DATE:${compactDate(occurrence.allDay.endDateExclusive)}`);
  }

  lines.push(`SUMMARY:${escapeText(occurrence.title)}`);
  lines.push(`DESCRIPTION:${escapeText(occurrence.description)}`);
  lines.push(`LOCATION:${escapeText(occurrence.locationSnapshot.displayName)}`);
  // A Hebrew date is not an appointment; it must not make the user look busy.
  lines.push('TRANSP:TRANSPARENT');
  lines.push('STATUS:CONFIRMED');
  // Non-standard properties carry the provenance the PRD wants for error
  // reports (34) without putting anything sensitive in the file.
  lines.push(`X-HEBREW-DATES-OCCURRENCE-KEY:${occurrence.key}`);
  lines.push(`X-HEBREW-DATES-HEBREW-YEAR:${occurrence.hebrewYear}`);
  lines.push(`X-HEBREW-DATES-RULE:${occurrence.ruleApplied}`);
  lines.push(`X-HEBREW-DATES-CALC-VERSION:${occurrence.calculationVersion}`);

  for (const reminder of reminders) {
    lines.push(...renderAlarm(reminder, timed));
  }

  lines.push('END:VEVENT');
  return lines;
}

function renderAlarm(reminder: IcsReminder, timed: boolean): string[] {
  // An all-day event has no time of day, so clients anchor a relative trigger
  // to midnight. Whole-day offsets are the only ones that behave predictably.
  const minutes = timed ? reminder.minutesBeforeStart : roundToWholeDays(reminder.minutesBeforeStart);
  return [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `TRIGGER:${formatTrigger(minutes)}`,
    `DESCRIPTION:${escapeText(reminder.description ?? 'Hebrew Dates reminder')}`,
    'END:VALARM',
  ];
}

function roundToWholeDays(minutes: number): number {
  if (minutes === 0) return 0;
  return Math.round(minutes / 1440) * 1440;
}

/** RFC 5545 duration, negative meaning "before the start". */
export function formatTrigger(minutesBeforeStart: number): string {
  if (minutesBeforeStart <= 0) return '-PT0M';
  const days = Math.floor(minutesBeforeStart / 1440);
  const remainder = minutesBeforeStart % 1440;
  const hours = Math.floor(remainder / 60);
  const minutes = remainder % 60;
  let duration = '-P';
  if (days > 0) duration += `${days}D`;
  if (hours > 0 || minutes > 0) {
    duration += 'T';
    if (hours > 0) duration += `${hours}H`;
    if (minutes > 0) duration += `${minutes}M`;
  }
  return duration === '-P' ? '-PT0M' : duration;
}

/** `20270416T160812Z` — always UTC, so no VTIMEZONE is required. */
export function formatUtcTimestamp(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** `2027-04-16` → `20270416`. */
export function compactDate(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}

/** RFC 5545 3.3.11: backslash, semicolon, comma and newline are escaped. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

/**
 * RFC 5545 3.1: fold at 75 **octets**, continuing with a single space.
 * Hebrew is multi-byte in UTF-8, so folding by character count would produce
 * over-long lines, and splitting mid-sequence would corrupt the text. This
 * folds on octet boundaries while keeping each code point intact.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  // 75 octets for the first line; continuations spend one octet on the leading
  // space, so their payload is 74.
  let limit = 75;

  for (const codePoint of line) {
    const size = encoder.encode(codePoint).length;
    if (currentBytes + size > limit) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
      limit = 74;
    }
    current += codePoint;
    currentBytes += size;
  }
  if (current) chunks.push(current);

  return chunks.join('\r\n ');
}

/** Suggested download filename for a backup. */
export function backupFilename(calendarName: string, generatedAtEpochMs: number): string {
  const slug = calendarName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  const date = new Date(generatedAtEpochMs).toISOString().slice(0, 10);
  return `${slug || 'hebrew-dates'}-${date}.ics`;
}
