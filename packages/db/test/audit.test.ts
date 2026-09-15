/**
 * The audit log's value guard.
 *
 * These are the tests that matter for this table, and they are all negative:
 * a developer who tries to log a person's name, a relationship, a pair of
 * coordinates, a token or a feed secret must be stopped — at build time by the
 * union, and at run time by the projection for the cases where the types were
 * defeated (a JSON round trip, a value read from a request body, an `as never`).
 *
 * Pure, so they run without a database. `audit-integration.test.ts` covers the
 * writer against real Postgres.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  UnsafeAuditValueError,
  toDetail,
  type AuditEvent,
} from '../src/audit';

/** Cast through `unknown` to simulate types being defeated at a call site. */
const hostile = (value: unknown): AuditEvent => value as AuditEvent;

describe('the action vocabulary', () => {
  it('is closed', () => {
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(10);
    // Every action is a dotted lower-case identifier, so the column can never
    // hold a sentence.
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('refuses an action nobody declared', () => {
    expect(() =>
      toDetail(hostile({ action: 'user.exported_everything', subjectType: 'user', subjectId: 'x' })),
    ).toThrow(UnsafeAuditValueError);
    expect(() => toDetail(hostile({ action: 'date.created.extra' }))).toThrow(
      /not a known audit action/,
    );
  });

  it('has no duplicate actions', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});

describe('the projection', () => {
  it('copies only the keys the action declares', () => {
    const detail = toDetail({
      action: 'date.created',
      subjectType: 'source_record',
      subjectId: 'record-1',
      recordType: 'personal_yahrzeit',
      hebrewMonth: 'NISAN',
      hebrewDay: 14,
      hasOriginalYear: true,
      enteredAsGregorian: false,
    });

    expect(detail).toEqual({
      recordType: 'personal_yahrzeit',
      hebrewMonth: 'NISAN',
      hebrewDay: 14,
      hasOriginalYear: true,
      enteredAsGregorian: false,
    });
  });

  it('drops a field smuggled onto the object', () => {
    // The realistic version of this is someone spreading a record row into the
    // event. The projection copies by name, so nothing extra survives.
    const detail = toDetail(
      hostile({
        action: 'date.created',
        subjectType: 'source_record',
        subjectId: 'record-1',
        recordType: 'birthday',
        hebrewMonth: 'SIVAN',
        hebrewDay: 6,
        hasOriginalYear: false,
        enteredAsGregorian: false,
        // All of these are real columns on source_records.
        display_name: 'Avraham ben Yitzchak',
        hebrew_name: 'אברהם בן יצחק',
        relationship: 'Grandfather',
        notes: 'Buried in Har HaMenuchot',
        original_hebrew_year: 5750,
      }),
    );

    expect(Object.keys(detail).sort()).toEqual([
      'enteredAsGregorian',
      'hasOriginalYear',
      'hebrewDay',
      'hebrewMonth',
      'recordType',
    ]);
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain('Avraham');
    expect(serialised).not.toContain('Grandfather');
    expect(serialised).not.toContain('Har HaMenuchot');
    expect(serialised).not.toContain('5750');
  });

  it('omits an absent optional field rather than writing null', () => {
    const withoutGeocoder = toDetail({
      action: 'location.confirmed',
      subjectType: 'destination_calendar',
      subjectId: 'calendar-1',
      timezoneId: 'Asia/Jerusalem',
      source: 'user_selected',
    });
    expect(withoutGeocoder).toEqual({ timezoneId: 'Asia/Jerusalem', source: 'user_selected' });
    expect('geocoder' in withoutGeocoder).toBe(false);

    const withGeocoder = toDetail({
      action: 'location.confirmed',
      subjectType: 'destination_calendar',
      subjectId: 'calendar-1',
      timezoneId: 'Asia/Jerusalem',
      source: 'geocoded',
      geocoder: 'nominatim',
    });
    expect(withGeocoder.geocoder).toBe('nominatim');
  });
});

describe('what cannot be recorded', () => {
  /** Each case is a real field of this product that must never be kept. */
  const forbidden: [string, unknown][] = [
    ['a display name', 'Avraham ben Yitzchak'],
    ['a Hebrew name', 'אברהם בן יצחק'],
    ['a relationship phrase', 'my wife’s grandfather'],
    ['a free-text note', 'He was born in Vilna and died in Jerusalem.'],
    ['an email address with a display part', 'David Hoops <dhoops@example.com>'],
    ['a refresh token', '1//0gWj8xQZ_example_refresh_token'],
    ['a session cookie value', 'aVeryLongBase64UrlTokenValue=='],
    ['a feed secret in a URL', 'https://hebrewdates.app/feed/abc?secret=xyz&t=1'],
    ['a latitude/longitude pair', '31.7781, 35.2352'],
    ['an object', { latitude: 31.7781, longitude: 35.2352 }],
    ['an array', ['Avraham', 'Yitzchak']],
    ['null', null],
    ['a nested structure', { token: { refresh: 'secret' } }],
  ];

  it.each(forbidden)('refuses %s', (_label, value) => {
    expect(() =>
      toDetail(
        hostile({
          action: 'calendar.created',
          subjectType: 'destination_calendar',
          subjectId: 'calendar-1',
          googleCalendarId: value,
        }),
      ),
    ).toThrow(UnsafeAuditValueError);
  });

  it('refuses a value long enough to be prose', () => {
    expect(() =>
      toDetail(
        hostile({
          action: 'job.failed',
          subjectType: 'sync_job',
          subjectId: 'job-1',
          jobType: 'reconcile',
          failureKind: 'x'.repeat(400),
        }),
      ),
    ).toThrow(/characters/);
  });

  it('refuses a non-finite number', () => {
    expect(() =>
      toDetail(
        hostile({
          action: 'sync.completed',
          subjectType: 'destination_calendar',
          subjectId: 'calendar-1',
          created: Number.NaN,
          updated: 0,
          deleted: 0,
          failed: 0,
        }),
      ),
    ).toThrow(UnsafeAuditValueError);
  });

  it('explains why, so the developer knows what to do instead', () => {
    const message = (() => {
      try {
        toDetail(
          hostile({
            action: 'date.created',
            subjectType: 'source_record',
            subjectId: 'r',
            recordType: 'birthday',
            hebrewMonth: 'Some Month Name',
            hebrewDay: 1,
            hasOriginalYear: false,
            enteredAsGregorian: false,
          }),
        );
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('date.created.hebrewMonth');
    expect(message).toContain('free text is where a name ends up');
  });
});

describe('what can be recorded', () => {
  it('accepts a space-separated scope list, which is the one value with spaces', () => {
    const detail = toDetail({
      action: 'account.created',
      subjectType: 'google_account',
      subjectId: 'account-1',
      grantedScopes:
        'openid https://www.googleapis.com/auth/userinfo.email ' +
        'https://www.googleapis.com/auth/calendar.app.created',
      scopeSufficient: true,
    });
    expect(detail.grantedScopes).toContain('calendar.app.created');
  });

  it('accepts a Google calendar id, a UUID and an IANA zone', () => {
    expect(
      toDetail({
        action: 'calendar.created',
        subjectType: 'destination_calendar',
        subjectId: 'f3c8a1d2-0000-4000-8000-000000000001',
        googleCalendarId: 'hebrew-dates-9d045b7741bd@group.calendar.google.com',
      }).googleCalendarId,
    ).toContain('@group.calendar.google.com');

    expect(
      toDetail({
        action: 'location.confirmed',
        subjectType: 'destination_calendar',
        subjectId: 'calendar-1',
        timezoneId: 'America/Argentina/Buenos_Aires',
        source: 'geocoded',
      }).timezoneId,
    ).toBe('America/Argentina/Buenos_Aires');
  });

  it('accepts a comma-separated list of changed field names', () => {
    // Which fields changed, never their values.
    const detail = toDetail({
      action: 'date.edited',
      subjectType: 'source_record',
      subjectId: 'record-1',
      changedFields: 'displayName,hebrewDay,notes',
      dateChanged: true,
      occurrencesRegenerated: 20,
    });
    expect(detail.changedFields).toBe('displayName,hebrewDay,notes');
  });

  it('accepts counts and booleans', () => {
    const detail = toDetail({
      action: 'date.deleted',
      subjectType: 'source_record',
      subjectId: 'record-1',
      futureEventsRemoved: 18,
      pastEventsKept: 2,
    });
    expect(detail).toEqual({ futureEventsRemoved: 18, pastEventsKept: 2 });
  });

  it('accepts an IP prefix', () => {
    expect(
      toDetail({
        action: 'auth.rate_limited',
        subjectType: 'user',
        subjectId: null,
        ipPrefix: '203.0.113',
        attempts: 31,
      }),
    ).toEqual({ ipPrefix: '203.0.113', attempts: 31 });
  });
});

describe('every declared action', () => {
  it('produces only safe primitives', () => {
    // A blunt sweep over the whole vocabulary: whatever each variant declares,
    // the emitted detail must be flat and primitive. This is what stops a new
    // variant being added with an object field.
    const samples: AuditEvent[] = [
      {
        action: 'account.created',
        subjectType: 'google_account',
        subjectId: 'a',
        grantedScopes: 'openid',
        scopeSufficient: true,
      },
      {
        action: 'google.reconnected',
        subjectType: 'google_account',
        subjectId: 'a',
        grantedScopes: 'openid',
        scopeSufficient: false,
      },
      {
        action: 'google.disconnected',
        subjectType: 'google_account',
        subjectId: 'a',
        revokedAtGoogle: true,
        calendarDeleted: false,
      },
      {
        action: 'google.needs_reauth',
        subjectType: 'google_account',
        subjectId: 'a',
        reason: 'revoked',
      },
      {
        action: 'calendar.created',
        subjectType: 'destination_calendar',
        subjectId: 'c',
        googleCalendarId: 'x@group.calendar.google.com',
      },
      {
        action: 'calendar.recreated',
        subjectType: 'destination_calendar',
        subjectId: 'c',
        googleCalendarId: 'x@group.calendar.google.com',
        reason: 'deleted_in_google',
      },
      { action: 'calendar.deleted', subjectType: 'destination_calendar', subjectId: 'c' },
      {
        action: 'location.confirmed',
        subjectType: 'destination_calendar',
        subjectId: 'c',
        timezoneId: 'UTC',
        source: 'user_selected',
      },
      {
        action: 'date.created',
        subjectType: 'source_record',
        subjectId: 'r',
        recordType: 'birthday',
        hebrewMonth: 'NISAN',
        hebrewDay: 1,
        hasOriginalYear: false,
        enteredAsGregorian: false,
      },
      {
        action: 'date.edited',
        subjectType: 'source_record',
        subjectId: 'r',
        changedFields: 'displayName',
        dateChanged: false,
        occurrencesRegenerated: 0,
      },
      { action: 'date.paused', subjectType: 'source_record', subjectId: 'r', active: false },
      {
        action: 'date.deleted',
        subjectType: 'source_record',
        subjectId: 'r',
        futureEventsRemoved: 1,
        pastEventsKept: 0,
      },
      {
        action: 'sync.completed',
        subjectType: 'destination_calendar',
        subjectId: 'c',
        created: 1,
        updated: 2,
        deleted: 3,
        failed: 0,
      },
      {
        action: 'job.failed',
        subjectType: 'sync_job',
        subjectId: 'j',
        jobType: 'reconcile',
        failureKind: 'google.transient',
      },
      {
        action: 'auth.rate_limited',
        subjectType: 'user',
        subjectId: null,
        ipPrefix: '198.51.100',
        attempts: 5,
      },
    ];

    // Every action must have a sample, so adding a variant without covering it
    // fails here rather than shipping unexercised.
    expect(samples.map((sample) => sample.action).sort()).toEqual([...AUDIT_ACTIONS].sort());

    for (const sample of samples) {
      const detail = toDetail(sample);
      for (const [key, value] of Object.entries(detail)) {
        expect(
          ['string', 'number', 'boolean'].includes(typeof value),
          `${sample.action}.${key} is ${typeof value}`,
        ).toBe(true);
      }
    }
  });
});
