import { backupFilename, renderCalendar } from '@hebrew-dates/ical';
import { buildPreview, type PreviewRequest } from '@/lib/preview';
import type { DisplayMode, HebrewMonthName, SourceRecordType, SunsetStatus } from '@hebrew-dates/engine';

/**
 * Downloadable `.ics` for one record (PRD 8.5, the 50-year backup).
 *
 * A GET so it can be a plain link, and so the file can be imported into a real
 * calendar without any account, token or OAuth grant. Rendered from the same
 * occurrences and the same content builder that live synchronisation will use,
 * so a backup can never disagree with the calendar.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_REMINDERS = {
  birthday: [{ minutesBeforeStart: 1440, description: 'Hebrew birthday tomorrow' }, { minutesBeforeStart: 0, description: 'Hebrew birthday begins at sunset' }],
  personal_yahrzeit: [
    { minutesBeforeStart: 10_080, description: 'Yahrzeit in one week' },
    { minutesBeforeStart: 1440, description: 'Yahrzeit tomorrow' },
    { minutesBeforeStart: 0, description: 'Yahrzeit begins at sunset' },
  ],
  famous_yahrzeit: [{ minutesBeforeStart: 1440, description: 'Yahrzeit tomorrow' }],
} as const;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const type = (params.get('type') ?? 'birthday') as SourceRecordType;

  const previewRequest: PreviewRequest = {
    locationId: params.get('locationId') ?? 'seed:jerusalem',
    type,
    displayName: params.get('displayName') ?? 'Untitled',
    displayMode: (params.get('displayMode') ?? 'exact_sunset') as DisplayMode,
    entryMode: params.get('entryMode') === 'gregorian' ? 'gregorian' : 'hebrew',
    ...(params.get('hebrewMonth') ? { hebrewMonth: params.get('hebrewMonth') as HebrewMonthName } : {}),
    ...(params.get('hebrewDay') ? { hebrewDay: Number(params.get('hebrewDay')) } : {}),
    ...(params.get('hebrewYear') ? { hebrewYear: Number(params.get('hebrewYear')) } : {}),
    ...(params.get('gregorianDate') ? { gregorianDate: params.get('gregorianDate')! } : {}),
    ...(params.get('sunsetStatus') ? { sunsetStatus: params.get('sunsetStatus') as SunsetStatus } : {}),
    // The PRD's backup horizon is 50 years, longer than the 20-year rolling
    // horizon, because the backup is the "application shuts down" mitigation.
    count: Math.min(Number(params.get('count') ?? 50) || 50, 50),
  };

  const preview = buildPreview(previewRequest);

  // An unresolved date must not silently produce an empty calendar file.
  if (preview.status === 'error') {
    return new Response(preview.message, { status: 400 });
  }
  if (preview.status === 'needs_user_decision') {
    return new Response(`${preview.question}\n\n${preview.explanation}`, { status: 409 });
  }

  const generatedAtEpochMs = Date.now();
  const calendarName = `Hebrew Dates — ${previewRequest.displayName}`;
  const ics = renderCalendar({
    calendarName,
    occurrences: preview.occurrences,
    displayMode: previewRequest.displayMode,
    timezoneId: preview.location.timezoneId,
    generatedAtEpochMs,
    reminders: [...(DEFAULT_REMINDERS[type] ?? DEFAULT_REMINDERS.birthday)],
  });

  return new Response(ics, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${backupFilename(calendarName, generatedAtEpochMs)}"`,
      // A backup is a snapshot of personal data; never let a proxy keep it.
      'cache-control': 'private, no-store',
    },
  });
}
