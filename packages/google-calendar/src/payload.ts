import type { DestinationEvent } from '@hebrew-dates/engine';

/**
 * Google Calendar API limits this mapper defends against.
 *
 * These are the documented or widely observed ceilings. They are enforced here
 * rather than discovered at run time, because a 400 from Google on event 400 of
 * a 600-event first sync is a miserable way to find out.
 */
export const GOOGLE_LIMITS = {
  /** Event IDs: base32hex, 5-1024 characters. */
  idMinLength: 5,
  idMaxLength: 1024,
  idAlphabet: /^[a-v0-9]+$/,
  /** Practical ceiling for `summary`; Google truncates rather than rejecting. */
  summaryMaxLength: 1024,
  /** `description` is limited to 8 KiB. */
  descriptionMaxLength: 8192,
  /** At most 5 reminder overrides per event. */
  maxReminderOverrides: 5,
  /** Reminder minutes must be 0..40320 (four weeks). */
  maxReminderMinutes: 40_320,
  /** Extended-property values are limited to 1024 characters each. */
  extendedPropertyValueMaxLength: 1024,
} as const;

/** A reminder as the user configured it. */
export interface ReminderRule {
  minutesBeforeStart: number;
  enabled?: boolean;
}

export interface GoogleEventDateTime {
  dateTime: string;
  timeZone: string;
}

export interface GoogleEventDate {
  date: string;
}

/**
 * The subset of Google's `Event` resource this app writes. Deliberately not a
 * full mirror of the API type: anything absent here is something the app has
 * decided not to set.
 */
export interface GoogleEventPayload {
  id: string;
  summary: string;
  description: string;
  location?: string;
  start: GoogleEventDateTime | GoogleEventDate;
  end: GoogleEventDateTime | GoogleEventDate;
  transparency: 'transparent';
  visibility: 'default' | 'private';
  status: 'confirmed';
  reminders: {
    useDefault: boolean;
    overrides?: { method: 'popup' | 'email'; minutes: number }[];
  };
  extendedProperties: {
    private: Record<string, string>;
  };
  source?: { title: string; url: string };
  /** Guests are never invited to these events; they are personal markers. */
  guestsCanInviteOthers: false;
  guestsCanSeeOtherGuests: false;
}

export interface ToGoogleEventOptions {
  reminders?: ReminderRule[];
  reminderMethod?: 'popup' | 'email';
  /** A link back to the record in Hebrew Dates, shown by some clients. */
  sourceUrl?: string;
  /** Marker written to every event so the app can find its own work. */
  appId?: string;
}

const DEFAULT_APP_ID = 'hebrew-dates';

/**
 * Map one rendered occurrence to a Google Calendar event resource.
 *
 * The same payload is used for `insert` and `patch`: Google accepts a full body
 * on a patch, and sending the whole thing means a patch can never leave a stale
 * field behind from an earlier version of the app.
 */
export function toGoogleEvent(
  event: DestinationEvent,
  options: ToGoogleEventOptions = {},
): GoogleEventPayload {
  assertUsableEventId(event.googleEventId);

  // Two independent reasons to send an all-day event:
  //   1. the destination is configured for the two-day all-day display;
  //   2. the sun does not set there on these dates, so there is no window to
  //      send - degrade rather than write an invalid time.
  const timed = event.displayMode === 'exact_sunset' && event.timing !== null;
  const start: GoogleEventDateTime | GoogleEventDate = timed
    ? { dateTime: event.timing!.startIso, timeZone: event.displayTimezoneId }
    : { date: event.allDay.startDate };
  const end: GoogleEventDateTime | GoogleEventDate = timed
    ? { dateTime: event.timing!.endIso, timeZone: event.displayTimezoneId }
    : // Exclusive, so a two-day span ends on the day after the second day.
      { date: event.allDay.endDateExclusive };

  return {
    id: event.googleEventId,
    summary: truncate(event.title, GOOGLE_LIMITS.summaryMaxLength),
    description: truncate(event.description, GOOGLE_LIMITS.descriptionMaxLength),
    ...(event.locationSnapshot.displayName
      ? { location: truncate(event.locationSnapshot.displayName, GOOGLE_LIMITS.summaryMaxLength) }
      : {}),
    start,
    end,
    // A Hebrew date is not an appointment: never make the user look busy.
    transparency: 'transparent',
    // 'default' means the calendar's own sharing settings govern who sees this.
    visibility: event.visibility,
    status: 'confirmed',
    reminders: toReminders(options.reminders ?? [], timed, options.reminderMethod ?? 'popup'),
    extendedProperties: {
      private: buildExtendedProperties(event, options.appId ?? DEFAULT_APP_ID),
    },
    ...(options.sourceUrl ? { source: { title: 'Hebrew Dates', url: options.sourceUrl } } : {}),
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
  };
}

/**
 * Reminder overrides.
 *
 * An all-day event has no time of day, so clients anchor a relative trigger to
 * midnight; only whole-day offsets behave predictably, and the same rounding is
 * applied in the iCalendar renderer so the two destinations agree.
 */
export function toReminders(
  rules: ReminderRule[],
  timed: boolean,
  method: 'popup' | 'email' = 'popup',
): GoogleEventPayload['reminders'] {
  const minutes = rules
    .filter((rule) => rule.enabled !== false)
    .map((rule) => (timed ? rule.minutesBeforeStart : roundToWholeDays(rule.minutesBeforeStart)))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.min(Math.round(value), GOOGLE_LIMITS.maxReminderMinutes));

  // De-duplicate: rounding all-day reminders can collapse several rules onto
  // the same trigger, and Google rejects duplicates.
  const unique = [...new Set(minutes)].sort((a, b) => a - b);

  if (unique.length === 0) {
    // Explicitly no reminders, rather than inheriting the calendar's defaults:
    // a birthday the user chose not to be reminded about must stay silent.
    return { useDefault: false, overrides: [] };
  }

  return {
    useDefault: false,
    overrides: unique
      .slice(0, GOOGLE_LIMITS.maxReminderOverrides)
      .map((value) => ({ method, minutes: value })),
  };
}

/**
 * Provenance, written to every event.
 *
 * Queryable with `privateExtendedProperty=key%3Dvalue`, which is how the
 * reconciler finds events it has lost the database mapping for — after a
 * restore, say. Nothing here is sensitive: no names, no dates of death beyond
 * the Hebrew date already visible in the event itself.
 */
export function buildExtendedProperties(
  event: DestinationEvent,
  appId = DEFAULT_APP_ID,
): Record<string, string> {
  const properties: Record<string, string> = {
    app: appId,
    occurrenceKey: event.key,
    sourceRecordId: event.sourceRecordId,
    destinationCalendarId: event.destinationCalendarId,
    hebrewYear: String(event.hebrewYear),
    sequence: String(event.sequence),
    hebrewMonth: String(event.hebrewDate.month),
    hebrewDay: String(event.hebrewDate.day),
    ruleApplied: event.ruleApplied,
    calculationVersion: event.calculationVersion,
    contentHash: event.contentHash,
    locationId: event.locationSnapshot.id,
  };
  for (const [key, value] of Object.entries(properties)) {
    properties[key] = truncate(value, GOOGLE_LIMITS.extendedPropertyValueMaxLength);
  }
  return properties;
}

/** The query Google needs to list every event this app manages on a calendar. */
export function appManagedEventQuery(appId = DEFAULT_APP_ID): { privateExtendedProperty: string } {
  return { privateExtendedProperty: `app=${appId}` };
}

/**
 * Whether a Google event still matches what we intend, judged by the content
 * hash we stamped on it. Lets the reconciler detect an event a user edited by
 * hand in Google without re-reading every field.
 */
export function isUpToDate(
  remote: { extendedProperties?: { private?: Record<string, string> } } | null | undefined,
  event: DestinationEvent,
): boolean {
  const hash = remote?.extendedProperties?.private?.contentHash;
  return typeof hash === 'string' && hash === event.contentHash;
}

export class InvalidGoogleEventIdError extends Error {}

/**
 * Google's event-ID rules, checked before a request is built rather than after
 * it is rejected.
 */
export function assertUsableEventId(id: string): void {
  if (id.length < GOOGLE_LIMITS.idMinLength || id.length > GOOGLE_LIMITS.idMaxLength) {
    throw new InvalidGoogleEventIdError(
      `Google event ID must be ${GOOGLE_LIMITS.idMinLength}-${GOOGLE_LIMITS.idMaxLength} ` +
        `characters; got ${id.length}`,
    );
  }
  if (!GOOGLE_LIMITS.idAlphabet.test(id)) {
    throw new InvalidGoogleEventIdError(
      `Google event ID must be base32hex ([a-v0-9]); got "${id}"`,
    );
  }
}

function roundToWholeDays(minutes: number): number {
  if (minutes === 0) return 0;
  return Math.round(minutes / 1440) * 1440;
}

/**
 * Truncate on a code-point boundary, so a multi-byte character — Hebrew is two
 * bytes in UTF-8 — is never split into a replacement character.
 */
export function truncate(value: string, maxLength: number): string {
  const points = [...value];
  if (points.length <= maxLength) return value;
  return points.slice(0, maxLength).join('');
}
