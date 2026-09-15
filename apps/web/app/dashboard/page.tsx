/**
 * The dashboard.
 *
 * Still deliberately plain, but now covering the whole individual flow:
 * connect Google, search for and confirm a location, add a date by Hebrew or
 * English date, answer the sunset question when there is one, see sync status,
 * edit, delete, pause.
 *
 * A server component. Everything it shows comes from one read model
 * (`dashboardView`), so two panels cannot disagree about whether the calendar
 * exists or whether a date is waiting on an answer.
 */
import { redirect } from 'next/navigation';
import { dashboardView, listCataloguePlaces, setupStatus } from '@hebrew-dates/service';
import {
  configProblems,
  context,
  geocoderBackend,
  keyBackend,
  signedInUser,
} from '../../lib/server';
import {
  AddDateForm,
  CreateCalendarForm,
  DateList,
  DisconnectForm,
  LocationPanel,
  SunsetDecisionPanel,
  SyncNowForm,
} from './DashboardForms';
import {
  acceptSuggestionAction,
  addDateAction,
  confirmPlaceAction,
  createCalendarAction,
  deleteDateAction,
  disconnectAction,
  editDateAction,
  previewDeleteAction,
  resolveSunsetAction,
  searchPlacesAction,
  syncNowAction,
  toggleDateActiveAction,
} from './actions';

export const dynamic = 'force-dynamic';

const STEP_LABELS: Record<string, string> = {
  connect_google: 'Connect your Google Calendar',
  confirm_location: 'Confirm your location',
  create_calendar: 'Create your Hebrew Dates calendar',
  add_date: 'Add your first Hebrew date',
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const problems = configProblems();
  if (problems.length > 0) {
    return (
      <main id="main" className="page">
        <h1>Not configured yet</h1>
        <p>This deployment is missing some configuration:</p>
        <ul>
          {problems.map((problem) => (
            <li key={problem.variable}>
              <code>{problem.variable}</code> — {problem.why}
            </li>
          ))}
        </ul>
      </main>
    );
  }

  const user = await signedInUser();
  if (!user) redirect('/');

  const query = await searchParams;
  const view = await dashboardView(context(), user.access, {
    userId: user.userId,
    destinationCalendarId: user.destinationCalendarId,
  });
  const status = await setupStatus(context(), user.access, {
    userId: user.userId,
    destinationCalendarId: user.destinationCalendarId,
  });
  const catalogue = await listCataloguePlaces(context());
  const keys = keyBackend();
  const geocoder = geocoderBackend();

  return (
    <main id="main" className="page">
      <header className="page-header">
        <div>
          <h1>Hebrew Dates</h1>
          <p className="muted">Signed in as {user.email}</p>
        </div>
        <form action="/auth/signout" method="post">
          <button type="submit" className="quiet">
            Sign out
          </button>
        </form>
      </header>

      {query.scope === 'insufficient' ? (
        <p className="notice notice-warning">
          Google did not grant permission to manage calendars, so nothing can be written yet.{' '}
          <a href="/auth/google/start">Sign in again</a> and leave the calendar permission
          ticked.
        </p>
      ) : null}

      {view.google.status === 'needs_reauth' || view.google.status === 'revoked' ? (
        <p className="notice notice-error">
          Your Google connection is no longer valid
          {view.google.lastError ? `: ${view.google.lastError}` : '.'}{' '}
          <a href="/auth/google/start">Reconnect Google Calendar</a>
        </p>
      ) : null}

      {status.nextStep ? (
        <p className="notice notice-ok">
          <strong>Next step:</strong> {STEP_LABELS[status.nextStep]}
        </p>
      ) : view.sunsetQuestions.length === 0 ? (
        <p className="notice notice-ok">
          Everything is set up. {view.counts.synced} event
          {view.counts.synced === 1 ? '' : 's'} in your calendar.
        </p>
      ) : null}

      {/* -------------------------------------------- the sunset question -- */}
      {/* First, above everything else: it is the only thing blocking a date
          from reaching the calendar, and it needs the user rather than time. */}
      <SunsetDecisionPanel
        action={resolveSunsetAction}
        questions={view.sunsetQuestions.map((question) => ({
          sourceRecordId: question.sourceRecordId,
          displayName: question.displayName,
          gregorianDate: question.decision.gregorianDate,
          candidates: question.decision.candidates.map((candidate) => ({
            choice: candidate.choice,
            hebrewDateLabel: candidate.hebrewDateLabel,
            meaning: candidate.meaning,
          })),
          sunset: question.decision.sunset
            ? {
                localTime: question.decision.sunset.localTime,
                locationDisplayName: question.decision.sunset.locationDisplayName,
              }
            : undefined,
          explanation: question.decision.explanation,
          whereToLook: question.decision.whereToLook,
        }))}
      />

      {/* ------------------------------------------------------- location -- */}
      <LocationPanel
        searchAction={searchPlacesAction}
        confirmAction={confirmPlaceAction}
        acceptSuggestionAction={acceptSuggestionAction}
        liveSearchEnabled={geocoder?.liveSearchEnabled ?? false}
        catalogue={catalogue.map((place) => ({
          id: place.id,
          displayName: place.displayName,
          shortName: place.shortName,
          timezoneId: place.timezoneId,
          provider: place.provider,
          hasElevation: place.elevationMeters !== undefined,
        }))}
        current={
          view.location?.confirmed
            ? {
                displayName: view.location.displayName,
                timezoneId: view.location.timezoneId,
                source: view.location.source,
              }
            : undefined
        }
      />

      {/* ------------------------------------------------------- calendar -- */}
      <CreateCalendarForm action={createCalendarAction} created={view.calendar.created} />

      {/* ----------------------------------------------------------- date -- */}
      {status.locationConfirmed && status.calendarCreated ? (
        <AddDateForm action={addDateAction} />
      ) : (
        <section className="card">
          <h2>Add a Hebrew date</h2>
          <p className="muted">
            {!status.locationConfirmed
              ? 'Confirm your location first — sunset times depend on it.'
              : 'Create your Hebrew Dates calendar first.'}
          </p>
        </section>
      )}

      {/* ------------------------------------------------- your dates list -- */}
      <DateList
        rows={view.records}
        editAction={editDateAction}
        previewDeleteAction={previewDeleteAction}
        deleteAction={deleteDateAction}
        toggleActiveAction={toggleDateActiveAction}
      />

      {/* --------------------------------------------------------- status -- */}
      <section className="card">
        <div className="page-header">
          <h2>Sync status</h2>
          <SyncNowForm action={syncNowAction} />
        </div>

        <dl className="stats">
          <div>
            <dt>Dates</dt>
            <dd>{view.counts.records}</dd>
          </div>
          <div>
            <dt>In your calendar</dt>
            <dd>{view.counts.synced}</dd>
          </div>
          <div>
            <dt>Waiting</dt>
            <dd>{view.counts.pending}</dd>
          </div>
          <div>
            <dt>Problems</dt>
            <dd>{view.counts.failed}</dd>
          </div>
        </dl>

        {view.upcoming.length === 0 ? (
          <p className="muted">Nothing upcoming yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Upcoming occurrences and their sync status</caption>
              <thead>
                <tr>
                  <th scope="col">Who</th>
                  <th scope="col">Hebrew date</th>
                  <th scope="col">Gregorian date</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {view.upcoming.map((occurrence) => (
                  <tr key={occurrence.occurrenceKey}>
                    <td>{occurrence.displayName}</td>
                    <td>{occurrence.hebrewDateLabel}</td>
                    <td>
                      <time dateTime={occurrence.gregorianDate}>{occurrence.gregorianDate}</time>
                    </td>
                    <td>
                      {occurrence.syncStatusLabel}
                      {occurrence.lastError ? (
                        <>
                          {' '}
                          <span className="muted small">({occurrence.lastError})</span>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------- diagnostics -- */}
      <section className="card">
        <h2>Connection</h2>
        <ul className="list">
          <li>
            Google account: {view.google.email ?? 'not connected'} ({view.google.status})
          </li>
          <li>
            Calendar:{' '}
            {view.calendar.googleCalendarId ? (
              <code>{view.calendar.googleCalendarId}</code>
            ) : (
              'not created yet'
            )}
          </li>
          <li>Location: {view.location?.displayName ?? 'not set'}</li>
          {geocoder ? <li>Place search: {geocoder.description}</li> : null}
          {keys ? <li>Token encryption: {keys.description}</li> : null}
        </ul>

        {view.recentJobs.length > 0 ? (
          <>
            <h3>Recent background work</h3>
            <ul className="list">
              {view.recentJobs.map((job) => (
                <li key={job.id}>
                  {job.job_type} — {job.status}
                  {job.error_summary ? ` (${job.error_summary})` : ''}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <DisconnectForm action={disconnectAction} />
      </section>
    </main>
  );
}
