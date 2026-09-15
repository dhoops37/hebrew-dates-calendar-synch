'use client';

/**
 * The dashboard's interactive parts.
 *
 * A client component only because it needs `useActionState` to show the result
 * of an action and the browser's own time zone to offer a location suggestion.
 * Everything that reads data stays on the server.
 */
import { useActionState, useEffect, useState } from 'react';
import type { ActionResult, DashboardAction as Action } from './actions';

const EMPTY: ActionResult | undefined = undefined;

function Result({ state }: { state: ActionResult | undefined }) {
  if (!state) return null;
  return (
    <p className={state.ok ? 'notice notice-ok' : 'notice notice-error'} role="status">
      {state.message}
    </p>
  );
}

/* --------------------------------------------------------------- location -- */

export interface LocationOption {
  id: string;
  displayName: string;
  timezoneId: string;
}

export function LocationForm({
  options,
  confirmAction,
  acceptSuggestionAction,
  currentDisplayName,
}: {
  options: LocationOption[];
  confirmAction: Action;
  acceptSuggestionAction: Action;
  currentDisplayName: string | undefined;
}) {
  const [confirmState, confirm, confirming] = useActionState(confirmAction, EMPTY);
  const [suggestState, accept, accepting] = useActionState(acceptSuggestionAction, EMPTY);
  const [browserZone, setBrowserZone] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Read once on the client. A time zone is only ever a *suggestion* here:
    // America/New_York spans Maine to Michigan, and sunset differs by nearly an
    // hour across it, so the user still has to agree.
    try {
      setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      setBrowserZone(undefined);
    }
  }, []);

  const suggestionMatches = browserZone
    ? options.find((option) => option.timezoneId === browserZone)
    : undefined;

  return (
    <section className="card">
      <h2>Location</h2>
      <p className="muted">
        Sunset times depend on where you are, so events run from sunset to sunset at this
        place. It is not the same thing as your calendar’s time zone, and you can change it
        later.
      </p>

      {currentDisplayName ? (
        <p>
          Currently set to <strong>{currentDisplayName}</strong>.
        </p>
      ) : (
        <p className="notice notice-warning">
          No location is confirmed yet, so nothing will be written to your calendar.
        </p>
      )}

      {suggestionMatches && suggestionMatches.displayName !== currentDisplayName ? (
        <form action={accept} className="stack">
          <input type="hidden" name="timezoneId" value={browserZone ?? ''} />
          <p>
            Your browser suggests <strong>{suggestionMatches.displayName}</strong> (
            {browserZone}). Is that right?
          </p>
          <button type="submit" disabled={accepting}>
            {accepting ? 'Confirming…' : `Yes, use ${suggestionMatches.displayName}`}
          </button>
        </form>
      ) : null}
      <Result state={suggestState} />

      <form action={confirm} className="stack">
        <label htmlFor="locationId">Or choose the nearest city</label>
        <select id="locationId" name="locationId" defaultValue="">
          <option value="" disabled>
            Choose a city…
          </option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.displayName}
            </option>
          ))}
        </select>
        <button type="submit" disabled={confirming}>
          {confirming ? 'Saving…' : 'Confirm this location'}
        </button>
      </form>
      <Result state={confirmState} />
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

/* ------------------------------------------------------------------- date -- */

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

        <button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add and sync to my calendar'}
        </button>
      </form>
      <Result state={state} />
    </section>
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
