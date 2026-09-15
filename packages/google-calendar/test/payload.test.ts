/**
 * The Google Calendar payload, pinned field by field.
 *
 * Several of these assertions exist because the failure they guard against is
 * invisible in review and only shows up as a wrong calendar: the exclusive
 * all-day end date, the offset coming from the location rather than the calendar
 * zone, and transparency never becoming opaque.
 */
import { describe, expect, it } from 'vitest';
import {
  confirmLocation,
  generateOccurrences,
  getSeedLocation,
  type DestinationEvent,
} from '@hebrew-dates/engine';
import {
  appManagedEventQuery,
  assertUsableEventId,
  buildExtendedProperties,
  GOOGLE_LIMITS,
  InvalidGoogleEventIdError,
  isUpToDate,
  toGoogleEvent,
  toReminders,
  truncate,
} from '../src/payload';

const NOW = Date.UTC(2025, 0, 15, 12, 0, 0);
const jerusalem = confirmLocation(getSeedLocation('seed:jerusalem')!);
const newYork = confirmLocation(getSeedLocation('seed:new-york')!);
const tromso = confirmLocation(getSeedLocation('seed:tromso')!);

function events(
  overrides: Partial<Parameters<typeof generateOccurrences>[0]> = {},
): DestinationEvent[] {
  const result = generateOccurrences({
    sourceRecordId: 'record-1',
    type: 'birthday',
    displayName: 'David',
    origin: { month: 'NISAN', day: 10 },
    location: jerusalem,
    displayMode: 'exact_sunset',
    count: 3,
    nowEpochMs: NOW,
    destinationCalendarId: 'dest-1',
    ...overrides,
  });
  if (result.status !== 'ok') throw new Error('expected occurrences');
  return result.occurrences;
}

const first = () => events()[0]!;

describe('identity', () => {
  it('uses the engine s deterministic ID', () => {
    const event = first();
    expect(toGoogleEvent(event).id).toBe(event.googleEventId);
  });

  it('produces an ID Google will accept', () => {
    for (const event of events({ count: 20 })) {
      const payload = toGoogleEvent(event);
      expect(payload.id).toMatch(GOOGLE_LIMITS.idAlphabet);
      expect(payload.id.length).toBeGreaterThanOrEqual(GOOGLE_LIMITS.idMinLength);
      expect(payload.id.length).toBeLessThanOrEqual(GOOGLE_LIMITS.idMaxLength);
    }
  });

  it('is byte-identical for the same event, so a retry is a no-op', () => {
    const event = first();
    expect(JSON.stringify(toGoogleEvent(event))).toBe(JSON.stringify(toGoogleEvent(event)));
  });

  it('rejects an ID Google would reject, before the request is made', () => {
    expect(() => assertUsableEventId('abc')).toThrow(InvalidGoogleEventIdError);
    expect(() => assertUsableEventId('HAS-UPPERCASE')).toThrow(/base32hex/);
    expect(() => assertUsableEventId('hasxyz')).toThrow(/base32hex/); // x, y, z are out of range
    expect(() => assertUsableEventId('hd0123')).not.toThrow();
  });

  it('refuses to build a payload around a bad ID', () => {
    const event = { ...first(), googleEventId: 'BAD' };
    expect(() => toGoogleEvent(event)).toThrow(InvalidGoogleEventIdError);
  });
});

describe('timed events (exact sunset mode)', () => {
  const payload = toGoogleEvent(first());

  it('sends dateTime with the offset of the calculation location', () => {
    expect('dateTime' in payload.start).toBe(true);
    if (!('dateTime' in payload.start) || !('dateTime' in payload.end)) return;
    // Jerusalem: +02:00 in winter, +03:00 in summer.
    expect(payload.start.dateTime).toMatch(/\+0[23]:00$/);
    expect(payload.end.dateTime).toMatch(/\+0[23]:00$/);
    expect(Date.parse(payload.end.dateTime) - Date.parse(payload.start.dateTime)).toBeGreaterThan(
      23 * 3_600_000,
    );
  });

  it('sends the destination calendar s own zone as timeZone, not the location s', () => {
    // The two are different things: the offset says when the sun set, the
    // timeZone says how the client should render it.
    const event = events({ calendarTimezoneHint: 'America/New_York' })[0]!;
    const withHint = toGoogleEvent(event);
    if (!('dateTime' in withHint.start)) throw new Error('expected a timed event');
    expect(withHint.start.timeZone).toBe('America/New_York');
    // ...while the instant is still Jerusalem's sunset.
    expect(withHint.start.dateTime).toMatch(/\+0[23]:00$/);
    expect(Date.parse(withHint.start.dateTime)).toBe(event.timing!.startEpochMs);
  });

  it('falls back to the location zone when the calendar zone is unknown', () => {
    const payloadWithoutHint = toGoogleEvent(first());
    if (!('dateTime' in payloadWithoutHint.start)) throw new Error('expected a timed event');
    expect(payloadWithoutHint.start.timeZone).toBe('Asia/Jerusalem');
  });

  it('never loses the instant to a zone conversion', () => {
    for (const event of events({ count: 20, location: newYork })) {
      const mapped = toGoogleEvent(event);
      if (!('dateTime' in mapped.start) || !('dateTime' in mapped.end)) continue;
      expect(Date.parse(mapped.start.dateTime)).toBe(event.timing!.startEpochMs);
      expect(Date.parse(mapped.end.dateTime)).toBe(event.timing!.endEpochMs);
    }
  });
});

describe('all-day events (two-day mode)', () => {
  const event = events({ displayMode: 'two_day_all_day' })[0]!;
  const payload = toGoogleEvent(event);

  it('sends date, not dateTime', () => {
    expect('date' in payload.start).toBe(true);
    expect('dateTime' in payload.start).toBe(false);
  });

  it('sends an EXCLUSIVE end date covering exactly two days', () => {
    if (!('date' in payload.start) || !('date' in payload.end)) return;
    expect(payload.start.date).toBe(event.allDay.startDate);
    expect(payload.end.date).toBe(event.allDay.endDateExclusive);
    const days =
      (Date.parse(`${payload.end.date}T00:00:00Z`) -
        Date.parse(`${payload.start.date}T00:00:00Z`)) /
      86_400_000;
    expect(days).toBe(2);
  });

  it('covers the sunset day and the Hebrew date s daytime', () => {
    if (!('date' in payload.start)) return;
    const startDay = Date.parse(`${payload.start.date}T00:00:00Z`);
    const gregorian = Date.UTC(
      event.gregorianDate.year,
      event.gregorianDate.month - 1,
      event.gregorianDate.day,
    );
    expect(gregorian - startDay).toBe(86_400_000);
  });
});

describe('occurrences with no sunset', () => {
  it('degrades to an all-day event rather than sending an invalid time', () => {
    const polar = events({
      location: tromso,
      origin: { month: 'SIVAN', day: 25 },
      count: 2,
    });
    expect(polar.every((event) => event.timing === null)).toBe(true);

    for (const event of polar) {
      const payload = toGoogleEvent(event);
      expect('date' in payload.start).toBe(true);
      const serialised = JSON.stringify(payload);
      expect(serialised).not.toContain('Invalid');
      expect(serialised).not.toContain('NaN');
      expect(serialised).not.toContain('null');
    }
  });
});

describe('event properties the product depends on', () => {
  it('is always transparent, so it never makes the user look busy', () => {
    for (const event of events({ count: 20 })) {
      expect(toGoogleEvent(event).transparency).toBe('transparent');
    }
  });

  it('defaults visibility to "default", so calendar sharing governs the details', () => {
    expect(toGoogleEvent(first()).visibility).toBe('default');
  });

  it('honours a destination that opted into per-event private visibility', () => {
    const event = events({ visibility: 'private' })[0]!;
    expect(toGoogleEvent(event).visibility).toBe('private');
  });

  it('is confirmed, and never invites anyone', () => {
    const payload = toGoogleEvent(first());
    expect(payload.status).toBe('confirmed');
    expect(payload.guestsCanInviteOthers).toBe(false);
    expect(payload.guestsCanSeeOtherGuests).toBe(false);
  });

  it('carries the title, the description and the calculation location', () => {
    const payload = toGoogleEvent(first());
    expect(payload.summary).toContain("David's Hebrew Birthday");
    expect(payload.description).toContain('Calculation location: Jerusalem');
    expect(payload.description).toMatch(/consult your rabbi/i);
    expect(payload.location).toContain('Jerusalem');
  });

  it('includes a source link when one is supplied', () => {
    const payload = toGoogleEvent(first(), { sourceUrl: 'https://example.test/records/1' });
    expect(payload.source).toEqual({
      title: 'Hebrew Dates',
      url: 'https://example.test/records/1',
    });
    expect(toGoogleEvent(first()).source).toBeUndefined();
  });
});

describe('reminders', () => {
  it('sets explicit overrides and disables calendar defaults', () => {
    const payload = toGoogleEvent(first(), {
      reminders: [{ minutesBeforeStart: 1440 }, { minutesBeforeStart: 0 }],
    });
    expect(payload.reminders.useDefault).toBe(false);
    expect(payload.reminders.overrides).toEqual([
      { method: 'popup', minutes: 0 },
      { method: 'popup', minutes: 1440 },
    ]);
  });

  it('stays silent when the user configured no reminders', () => {
    // Explicitly empty, not "inherit the calendar default": a date the user
    // chose not to be reminded about must not start pinging them.
    const payload = toGoogleEvent(first());
    expect(payload.reminders).toEqual({ useDefault: false, overrides: [] });
  });

  it('skips disabled rules', () => {
    const reminders = toReminders(
      [{ minutesBeforeStart: 60, enabled: false }, { minutesBeforeStart: 1440 }],
      true,
    );
    expect(reminders.overrides).toEqual([{ method: 'popup', minutes: 1440 }]);
  });

  it('rounds to whole days for all-day events, where clients anchor to midnight', () => {
    expect(toReminders([{ minutesBeforeStart: 90 }], false).overrides).toEqual([
      { method: 'popup', minutes: 0 },
    ]);
    expect(toReminders([{ minutesBeforeStart: 1500 }], false).overrides).toEqual([
      { method: 'popup', minutes: 1440 },
    ]);
  });

  it('de-duplicates reminders that collapse onto the same trigger', () => {
    // 30 and 90 minutes both round to "at start" for an all-day event; Google
    // rejects duplicate overrides.
    const reminders = toReminders([{ minutesBeforeStart: 30 }, { minutesBeforeStart: 90 }], false);
    expect(reminders.overrides).toEqual([{ method: 'popup', minutes: 0 }]);
  });

  it('caps at five overrides, which is Google s limit', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ minutesBeforeStart: (i + 1) * 60 }));
    const reminders = toReminders(many, true);
    expect(reminders.overrides).toHaveLength(GOOGLE_LIMITS.maxReminderOverrides);
    // The nearest reminders are kept.
    expect(reminders.overrides![0]).toEqual({ method: 'popup', minutes: 60 });
  });

  it('clamps a reminder beyond four weeks to the maximum Google allows', () => {
    const reminders = toReminders([{ minutesBeforeStart: 99_999 }], true);
    expect(reminders.overrides).toEqual([
      { method: 'popup', minutes: GOOGLE_LIMITS.maxReminderMinutes },
    ]);
  });

  it('ignores nonsense values rather than sending them', () => {
    const reminders = toReminders(
      [
        { minutesBeforeStart: Number.NaN },
        { minutesBeforeStart: -5 },
        { minutesBeforeStart: Number.POSITIVE_INFINITY },
        { minutesBeforeStart: 1440 },
      ],
      true,
    );
    expect(reminders.overrides).toEqual([{ method: 'popup', minutes: 1440 }]);
  });

  it('supports email reminders for a yahrzeit that warrants one', () => {
    const reminders = toReminders([{ minutesBeforeStart: 10_080 }], true, 'email');
    expect(reminders.overrides).toEqual([{ method: 'email', minutes: 10_080 }]);
  });
});

describe('extended properties (provenance and recovery)', () => {
  const event = first();
  const properties = buildExtendedProperties(event);

  it('records everything needed to identify the event without the database', () => {
    expect(properties).toMatchObject({
      app: 'hebrew-dates',
      occurrenceKey: event.key,
      sourceRecordId: event.sourceRecordId,
      destinationCalendarId: event.destinationCalendarId,
      hebrewYear: String(event.hebrewYear),
      sequence: '0',
      ruleApplied: event.ruleApplied,
      calculationVersion: event.calculationVersion,
      contentHash: event.contentHash,
      locationId: event.locationSnapshot.id,
    });
  });

  it('distinguishes the two Adars of one Hebrew year', () => {
    const pair = events({
      type: 'personal_yahrzeit',
      displayName: 'Zayde',
      origin: { month: 'ADAR', day: 10, year: 5785 },
      count: 5,
    }).filter((candidate, _, all) =>
      all.filter((other) => other.hebrewYear === candidate.hebrewYear).length > 1,
    );
    expect(pair.length).toBeGreaterThanOrEqual(2);
    const [adarI, adarII] = pair as [DestinationEvent, DestinationEvent];
    const a = buildExtendedProperties(adarI);
    const b = buildExtendedProperties(adarII);
    expect(a.hebrewYear).toBe(b.hebrewYear);
    expect(a.sequence).toBe('0');
    expect(b.sequence).toBe('1');
    expect(a.occurrenceKey).not.toBe(b.occurrenceKey);
  });

  it('contains nothing sensitive', () => {
    const serialised = JSON.stringify(properties).toLowerCase();
    for (const forbidden of ['david', 'token', 'email', '@', 'refresh']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('keeps every value within Google s length limit', () => {
    for (const value of Object.values(properties)) {
      expect(value.length).toBeLessThanOrEqual(GOOGLE_LIMITS.extendedPropertyValueMaxLength);
    }
  });

  it('gives the reconciler a query for its own events', () => {
    expect(appManagedEventQuery()).toEqual({ privateExtendedProperty: 'app=hebrew-dates' });
    expect(appManagedEventQuery('staging')).toEqual({
      privateExtendedProperty: 'app=staging',
    });
  });

  it('lets a remote event be compared without re-reading every field', () => {
    const remote = { extendedProperties: { private: { contentHash: event.contentHash } } };
    expect(isUpToDate(remote, event)).toBe(true);
    expect(isUpToDate({ extendedProperties: { private: { contentHash: 'stale' } } }, event)).toBe(
      false,
    );
    expect(isUpToDate(null, event)).toBe(false);
    expect(isUpToDate({}, event)).toBe(false);
  });
});

describe('length limits', () => {
  it('truncates an over-long title on a character boundary', () => {
    const event = { ...first(), title: 'א'.repeat(2000) };
    const payload = toGoogleEvent(event);
    expect([...payload.summary]).toHaveLength(GOOGLE_LIMITS.summaryMaxLength);
    expect(payload.summary).not.toContain('�');
  });

  it('truncates an over-long description', () => {
    const event = { ...first(), description: 'x'.repeat(20_000) };
    expect(toGoogleEvent(event).description).toHaveLength(GOOGLE_LIMITS.descriptionMaxLength);
  });

  it('leaves normal content untouched', () => {
    const event = first();
    const payload = toGoogleEvent(event);
    expect(payload.summary).toBe(event.title);
    expect(payload.description).toBe(event.description);
  });

  it('truncate() never splits a multi-byte character', () => {
    const hebrew = 'שלום'.repeat(10);
    const cut = truncate(hebrew, 5);
    expect([...cut]).toHaveLength(5);
    expect(cut).not.toContain('�');
    expect(truncate('short', 50)).toBe('short');
  });
});

describe('a whole horizon maps cleanly', () => {
  it('produces a valid payload for every occurrence of a 20-year horizon', () => {
    const horizon = events({ count: 20 });
    const ids = new Set<string>();
    for (const event of horizon) {
      const payload = toGoogleEvent(event, { reminders: [{ minutesBeforeStart: 1440 }] });
      expect(payload.transparency).toBe('transparent');
      expect(payload.id).toMatch(GOOGLE_LIMITS.idAlphabet);
      expect(payload.summary.length).toBeGreaterThan(0);
      expect(payload.extendedProperties.private.app).toBe('hebrew-dates');
      ids.add(payload.id);
    }
    expect(ids.size).toBe(horizon.length);
  });

  it('gives two family members distinct payload IDs for the same anniversary', () => {
    const mine = events({ destinationCalendarId: 'dest-a' })[0]!;
    const theirs = events({ destinationCalendarId: 'dest-b' })[0]!;
    expect(mine.key).toBe(theirs.key);
    expect(toGoogleEvent(mine).id).not.toBe(toGoogleEvent(theirs).id);
    // ...and each records which calendar it belongs to.
    expect(toGoogleEvent(mine).extendedProperties.private.destinationCalendarId).toBe('dest-a');
  });
});
