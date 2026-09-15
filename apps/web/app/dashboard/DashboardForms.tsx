'use client';

/**
 * The dashboard's interactive parts.
 *
 * Client components only where interaction demands it: `useActionState` to show
 * what an action did, the browser's own time zone for a location suggestion, and
 * a couple of disclosure toggles. Everything that reads data stays on the
 * server.
 */
import { useActionState, useEffect, useState } from 'react';
import type {
  ActionResult,
  DashboardAction as Action,
  DeletePreviewResult,
  PlaceOption,
  PlaceSearchAction,
  PlaceSearchResult,
} from './actions';

const EMPTY: ActionResult | undefined = undefined;

function Result({ state }: { state: ActionResult | undefined }) {
  if (!state || !state.message) return null;
  return (
    <p className={state.ok ? 'notice notice-ok' : 'notice notice-error'} role="status">
      {state.message}
    </p>
  );
}

/* --------------------------------------------------------------- location -- */

export function LocationPanel({
  searchAction,
  confirmAction,
  acceptSuggestionAction,
  catalogue,
  current,
  liveSearchEnabled,
}: {
  searchAction: PlaceSearchAction;
  confirmAction: Action;
  acceptSuggestionAction: Action;
  /** The built-in cities, for the fallback control. */
  catalogue: PlaceOption[];
  current: { displayName: string; timezoneId: string; source: string } | undefined;
  liveSearchEnabled: boolean;
}) {
  const [search, runSearch, searching] = useActionState<PlaceSearchResult | undefined, FormData>(
    searchAction,
    undefined,
  );
  const [confirmState, confirm, confirming] = useActionState(confirmAction, EMPTY);
  const [suggestState, accept, accepting] = useActionState(acceptSuggestionAction, EMPTY);
  const [browserZone, setBrowserZone] = useState<string | undefined>(undefined);
  const [showCatalogue, setShowCatalogue] = useState(false);

  useEffect(() => {
    // Read once on the client. A time zone is only ever a *starting point*
    // here: America/New_York spans Maine to Michigan, and sunset differs by
    // nearly an hour across it, so the user still has to agree to a place.
    try {
      setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      setBrowserZone(undefined);
    }
  }, []);

  const suggestion = browserZone
    ? catalogue.find((option) => option.timezoneId === browserZone)
    : undefined;

  return (
    <section className="card">
      <h2>Location</h2>
      <p className="muted">
        Events run from sunset to sunset where you are, so Hebrew Dates needs a place — not
        just a time zone. A time zone spans hundreds of miles and sunset differs across it by
        the better part of an hour.
      </p>

      {current ? (
        <p>
          Currently <strong>{current.displayName}</strong>{' '}
          <span className="muted small">
            ({current.timezoneId}
            {current.source === 'geocoded' ? ', from search' : ''})
          </span>
        </p>
      ) : (
        <p className="notice notice-warning">
          No location is confirmed yet, so nothing will be written to your calendar.
        </p>
      )}

      {suggestion && suggestion.displayName !== current?.displayName ? (
        <form action={accept} className="stack">
          <input type="hidden" name="timezoneId" value={browserZone ?? ''} />
          <p className="small">
            Your browser suggests <strong>{suggestion.displayName}</strong>. If that is right,
            you can use it — otherwise search below.
          </p>
          <button type="submit" className="quiet" disabled={accepting}>
            {accepting ? 'Confirming…' : `Use ${suggestion.shortName}`}
          </button>
        </form>
      ) : null}
      <Result state={suggestState} />

      <form action={runSearch} className="stack">
        <label htmlFor="query">
          {current ? 'Change your location' : 'Search for your city or town'}
        </label>
        <div className="inline">
          <input
            id="query"
            name="query"
            type="search"
            placeholder="Lakewood, Golders Green, Bnei Brak…"
            minLength={3}
            required
            autoComplete="off"
          />
          <button type="submit" disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        {!liveSearchEnabled ? (
          <p className="muted small">
            Live search is not configured on this deployment, so only the built-in city list
            is searchable.
          </p>
        ) : null}
      </form>

      {search && !search.ok ? (
        <p className="notice notice-error" role="status">
          {search.message}
        </p>
      ) : null}
      {search?.ok && search.message ? (
        <p className="notice notice-warning" role="status">
          {search.message}
        </p>
      ) : null}

      {search?.places.length ? (
        <>
          <h3 className="small">Is one of these your place?</h3>
          <p className="muted small">
            Nothing is saved until you confirm one. The time zone shown is worked out from the
            place itself.
          </p>
          <ul className="list list-plain">
            {search.places.map((place) => (
              <li key={place.id} className="place-row">
                <form action={confirm} className="inline">
                  <input type="hidden" name="placeId" value={place.id} />
                  <span>
                    <strong>{place.displayName}</strong>
                    <br />
                    <span className="muted small">
                      {place.timezoneId}
                      {place.hasElevation ? ' · includes elevation' : ''}
                    </span>
                  </span>
                  <button type="submit" disabled={confirming}>
                    {confirming ? 'Saving…' : 'Use this'}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Result state={confirmState} />

      <p>
        <button
          type="button"
          className="quiet small"
          onClick={() => setShowCatalogue(!showCatalogue)}
          aria-expanded={showCatalogue}
        >
          {showCatalogue ? 'Hide' : 'Or pick a nearby city from a list'}
        </button>
      </p>
      {showCatalogue ? (
        <form action={confirm} className="stack">
          <label htmlFor="catalogueId">Nearby city</label>
          <select id="catalogueId" name="placeId" defaultValue="">
            <option value="" disabled>
              Choose a city…
            </option>
            {catalogue.map((place) => (
              <option key={place.id} value={place.id}>
                {place.displayName}
              </option>
            ))}
          </select>
          <button type="submit" disabled={confirming}>
            Confirm this location
          </button>
        </form>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------- calendar -- */

export function CreateCalendarForm({ action, created }: { action: Action; created: boolean }) {
  const [state, submit, pending] = useActionState(action, EMPTY);
  return (
    <section className="card">
      <h2>Your Hebrew Dates calendar</h2>
      <p className="muted">
        Hebrew Dates creates its own calendar in your Google account and writes only there.
        It cannot see or change your other calendars. You can hide, colour or share this one
        calendar without affecting anything else.
      </p>
      <form action={submit}>
        <button type="submit" disabled={pending}>
          {pending
            ? 'Working…'
            : created
              ? 'Check the calendar still exists'
              : 'Create my Hebrew Dates calendar'}
        </button>
      </form>
      <Result state={state} />
    </section>
  );
}

/* ------------------------------------------------------------- date fields -- */

const MONTHS: { value: string; label: string }[] = [
  { value: 'TISHREI', label: 'Tishrei' },
  { value: 'CHESHVAN', label: 'Cheshvan' },
  { value: 'KISLEV', label: 'Kislev' },
  { value: 'TEVET', label: 'Tevet' },
  { value: 'SHVAT', label: 'Shvat' },
  { value: 'ADAR', label: 'Adar (ordinary year)' },
  { value: 'ADAR_I', label: 'Adar I (leap year)' },
  { value: 'ADAR_II', label: 'Adar II (leap year)' },
  { value: 'NISAN', label: 'Nisan' },
  { value: 'IYYAR', label: 'Iyyar' },
  { value: 'SIVAN', label: 'Sivan' },
  { value: 'TAMUZ', label: 'Tamuz' },
  { value: 'AV', label: 'Av' },
  { value: 'ELUL', label: 'Elul' },
];

export function AddDateForm({ action }: { action: Action }) {
  const [state, submit, pending] = useActionState(action, EMPTY);
  const [type, setType] = useState('personal_yahrzeit');
  const [entryMode, setEntryMode] = useState<'hebrew' | 'gregorian'>('hebrew');

  return (
    <section className="card">
      <h2>Add a Hebrew date</h2>
      <form action={submit} className="stack">
        <fieldset>
          <legend>What kind of date is this?</legend>
          <label>
            <input
              type="radio"
              name="type"
              value="personal_yahrzeit"
              checked={type === 'personal_yahrzeit'}
              onChange={() => setType('personal_yahrzeit')}
            />{' '}
            Yahrzeit
          </label>
          <label>
            <input
              type="radio"
              name="type"
              value="birthday"
              checked={type === 'birthday'}
              onChange={() => setType('birthday')}
            />{' '}
            Hebrew birthday
          </label>
        </fieldset>

        <label htmlFor="displayName">Name</label>
        <input
          id="displayName"
          name="displayName"
          required
          maxLength={200}
          placeholder={type === 'birthday' ? 'Rivka' : 'Avraham ben Yitzchak'}
        />

        <fieldset>
          <legend>Do you know the Hebrew date, or the English one?</legend>
          <label>
            <input
              type="radio"
              name="entryMode"
              value="hebrew"
              checked={entryMode === 'hebrew'}
              onChange={() => setEntryMode('hebrew')}
            />{' '}
            I know the Hebrew date
          </label>
          <label>
            <input
              type="radio"
              name="entryMode"
              value="gregorian"
              checked={entryMode === 'gregorian'}
              onChange={() => setEntryMode('gregorian')}
            />{' '}
            I know the English (Gregorian) date
          </label>
        </fieldset>

        {entryMode === 'hebrew' ? (
          <>
            <div className="row">
              <div className="stack">
                <label htmlFor="hebrewMonth">Hebrew month</label>
                <select id="hebrewMonth" name="hebrewMonth" defaultValue="NISAN">
                  {MONTHS.map((month) => (
                    <option key={month.value} value={month.value}>
                      {month.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="stack">
                <label htmlFor="hebrewDay">Day</label>
                <input
                  id="hebrewDay"
                  name="hebrewDay"
                  type="number"
                  min={1}
                  max={30}
                  defaultValue={1}
                  required
                />
              </div>
            </div>

            <label htmlFor="originalHebrewYear">
              Hebrew year {type === 'birthday' ? '(optional)' : 'of death'}
            </label>
            <input
              id="originalHebrewYear"
              name="originalHebrewYear"
              type="number"
              min={1}
              max={7000}
              placeholder="5750"
              {...(type === 'personal_yahrzeit' ? { required: true } : {})}
            />
            <p className="muted small">
              {type === 'personal_yahrzeit'
                ? 'The year is needed because the rule for some dates — the 30th of Cheshvan or Kislev, and the first year — depends on it.'
                : 'Only needed if you would like the age shown.'}
            </p>
          </>
        ) : (
          <>
            <label htmlFor="gregorianDate">English (Gregorian) date</label>
            <input id="gregorianDate" name="gregorianDate" type="date" required />

            <fieldset>
              <legend>Was it before or after sunset that day?</legend>
              <label>
                <input type="radio" name="sunsetStatus" value="unknown" defaultChecked /> I am
                not sure
              </label>
              <label>
                <input type="radio" name="sunsetStatus" value="before_sunset" /> Before sunset
                (during the day)
              </label>
              <label>
                <input type="radio" name="sunsetStatus" value="after_sunset" /> After sunset
                (in the evening)
              </label>
            </fieldset>
            <p className="muted small">
              A Hebrew day begins at sunset, so one English date is two possible Hebrew dates.
              If you are not sure, say so — Hebrew Dates will show you both and ask, rather
              than guessing.
            </p>
          </>
        )}

        <label htmlFor="relationship">Relationship (optional)</label>
        <input id="relationship" name="relationship" maxLength={100} placeholder="Grandfather" />

        <label htmlFor="notes">Notes (optional)</label>
        <input id="notes" name="notes" maxLength={500} />

        <button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add and sync to my calendar'}
        </button>
      </form>
      <Result state={state} />
    </section>
  );
}

/* -------------------------------------------------------- sunset decision -- */

export interface SunsetQuestion {
  sourceRecordId: string;
  displayName: string;
  gregorianDate: string;
  candidates: {
    choice: string;
    hebrewDateLabel: string;
    meaning: string;
  }[];
  sunset: { localTime: string; locationDisplayName: string } | undefined;
  explanation: string;
  whereToLook: string[];
}

/**
 * The sunset question.
 *
 * Both candidates, the calculated sunset, why it matters, and no default — the
 * submit button is disabled until the user picks one. This is the whole point
 * of the flow: the application will not choose, and it will not pretend that
 * not choosing is an error either.
 */
export function SunsetDecisionPanel({
  questions,
  action,
}: {
  questions: SunsetQuestion[];
  action: Action;
}) {
  const [state, submit, pending] = useActionState(action, EMPTY);
  const [chosen, setChosen] = useState<Record<string, string>>({});

  if (questions.length === 0) return null;

  return (
    <section className="card card-attention">
      <h2>Needs your answer</h2>
      <p className="muted">
        {questions.length === 1 ? 'One date' : `${questions.length} dates`} cannot be
        calculated until you tell us which side of sunset it fell on. Nothing has been written
        to your calendar for {questions.length === 1 ? 'it' : 'them'} yet.
      </p>

      {questions.map((question) => (
        <div key={question.sourceRecordId} className="question">
          <h3>
            {question.displayName}{' '}
            <span className="muted small">
              — entered as <time dateTime={question.gregorianDate}>{question.gregorianDate}</time>
            </span>
          </h3>

          <p className="small">{question.explanation}</p>

          {question.sunset ? (
            <p className="notice notice-ok small">
              Sunset in {question.sunset.locationDisplayName} on that date was{' '}
              <strong>{question.sunset.localTime}</strong>. Anything before that is the first
              Hebrew date below; anything after is the second.
            </p>
          ) : (
            <p className="notice notice-warning small">
              The sunset time for that date could not be calculated
              {question.sunset === undefined ? ' at your location' : ''}, but the two possible
              Hebrew dates are still exactly these two.
            </p>
          )}

          <form action={submit} className="stack">
            <input type="hidden" name="sourceRecordId" value={question.sourceRecordId} />
            <fieldset>
              <legend>Which was it?</legend>
              {question.candidates.map((candidate) => (
                <label key={candidate.choice} className="choice">
                  <input
                    type="radio"
                    name="choice"
                    value={candidate.choice}
                    checked={chosen[question.sourceRecordId] === candidate.choice}
                    onChange={() =>
                      setChosen({ ...chosen, [question.sourceRecordId]: candidate.choice })
                    }
                  />{' '}
                  <span>
                    <strong>{candidate.hebrewDateLabel}</strong>
                    <br />
                    <span className="muted small">{candidate.meaning}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <details>
              <summary className="small">Where can I find this out?</summary>
              <ul className="list small">
                {question.whereToLook.map((where) => (
                  <li key={where}>{where}</li>
                ))}
              </ul>
            </details>

            <button
              type="submit"
              // No default and no guess: until the user picks, there is nothing
              // to submit.
              disabled={pending || !chosen[question.sourceRecordId]}
            >
              {pending ? 'Saving…' : 'Use this date'}
            </button>
            {!chosen[question.sourceRecordId] ? (
              <p className="muted small">Choose one of the two dates above to continue.</p>
            ) : null}
          </form>
        </div>
      ))}
      <Result state={state} />
    </section>
  );
}

/* ----------------------------------------------------------- edit / delete -- */

export interface DateRow {
  id: string;
  displayName: string;
  type: string;
  hebrewDateLabel: string;
  hebrewMonth: string;
  hebrewDay: number;
  originalHebrewYear: number | null;
  relationship: string | null;
  notes: string | null;
  active: boolean;
  awaitingSunsetDecision: boolean;
  enteredAsGregorian: boolean;
  gregorianEntryDate: string | null;
  horizonThroughHebrewYear: number | null;
}

export function DateList({
  rows,
  editAction,
  previewDeleteAction,
  deleteAction,
  toggleActiveAction,
}: {
  rows: DateRow[];
  editAction: Action;
  previewDeleteAction: (
    previous: DeletePreviewResult | undefined,
    formData: FormData,
  ) => Promise<DeletePreviewResult>;
  deleteAction: Action;
  toggleActiveAction: Action;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="card">
      <h2>Your dates</h2>
      <ul className="list list-plain">
        {rows.map((row) => (
          <DateListItem
            key={row.id}
            row={row}
            editAction={editAction}
            previewDeleteAction={previewDeleteAction}
            deleteAction={deleteAction}
            toggleActiveAction={toggleActiveAction}
          />
        ))}
      </ul>
    </section>
  );
}

function DateListItem({
  row,
  editAction,
  previewDeleteAction,
  deleteAction,
  toggleActiveAction,
}: {
  row: DateRow;
  editAction: Action;
  previewDeleteAction: (
    previous: DeletePreviewResult | undefined,
    formData: FormData,
  ) => Promise<DeletePreviewResult>;
  deleteAction: Action;
  toggleActiveAction: Action;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
  const [editState, edit, editing] = useActionState(editAction, EMPTY);
  const [preview, runPreview, previewing] = useActionState<
    DeletePreviewResult | undefined,
    FormData
  >(previewDeleteAction, undefined);
  const [deleteState, remove, removing] = useActionState(deleteAction, EMPTY);
  const [toggleState, toggle, toggling] = useActionState(toggleActiveAction, EMPTY);

  return (
    <li className="date-row">
      <div className="page-header">
        <div>
          <strong>{row.displayName}</strong>{' '}
          <span className="muted small">
            {row.type === 'birthday' ? 'birthday' : 'yahrzeit'} ·{' '}
            {/* While the question is open the stored Hebrew date is only the
                before-sunset reading, so showing it here would look like the
                answer. The date as typed is the honest thing to show. */}
            {row.awaitingSunsetDecision
              ? `entered as ${row.gregorianEntryDate}`
              : row.hebrewDateLabel}
            {row.horizonThroughHebrewYear
              ? ` · calculated through ${row.horizonThroughHebrewYear}`
              : ''}
            {row.awaitingSunsetDecision
              ? ' · awaiting your answer'
              : row.active
                ? ''
                : ' · paused'}
          </span>
        </div>
        <div className="inline">
          {/* Edit and Pause need a settled Hebrew date: editing one would
              re-open the sunset question, and pausing a draft that already
              generates nothing means nothing. Delete stays available — someone
              who typed the wrong date should not have to answer a question
              about it first. */}
          {!row.awaitingSunsetDecision ? (
            <>
              <button
                type="button"
                className="quiet small"
                onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}
                aria-expanded={mode === 'edit'}
              >
                {mode === 'edit' ? 'Cancel' : 'Edit'}
              </button>
              <form action={toggle}>
                <input type="hidden" name="sourceRecordId" value={row.id} />
                <input type="hidden" name="active" value={row.active ? 'no' : 'yes'} />
                <button type="submit" className="quiet small" disabled={toggling}>
                  {toggling ? '…' : row.active ? 'Pause' : 'Resume'}
                </button>
              </form>
            </>
          ) : null}
          <form
            action={(formData) => {
              setMode('delete');
              runPreview(formData);
            }}
          >
            <input type="hidden" name="sourceRecordId" value={row.id} />
            <button type="submit" className="quiet small danger" disabled={previewing}>
              {previewing ? '…' : 'Delete'}
            </button>
          </form>
        </div>
      </div>

      <Result state={toggleState} />

      {mode === 'edit' ? (
        <form action={edit} className="stack inset">
          <input type="hidden" name="sourceRecordId" value={row.id} />
          <input type="hidden" name="type" value={row.type} />
          <input
            type="hidden"
            name="entryMode"
            // A Gregorian-entered date keeps its Hebrew date: changing that
            // would re-open the sunset question, which is its own flow.
            value={row.enteredAsGregorian ? 'gregorian' : 'hebrew'}
          />
          {row.enteredAsGregorian ? <input type="hidden" name="gregorianDate" value="" /> : null}

          <label htmlFor={`name-${row.id}`}>Name</label>
          <input
            id={`name-${row.id}`}
            name="displayName"
            defaultValue={row.displayName}
            required
            maxLength={200}
          />

          {!row.enteredAsGregorian ? (
            <>
              <div className="row">
                <div className="stack">
                  <label htmlFor={`month-${row.id}`}>Hebrew month</label>
                  <select
                    id={`month-${row.id}`}
                    name="hebrewMonth"
                    defaultValue={row.hebrewMonth}
                  >
                    {MONTHS.map((month) => (
                      <option key={month.value} value={month.value}>
                        {month.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="stack">
                  <label htmlFor={`day-${row.id}`}>Day</label>
                  <input
                    id={`day-${row.id}`}
                    name="hebrewDay"
                    type="number"
                    min={1}
                    max={30}
                    defaultValue={row.hebrewDay}
                    required
                  />
                </div>
              </div>
              <label htmlFor={`year-${row.id}`}>Hebrew year</label>
              <input
                id={`year-${row.id}`}
                name="originalHebrewYear"
                type="number"
                min={1}
                max={7000}
                defaultValue={row.originalHebrewYear ?? ''}
              />
            </>
          ) : (
            <p className="muted small">
              This date was entered as an English date and is recorded as{' '}
              <strong>{row.hebrewDateLabel}</strong>. To change the Hebrew date itself, delete
              this entry and add it again.
            </p>
          )}

          <label htmlFor={`rel-${row.id}`}>Relationship</label>
          <input
            id={`rel-${row.id}`}
            name="relationship"
            defaultValue={row.relationship ?? ''}
            maxLength={100}
          />

          <label htmlFor={`notes-${row.id}`}>Notes</label>
          <input
            id={`notes-${row.id}`}
            name="notes"
            defaultValue={row.notes ?? ''}
            maxLength={500}
          />

          <p className="muted small">
            Correcting the Hebrew date moves the events already in your calendar to the new
            dates. Anniversaries that have already passed are left where they are.
          </p>

          <button type="submit" disabled={editing}>
            {editing ? 'Saving…' : 'Save and update my calendar'}
          </button>
        </form>
      ) : null}
      <Result state={editState} />

      {mode === 'delete' ? (
        <div className="inset">
          {previewing ? <p className="muted">Checking what would change…</p> : null}
          {preview && !preview.ok ? (
            <p className="notice notice-error">{preview.message}</p>
          ) : null}
          {preview?.preview ? (
            <>
              <p className="notice notice-warning">{preview.preview.summary}</p>

              {preview.preview.nextDatesToRemove.length > 0 ? (
                <>
                  <p className="small">The next dates that would be removed:</p>
                  <ul className="list small">
                    {preview.preview.nextDatesToRemove.map((date) => (
                      <li key={date.gregorianDate}>
                        <time dateTime={date.gregorianDate}>{date.gregorianDate}</time> —{' '}
                        {date.hebrewDateLabel}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {preview.preview.mostRecentKeptDate ? (
                <p className="small muted">
                  The most recent one already observed —{' '}
                  <time dateTime={preview.preview.mostRecentKeptDate.gregorianDate}>
                    {preview.preview.mostRecentKeptDate.gregorianDate}
                  </time>
                  , {preview.preview.mostRecentKeptDate.hebrewDateLabel} — stays in your
                  calendar.
                </p>
              ) : null}

              <div className="inline">
                <form action={remove}>
                  <input type="hidden" name="sourceRecordId" value={row.id} />
                  <button type="submit" className="danger" disabled={removing}>
                    {removing ? 'Deleting…' : `Delete ${row.displayName}`}
                  </button>
                </form>
                <button type="button" className="quiet" onClick={() => setMode('view')}>
                  Keep it
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      <Result state={deleteState} />
    </li>
  );
}

/* ------------------------------------------------------------------- sync -- */

export function SyncNowForm({ action }: { action: Action }) {
  const [state, submit, pending] = useActionState(action, EMPTY);
  return (
    <form action={submit} className="inline">
      <button type="submit" disabled={pending}>
        {pending ? 'Syncing…' : 'Sync now'}
      </button>
      <Result state={state} />
    </form>
  );
}

export function DisconnectForm({ action }: { action: Action }) {
  const [state, submit, pending] = useActionState(action, EMPTY);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" className="quiet" onClick={() => setConfirming(true)}>
        Disconnect Google Calendar
      </button>
    );
  }

  return (
    <form action={submit} className="stack">
      <p>
        Disconnecting removes Hebrew Dates’ access to your Google account. Your dates stay
        saved here.
      </p>
      <label>
        <input type="checkbox" name="deleteCalendar" value="yes" defaultChecked /> Also delete
        the “Hebrew Dates” calendar from Google
      </label>
      <div className="row">
        <button type="submit" disabled={pending}>
          {pending ? 'Disconnecting…' : 'Yes, disconnect'}
        </button>
        <button type="button" className="quiet" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
      <Result state={state} />
    </form>
  );
}
