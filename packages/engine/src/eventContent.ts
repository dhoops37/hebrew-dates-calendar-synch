/**
 * Calendar event titles and descriptions (PRD 28).
 *
 * Kept in the engine, not in the Google/iCal adapters, because the content hash
 * is computed over exactly this output. If two destinations rendered titles
 * differently, reconciliation would flap.
 */
import type { DisplayMode, HebrewDate, SourceRecordType } from './types';
import { formatHebrewDateEnglish, formatHebrewDateHebrew } from './format';

export interface EventContentInput {
  type: SourceRecordType;
  displayName: string;
  hebrewDate: HebrewDate;
  displayMode: DisplayMode;
  locationDisplayName: string;
  /** RFC 3339 start/end, or null in Two-Day All-Day Mode. */
  startIso: string | null;
  endIso: string | null;
  /** Civil dates the event visually covers, "YYYY-MM-DD". */
  startDate: string;
  endDate: string;
  notes?: string;
  customTitle?: string;
  language?: 'en' | 'he';
}

const DISCLAIMER =
  'Times indicate calculated local sunset for calendar purposes. For questions ' +
  'concerning precise halachic observance, follow your family custom or consult your rabbi.';

export function eventTitle(input: EventContentInput): string {
  if (input.customTitle) return input.customTitle;
  const hebrewDate =
    input.language === 'he'
      ? formatHebrewDateHebrew(input.hebrewDate)
      : formatHebrewDateEnglish(input.hebrewDate);
  switch (input.type) {
    case 'birthday':
      return `${input.displayName}'s Hebrew Birthday — ${hebrewDate}`;
    case 'personal_yahrzeit':
      return `\u{1F56F} Yahrzeit: ${input.displayName} — ${hebrewDate}`;
    case 'famous_yahrzeit':
      return `\u{1F56F} ${input.displayName} — Yahrzeit`;
  }
}

export function eventDescription(input: EventContentInput): string {
  const lines: string[] = [];
  lines.push(`Hebrew date: ${formatHebrewDateEnglish(input.hebrewDate, true)}`);
  if (input.displayMode === 'exact_sunset' && input.startIso && input.endIso) {
    lines.push(`Begins: ${input.startIso} (local sunset)`);
    lines.push(`Ends: ${input.endIso} (local sunset)`);
  } else {
    lines.push(
      `Begins at sunset on ${input.startDate} and continues until sunset on ${input.endDate}.`,
    );
  }
  lines.push(`Calculation location: ${input.locationDisplayName}`);
  lines.push(
    `Display mode: ${input.displayMode === 'exact_sunset' ? 'Exact sunset times' : 'Across both calendar days'}`,
  );
  if (input.notes) {
    lines.push('');
    lines.push(input.notes);
  }
  lines.push('');
  lines.push('Managed by Hebrew Dates.');
  lines.push(DISCLAIMER);
  return lines.join('\n');
}
