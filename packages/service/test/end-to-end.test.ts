/**
 * The whole flow, end to end.
 *
 * Sign in with Google → confirm a location → add a Hebrew date → a dedicated
 * calendar is created → real events are written. Against a real PostgreSQL with
 * the real migrations, real envelope encryption, and a Google double that
 * behaves like Google.
 *
 * This is the test that would have caught every integration bug found while
 * building the parts, and it is the one that says the product works.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  authorise,
  listSourceRecords,
  type DatasetAccess,
} from '@hebrew-dates/db';
import { SCOPE_CALENDAR_APP_CREATED } from '@hebrew-dates/google-client';
import {
  addDateAndSync,
  beginGoogleSignIn,
  completeGoogleSignIn,
  confirmLocation,
  currentUser,
  dashboardView,
  disconnectGoogle,
  ensureGoogleCalendar,
  runDueJobs,
  setupStatus,
  syncDestination,
} from '../src/index';
import { clearTokenCache } from '../src/tokens';
import { createHarness, hasDatabase, JERUSALEM, type Harness } from './helpers/harness';

/** Sign in through the real OAuth flow against the double. */
async function signIn(harness: Harness): Promise<{
  userId: string;
  datasetId: string;
  destinationCalendarId: string;
  sessionToken: string;
  access: DatasetAccess;
}> {
  const begun = await beginGoogleSignIn(harness.context, { redirectPath: '/dashboard' });
  const code = harness.google.authorize(begun.authorizationUrl);
  const completed = await completeGoogleSignIn(harness.context, {
    code,
    state: begun.state,
    ipPrefix: '203.0.113',
  });
  const access = await authorise(harness.context.db, {
    datasetId: completed.datasetId,
    userId: completed.userId,
    minimumRole: 'admin',
  });
  return {
    userId: completed.userId,
    datasetId: completed.datasetId,
    destinationCalendarId: completed.destinationCalendarId,
    sessionToken: completed.sessionToken,
    access,
  };
}

/** The whole happy path up to "ready to add a date". */
async function setUpAccount(harness: Harness) {
  const session = await signIn(harness);
  await confirmLocation(harness.context, session.access, {
    destinationCalendarId: session.destinationCalendarId,
    userId: session.userId,
    location: { ...JERUSALEM, source: 'user_selected' },
    calendarTimezoneHint: 'Asia/Jerusalem',
  });
  return session;
}

const YAHRZEIT = {
  type: 'personal_yahrzeit' as const,
  displayName: 'Avraham ben Yitzchak',
  relationship: 'Grandfather',
  hebrewMonth: 'NISAN' as const,
  hebrewDay: 14,
  originalHebrewYear: 5750,
};

describe.runIf(hasDatabase)('the first end-to-end flow', () => {
  let harness: Harness;

  beforeEach(async () => {
    clearTokenCache();
    harness = await createHarness('e2e');
  }, 60_000);

  afterEach(async () => {
    await harness?.destroy();
  });

  it('signs a new user in and gives them a dataset and a calendar row', async () => {
    const begun = await beginGoogleSignIn(harness.context, { redirectPath: '/dashboard' });
    expect(begun.authorizationUrl).toContain('code_challenge_method=S256');
    expect(begun.authorizationUrl).toContain('prompt=consent');
    expect(begun.authorizationUrl).toContain(encodeURIComponent(SCOPE_CALENDAR_APP_CREATED));

    const code = harness.google.authorize(begun.authorizationUrl);
    const completed = await completeGoogleSignIn(harness.context, { code, state: begun.state });

    expect(completed.isNewUser).toBe(true);
    expect(completed.scopeCheck.sufficient).toBe(true);
    expect(completed.redirectPath).toBe('/dashboard');
    expect(completed.sessionToken).toMatch(/^[A-Za-z0-9_-]+$/);

    // The session resolves, and resolves to this user's own dataset.
    const user = await currentUser(harness.context, completed.sessionToken);
    expect(user?.userId).toBe(completed.userId);
    expect(user?.datasetId).toBe(completed.datasetId);
  });

  it('stores the refresh token encrypted, and never in plaintext', async () => {
    await signIn(harness);

    const account = await harness.db.selectFrom('google_accounts').selectAll().executeTakeFirstOrThrow();
    // The ciphertext is a self-describing envelope blob, not a token.
    expect(account.encrypted_refresh_token).toBeInstanceOf(Buffer);
    expect(account.encrypted_refresh_token.toString('utf8')).not.toContain('1//refresh-');
    expect(account.encryption_key_id).toBeTruthy();
    // Access tokens are deliberately not persisted at all.
    expect(Object.keys(account)).not.toContain('access_token');
    expect(account.granted_scopes).toContain(SCOPE_CALENDAR_APP_CREATED);
  });

  it('reports the next setup step at each stage', async () => {
    const session = await signIn(harness);

    const afterSignIn = await setupStatus(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
    });
    expect(afterSignIn).toMatchObject({
      googleConnected: true,
      locationConfirmed: false,
      nextStep: 'confirm_location',
    });

    await confirmLocation(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
      location: { ...JERUSALEM, source: 'user_selected' },
    });

    const afterLocation = await setupStatus(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
    });
    expect(afterLocation.nextStep).toBe('create_calendar');

    await ensureGoogleCalendar(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });

    const afterCalendar = await setupStatus(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
    });
    expect(afterCalendar.nextStep).toBe('add_date');
  });

  it('creates a dedicated calendar, and only ever one', async () => {
    const session = await setUpAccount(harness);

    const first = await ensureGoogleCalendar(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(first.created).toBe(true);
    expect(first.googleCalendarId).toContain('@group.calendar.google.com');

    // Idempotent. A second call must not leave the user with two "Hebrew
    // Dates" calendars and half their events in each.
    const second = await ensureGoogleCalendar(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(second).toEqual({ googleCalendarId: first.googleCalendarId, created: false });
    expect(harness.google.calendarIds()).toHaveLength(1);

    const stored = harness.google.calendar(first.googleCalendarId);
    expect(stored?.summary).toBe('Hebrew Dates');
    // The calendar's own display zone, taken from the hint.
    expect(stored?.timeZone).toBe('Asia/Jerusalem');
    expect(stored?.createdByApp).toBe(true);
  });

  it('adds a Hebrew date and writes real events to the calendar', async () => {
    const session = await setUpAccount(harness);

    const result = await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });

    // Two Hebrew years synchronously, per the product decision.
    expect(result.hebrewYearsGenerated).toBe(2);
    expect(result.occurrencesPersisted).toBeGreaterThanOrEqual(2);
    expect(result.sync.created).toBe(result.occurrencesPersisted);
    expect(result.sync.failed).toBe(0);
    expect(result.sync.blocked).toBeUndefined();

    const calendarId = harness.google.calendarIds()[0] as string;
    const events = [...(harness.google.calendar(calendarId)?.events.values() ?? [])];
    expect(events).toHaveLength(result.occurrencesPersisted);

    const event = events[0];
    expect(event?.status).toBe('confirmed');
    expect(event?.summary).toContain('Avraham ben Yitzchak');
    // A Hebrew date is not an appointment: it must never make anyone look busy.
    expect(event?.payload.transparency).toBe('transparent');
    // The user chose 'default', so the calendar's own sharing settings govern.
    expect(event?.payload.visibility).toBe('default');
    // Sunset to sunset, as an absolute instant with the display zone alongside.
    const start = event?.payload.start as { dateTime?: string; timeZone?: string };
    expect(start.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(start.timeZone).toBe('Asia/Jerusalem');

    // Provenance, so reconciliation can find its own work later. Queryable via
    // Google's `privateExtendedProperty` filter.
    expect(event?.extendedProperties?.private?.app).toBe('hebrew-dates');
    expect(event?.extendedProperties?.private?.occurrenceKey).toBeTruthy();
    expect(event?.extendedProperties?.private?.sourceRecordId).toBeTruthy();
  });

  it('writes the yahrzeit reminders the product promises', async () => {
    const session = await setUpAccount(harness);
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });

    const calendarId = harness.google.calendarIds()[0] as string;
    const event = [...(harness.google.calendar(calendarId)?.events.values() ?? [])][0];
    const reminders = event?.payload.reminders as {
      useDefault: boolean;
      overrides: { minutes: number }[];
    };

    expect(reminders.useDefault).toBe(false);
    // 7 days, 1 day, and at the start of the event.
    expect(reminders.overrides.map((entry) => entry.minutes).sort((a, b) => b - a)).toEqual([
      10_080, 1440, 0,
    ]);
  });

  it('gives a birthday its own reminder defaults', async () => {
    const session = await setUpAccount(harness);
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: {
        type: 'birthday',
        displayName: 'Rivka',
        hebrewMonth: 'SIVAN',
        hebrewDay: 6,
      },
    });

    const calendarId = harness.google.calendarIds()[0] as string;
    const event = [...(harness.google.calendar(calendarId)?.events.values() ?? [])][0];
    const reminders = event?.payload.reminders as { overrides: { minutes: number }[] };
    expect(reminders.overrides.map((entry) => entry.minutes).sort((a, b) => b - a)).toEqual([
      1440, 0,
    ]);
  });

  it('is idempotent: a second sync with nothing changed writes nothing', async () => {
    const session = await setUpAccount(harness);
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });

    const requestsBefore = harness.google.requests.length;
    const again = await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });

    expect(again.created).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.deleted).toBe(0);
    expect(again.plan.summary.writes).toBe(0);
    // Not a single call to Google: the content-hash comparison happens before
    // any network access.
    expect(harness.google.requests.length).toBe(requestsBefore);
  });

  it('records each event as synced, with its external id', async () => {
    const session = await setUpAccount(harness);
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });

    const rows = await harness.db.selectFrom('destination_events').selectAll().execute();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.sync_status).toBe('synced');
      expect(row.external_event_id).toBeTruthy();
      expect(row.external_calendar_id).toContain('@group.calendar.google.com');
      expect(row.last_synced_at).toBeInstanceOf(Date);
      expect(row.last_error).toBeNull();
      expect(row.attempt_count).toBe(0);
      // The hash of what was actually written, not what was planned.
      expect(row.content_hash).not.toBe('0'.repeat(32));
      // Sunset to sunset: both ends present and ordered.
      expect(row.start_at).toBeInstanceOf(Date);
      expect(row.end_at).toBeInstanceOf(Date);
      expect((row.start_at as Date).getTime()).toBeLessThan((row.end_at as Date).getTime());
    }
  });

  it('refuses to add a date before a location is confirmed', async () => {
    // The "never silently choose" rule: sunset depends on where you are, and
    // the app does not guess.
    const session = await signIn(harness);
    await expect(
      addDateAndSync(harness.context, session.access, {
        userId: session.userId,
        destinationCalendarId: session.destinationCalendarId,
        date: YAHRZEIT,
      }),
    ).rejects.toThrow(/confirm your location/);
  });

  it('writes nothing when a location is stored but unconfirmed', async () => {
    const session = await signIn(harness);
    await ensureGoogleCalendar(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });

    // A suggestion the user has not looked at.
    await harness.db
      .insertInto('calendar_locations')
      .values({
        destination_calendar_id: session.destinationCalendarId,
        display_name: 'Jerusalem, Israel',
        country_code: 'IL',
        latitude: '31.778100',
        longitude: '35.235200',
        timezone_id: 'Asia/Jerusalem',
        source: 'timezone_suggestion',
        confirmed_at: null,
        confirmed_by_user_id: null,
      })
      .execute();

    const result = await syncDestination(harness.context, session.access, {
      destinationCalendarId: session.destinationCalendarId,
      userId: session.userId,
    });
    expect(result.blocked?.reason).toBe('location_not_confirmed');
    expect(result.created).toBe(0);
  });

  it('shows the whole state on the dashboard', async () => {
    const session = await setUpAccount(harness);
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });

    const view = await dashboardView(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
    });

    expect(view.google.connected).toBe(true);
    expect(view.google.scopeSufficient).toBe(true);
    expect(view.location?.displayName).toBe('Jerusalem, Israel');
    expect(view.location?.confirmed).toBe(true);
    expect(view.calendar.created).toBe(true);
    expect(view.records).toHaveLength(1);
    expect(view.records[0]?.displayName).toBe('Avraham ben Yitzchak');
    expect(view.upcoming.length).toBeGreaterThanOrEqual(1);
    // Legible, not an enum value.
    expect(view.upcoming[0]?.syncStatusLabel).toBe('In your calendar');
    expect(view.counts.synced).toBeGreaterThanOrEqual(2);
    expect(view.counts.failed).toBe(0);
  });

  it('queues the remaining years and the worker completes them', async () => {
    const session = await setUpAccount(harness);
    const added = await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    expect(added.hebrewYearsGenerated).toBe(2);

    const queued = await harness.db.selectFrom('sync_jobs').selectAll().execute();
    expect(queued.map((job) => job.job_type)).toContain('extend_horizon');

    // The worker extends the horizon, then a reconcile writes the new years.
    const first = await runDueJobs(harness.context);
    expect(first.outcomes.some((outcome) => outcome.jobType === 'extend_horizon')).toBe(true);

    const second = await runDueJobs(harness.context);
    const reconcile = second.outcomes.find((outcome) => outcome.jobType === 'reconcile');
    expect(reconcile?.status).toBe('succeeded');

    const occurrences = await harness.db
      .selectFrom('generated_occurrences')
      .select(harness.db.fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    // Twenty Hebrew years, not two.
    expect(Number(occurrences.count)).toBeGreaterThanOrEqual(20);

    const calendarId = harness.google.calendarIds()[0] as string;
    expect(harness.google.calendar(calendarId)?.events.size).toBeGreaterThanOrEqual(20);
  });

  it('does not use a Gregorian recurrence: each year is its own event on its own date', async () => {
    const session = await setUpAccount(harness);
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    await runDueJobs(harness.context);
    await runDueJobs(harness.context);

    const rows = await harness.db
      .selectFrom('generated_occurrences')
      .select(['hebrew_year', 'gregorian_date'])
      .orderBy('hebrew_year')
      .execute();

    // Every year has its own row, and the Gregorian month/day genuinely moves.
    const monthDays = new Set(rows.map((row) => row.gregorian_date.slice(5)));
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(monthDays.size).toBeGreaterThan(5);

    const calendarId = harness.google.calendarIds()[0] as string;
    for (const event of harness.google.calendar(calendarId)?.events.values() ?? []) {
      // A single recurring event would carry a recurrence rule. None do.
      expect(event.payload.recurrence).toBeUndefined();
    }
  });

  it('disconnects, revoking at Google and deleting the calendar', async () => {
    const session = await setUpAccount(harness);
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });

    const result = await disconnectGoogle(harness.context, {
      userId: session.userId,
      deleteCalendar: true,
    });

    expect(result.revokedAtGoogle).toBe(true);
    expect(result.calendarDeleted).toBe(true);
    expect(harness.google.calendarIds()).toHaveLength(0);

    // The stored grant is gone, and so are the sessions.
    expect(await harness.db.selectFrom('google_accounts').selectAll().execute()).toHaveLength(0);
    await expect(currentUser(harness.context, session.sessionToken)).resolves.toBeUndefined();
  });

  it('keeps the user\'s dates after a disconnect', async () => {
    // Disconnecting a calendar is not deleting your family's yahrzeits.
    const session = await setUpAccount(harness);
    await addDateAndSync(harness.context, session.access, {
      userId: session.userId,
      destinationCalendarId: session.destinationCalendarId,
      date: YAHRZEIT,
    });
    await disconnectGoogle(harness.context, { userId: session.userId, deleteCalendar: true });

    const records = await listSourceRecords(harness.context.db, session.access);
    expect(records).toHaveLength(1);
    expect(records[0]?.display_name).toBe('Avraham ben Yitzchak');
  });
});

describe.runIf(hasDatabase)('sign-in security properties', () => {
  let harness: Harness;

  beforeEach(async () => {
    clearTokenCache();
    harness = await createHarness('e2e-security');
  }, 60_000);

  afterEach(async () => {
    await harness?.destroy();
  });

  it('refuses a replayed callback', async () => {
    const begun = await beginGoogleSignIn(harness.context);
    const code = harness.google.authorize(begun.authorizationUrl);
    await completeGoogleSignIn(harness.context, { code, state: begun.state });

    // The state is single-use, so the second attempt finds nothing.
    await expect(
      completeGoogleSignIn(harness.context, { code, state: begun.state }),
    ).rejects.toThrow(/already been used/);
  });

  it('refuses an unknown state', async () => {
    await expect(
      completeGoogleSignIn(harness.context, { code: 'x', state: 'never-issued' }),
    ).rejects.toThrow(/already been used or has expired/);
  });

  it('refuses an expired state', async () => {
    const begun = await beginGoogleSignIn(harness.context);
    const code = harness.google.authorize(begun.authorizationUrl);
    harness.advance(11 * 60 * 1000);

    await expect(
      completeGoogleSignIn(harness.context, { code, state: begun.state }),
    ).rejects.toThrow(/already been used or has expired/);
  });

  it('cannot decrypt a verifier transplanted into another state row', async () => {
    // The AAD binds each ciphertext to its own row. Without it, an attacker who
    // could write to the table could pair their own `state` with someone else's
    // verifier.
    const victim = await beginGoogleSignIn(harness.context);
    const attacker = await beginGoogleSignIn(harness.context);

    const victimRow = await harness.db
      .selectFrom('oauth_states')
      .select(['state_hash', 'encrypted_code_verifier', 'encryption_key_id'])
      .execute();
    const rows = victimRow.filter((row) => row.encrypted_code_verifier.length > 0);
    expect(rows).toHaveLength(2);

    // Copy one ciphertext over the other row's.
    await harness.db
      .updateTable('oauth_states')
      .set({
        encrypted_code_verifier: rows[0]?.encrypted_code_verifier as Buffer,
        encryption_key_id: rows[0]?.encryption_key_id as string,
      })
      .where('state_hash', '=', rows[1]?.state_hash as Buffer)
      .execute();

    const code = harness.google.authorize(attacker.authorizationUrl);
    // Which of the two rows was overwritten depends on row order, so either
    // state may be the transplanted one; what matters is that a transplanted
    // ciphertext cannot be opened.
    const outcomes = await Promise.all(
      [victim.state, attacker.state].map((state) =>
        completeGoogleSignIn(harness.context, { code, state }).then(
          () => 'accepted',
          (error: Error) => error.message,
        ),
      ),
    );
    expect(outcomes.some((outcome) => /could not be verified/.test(String(outcome)))).toBe(true);
  });

  it('will not sign in with a mismatched PKCE verifier', async () => {
    // Belt and braces: even holding a valid code and state, the verifier must
    // match. Simulated by replacing the stored ciphertext with a valid seal of
    // a different verifier.
    const begun = await beginGoogleSignIn(harness.context);
    const code = harness.google.authorize(begun.authorizationUrl);

    const { seal } = await import('@hebrew-dates/crypto');
    const { hashToken } = await import('@hebrew-dates/db');
    const wrong = await seal(
      harness.context.keys,
      JSON.stringify({ verifier: 'a'.repeat(43), nonce: 'n' }),
      {
        purpose: 'oauth.code_verifier',
        subject: hashToken(begun.state).toString('hex'),
      },
    );
    await harness.db
      .updateTable('oauth_states')
      .set({ encrypted_code_verifier: wrong.ciphertext, encryption_key_id: wrong.keyId })
      .where('state_hash', '=', hashToken(begun.state))
      .execute();

    await expect(
      completeGoogleSignIn(harness.context, { code, state: begun.state }),
    ).rejects.toThrow();
  });

  it('discards an off-list redirect path rather than following it', async () => {
    const begun = await beginGoogleSignIn(harness.context, {
      redirectPath: 'https://evil.test/steal',
    });
    const code = harness.google.authorize(begun.authorizationUrl);
    const completed = await completeGoogleSignIn(harness.context, { code, state: begun.state });
    expect(completed.redirectPath).toBe('/dashboard');
  });

  it('does not let one user reach another user\'s dataset', async () => {
    const first = await signIn(harness);
    // A second, independent account.
    const begun = await beginGoogleSignIn(harness.context);
    const code = harness.google.authorize(begun.authorizationUrl, { subject: 'google-subject-2' });
    const second = await completeGoogleSignIn(harness.context, { code, state: begun.state });

    expect(second.datasetId).not.toBe(first.datasetId);
    await expect(
      authorise(harness.context.db, {
        datasetId: first.datasetId,
        userId: second.userId,
        minimumRole: 'viewer',
      }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it('refuses a session token that has been tampered with', async () => {
    const session = await signIn(harness);
    await expect(
      currentUser(harness.context, `${session.sessionToken}x`),
    ).resolves.toBeUndefined();
    await expect(currentUser(harness.context, undefined)).resolves.toBeUndefined();
  });
});
