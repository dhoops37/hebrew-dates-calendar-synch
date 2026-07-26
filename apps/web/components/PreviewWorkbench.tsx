'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CalculationLocation,
  DisplayMode,
  HebrewMonthName,
  Occurrence,
  SourceRecordType,
} from '@hebrew-dates/engine';
import type { PreviewRequest, PreviewResponse } from '@/lib/preview';

const MONTH_LABELS: Record<HebrewMonthName, string> = {
  TISHREI: 'Tishrei',
  CHESHVAN: 'Cheshvan',
  KISLEV: 'Kislev',
  TEVET: 'Tevet',
  SHVAT: 'Shevat',
  ADAR: 'Adar (ordinary year)',
  ADAR_I: 'Adar I (leap year)',
  ADAR_II: 'Adar II (leap year)',
  NISAN: 'Nisan',
  IYYAR: 'Iyyar',
  SIVAN: 'Sivan',
  TAMUZ: 'Tamuz',
  AV: 'Av',
  ELUL: 'Elul',
};

interface Props {
  locations: CalculationLocation[];
  months: HebrewMonthName[];
}

/**
 * The export is a GET so it can be a plain download link. Only the fields the
 * current entry mode actually uses are sent, to keep the URL readable.
 */
function exportUrl(request: PreviewRequest): string {
  const params = new URLSearchParams({
    locationId: request.locationId,
    type: request.type,
    displayName: request.displayName,
    displayMode: request.displayMode,
    entryMode: request.entryMode,
    count: '50',
  });
  if (request.entryMode === 'hebrew') {
    if (request.hebrewMonth) params.set('hebrewMonth', request.hebrewMonth);
    if (request.hebrewDay) params.set('hebrewDay', String(request.hebrewDay));
    if (request.hebrewYear) params.set('hebrewYear', String(request.hebrewYear));
  } else {
    if (request.gregorianDate) params.set('gregorianDate', request.gregorianDate);
    if (request.sunsetStatus) params.set('sunsetStatus', request.sunsetStatus);
  }
  return `/api/export.ics?${params.toString()}`;
}

export default function PreviewWorkbench({ locations, months }: Props) {
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [type, setType] = useState<SourceRecordType>('birthday');
  const [displayName, setDisplayName] = useState('David');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('exact_sunset');
  const [entryMode, setEntryMode] = useState<'hebrew' | 'gregorian'>('hebrew');
  const [hebrewMonth, setHebrewMonth] = useState<HebrewMonthName>('NISAN');
  const [hebrewDay, setHebrewDay] = useState(10);
  const [hebrewYear, setHebrewYear] = useState<string>('');
  const [gregorianDate, setGregorianDate] = useState('1978-05-12');
  const [sunsetStatus, setSunsetStatus] = useState<'before_sunset' | 'after_sunset' | 'unknown'>(
    'unknown',
  );
  const [response, setResponse] = useState<PreviewResponse | null>(null);
  const [pending, setPending] = useState(false);

  const request = useMemo<PreviewRequest>(
    () => ({
      locationId,
      type,
      displayName,
      displayMode,
      entryMode,
      hebrewMonth,
      hebrewDay,
      hebrewYear: hebrewYear ? Number(hebrewYear) : null,
      gregorianDate,
      sunsetStatus,
      count: 20,
    }),
    [
      locationId,
      type,
      displayName,
      displayMode,
      entryMode,
      hebrewMonth,
      hebrewDay,
      hebrewYear,
      gregorianDate,
      sunsetStatus,
    ],
  );

  const runPreview = useCallback(async (payload: PreviewRequest) => {
    setPending(true);
    try {
      const result = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setResponse((await result.json()) as PreviewResponse);
    } catch (error) {
      setResponse({
        status: 'error',
        message: error instanceof Error ? error.message : 'Preview failed',
      });
    } finally {
      setPending(false);
    }
  }, []);

  // Preview on load, and whenever the display mode changes, so switching
  // between the two display modes is immediate.
  useEffect(() => {
    void runPreview(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayMode]);

  const selectedLocation = locations.find((location) => location.id === locationId);

  return (
    <div className="layout">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runPreview(request);
        }}
      >
        <section className="card" aria-labelledby="location-heading">
          <h2 id="location-heading">1. Calculation location</h2>
          <div className="field">
            <label htmlFor="location">Location</label>
            <select
              id="location"
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
            >
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.displayName}
                </option>
              ))}
            </select>
            {selectedLocation ? (
              <p className="hint">
                {selectedLocation.latitude.toFixed(4)}, {selectedLocation.longitude.toFixed(4)} ·{' '}
                {selectedLocation.timezoneId}
                {selectedLocation.elevationMeters !== undefined
                  ? ` · ${selectedLocation.elevationMeters} m (sea-level sunset used)`
                  : ''}
              </p>
            ) : null}
          </div>
        </section>

        <section className="card" aria-labelledby="record-heading">
          <h2 id="record-heading">2. The date</h2>

          <fieldset>
            <legend>Record type</legend>
            <div className="radio-row">
              {(
                [
                  ['birthday', 'Hebrew birthday'],
                  ['personal_yahrzeit', 'Personal yahrzeit'],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="type"
                    value={value}
                    checked={type === value}
                    onChange={() => setType(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field">
            <label htmlFor="displayName">Name</label>
            <input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <fieldset>
            <legend>How do you know the date?</legend>
            <div className="radio-row">
              <label>
                <input
                  type="radio"
                  name="entryMode"
                  checked={entryMode === 'hebrew'}
                  onChange={() => setEntryMode('hebrew')}
                />
                Hebrew date
              </label>
              <label>
                <input
                  type="radio"
                  name="entryMode"
                  checked={entryMode === 'gregorian'}
                  onChange={() => setEntryMode('gregorian')}
                />
                Gregorian date
              </label>
            </div>
          </fieldset>

          {entryMode === 'hebrew' ? (
            <>
              <div className="split">
                <div className="field">
                  <label htmlFor="hebrewMonth">Hebrew month</label>
                  <select
                    id="hebrewMonth"
                    value={hebrewMonth}
                    onChange={(event) => setHebrewMonth(event.target.value as HebrewMonthName)}
                  >
                    {months.map((month) => (
                      <option key={month} value={month}>
                        {MONTH_LABELS[month]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="hebrewDay">Day</label>
                  <input
                    id="hebrewDay"
                    type="number"
                    min={1}
                    max={30}
                    value={hebrewDay}
                    onChange={(event) => setHebrewDay(Number(event.target.value))}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="hebrewYear">Hebrew year of birth or death (optional)</label>
                <input
                  id="hebrewYear"
                  type="number"
                  placeholder="e.g. 5738"
                  value={hebrewYear}
                  onChange={(event) => setHebrewYear(event.target.value)}
                />
                <p className="hint">
                  Adar, Adar I and Adar II are offered separately because the choice itself tells
                  Hebrew Dates whether the original year was a leap year. A yahrzeit on 30 Cheshvan
                  or 30 Kislev needs the year.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="gregorianDate">Gregorian date</label>
                <input
                  id="gregorianDate"
                  type="date"
                  value={gregorianDate}
                  onChange={(event) => setGregorianDate(event.target.value)}
                />
              </div>
              <fieldset>
                <legend>Did this happen before or after sunset?</legend>
                <div className="radio-row">
                  {(
                    [
                      ['before_sunset', 'Before sunset'],
                      ['after_sunset', 'After sunset'],
                      ['unknown', 'I am not sure'],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name="sunsetStatus"
                        checked={sunsetStatus === value}
                        onChange={() => setSunsetStatus(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          )}
        </section>

        <section className="card" aria-labelledby="display-heading">
          <h2 id="display-heading">3. Display mode</h2>
          <fieldset>
            <legend>How should Hebrew dates appear?</legend>
            <div className="radio-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <label>
                <input
                  type="radio"
                  name="displayMode"
                  checked={displayMode === 'exact_sunset'}
                  onChange={() => setDisplayMode('exact_sunset')}
                />
                Exact sunset times — recommended
              </label>
              <label>
                <input
                  type="radio"
                  name="displayMode"
                  checked={displayMode === 'two_day_all_day'}
                  onChange={() => setDisplayMode('two_day_all_day')}
                />
                Across both calendar days
              </label>
            </div>
          </fieldset>
          <button type="submit" disabled={pending}>
            {pending ? 'Calculating…' : 'Preview next 20 occurrences'}
          </button>
          {response?.status === 'ok' ? (
            <p className="hint" style={{ marginBlockStart: 12 }}>
              <a href={exportUrl(request)} download>
                Download 50 years as .ics
              </a>{' '}
              — import this into Google or Apple Calendar to see the real events. No account
              needed.
            </p>
          ) : null}
        </section>
      </form>

      <section aria-live="polite" aria-labelledby="results-heading">
        <h2 id="results-heading" className="visually-hidden" style={{ position: 'absolute', left: -9999 }}>
          Results
        </h2>
        <Results response={response} displayMode={displayMode} pending={pending} />
      </section>
    </div>
  );
}

function Results({
  response,
  displayMode,
  pending,
}: {
  response: PreviewResponse | null;
  displayMode: DisplayMode;
  pending: boolean;
}) {
  if (!response) {
    return (
      <div className="card">
        <p className="empty">{pending ? 'Calculating…' : 'Choose a date to see a preview.'}</p>
      </div>
    );
  }

  if (response.status === 'error') {
    return (
      <div className="card">
        <div className="notice error" role="alert">
          <h3>That date cannot be used</h3>
          <p>{response.message}</p>
        </div>
      </div>
    );
  }

  if (response.status === 'needs_user_decision') {
    // The engine refused to choose. This is the behaviour the PRD calls for:
    // never silently resolve an ambiguous date.
    return (
      <div className="card">
        <div className="notice info" role="status">
          <h3>{response.question}</h3>
          <p>{response.explanation}</p>
          <ul>
            {response.options.map((option) => (
              <li key={option.id}>{option.label}</li>
            ))}
          </ul>
          <p>
            <strong>No occurrences have been generated.</strong> Choose one of the options above in
            the form to continue.
          </p>
        </div>
      </div>
    );
  }

  const { occurrences, location, origin, requiresReview, interpretedFrom } = response;
  const first = occurrences[0];

  return (
    <div className="card">
      <dl className="summary-grid">
        <div>
          <dt>Interpreted Hebrew date</dt>
          <dd>
            {origin.day} {MONTH_LABELS[origin.month].replace(/ \(.*\)$/, '')}
            {origin.year ? ` ${origin.year}` : ''}
          </dd>
        </div>
        <div>
          <dt>Next occurrence</dt>
          <dd>{first ? first.labels.enWithYear : '—'}</dd>
        </div>
        <div>
          <dt>Calculation location</dt>
          <dd>{location.displayName}</dd>
        </div>
        <div>
          <dt>Time zone</dt>
          <dd>{location.timezoneId}</dd>
        </div>
        <div>
          <dt>Display mode</dt>
          <dd>{displayMode === 'exact_sunset' ? 'Exact sunset' : 'Two-day all-day'}</dd>
        </div>
        <div>
          <dt>Years generated</dt>
          <dd>{occurrences.length}</dd>
        </div>
      </dl>

      {interpretedFrom?.sunsetIso ? (
        <p className="hint">
          Sunset on {interpretedFrom.gregorianDate} at this location was {interpretedFrom.sunsetIso}.
          You said the event was {interpretedFrom.sunsetStatus.replace('_', ' ')}.
        </p>
      ) : null}

      {requiresReview ? (
        <div className="notice warning" role="status" style={{ marginBlockEnd: 16 }}>
          <h3>Some years need your review</h3>
          <p>
            There are different customs concerning how this date is observed in certain Hebrew
            years. Hebrew Dates is applying the selected calendar convention. Please follow your
            family custom or consult your rabbi when appropriate. Affected years are flagged below.
          </p>
        </div>
      ) : null}

      <div className="table-scroll">
        <table>
          <caption className="hint" style={{ captionSide: 'bottom', textAlign: 'start' }}>
            Each row is an individually generated occurrence with its own stable identifier. No
            Gregorian yearly recurrence rule is used.
          </caption>
          <thead>
            <tr>
              <th scope="col">Hebrew year</th>
              <th scope="col">Hebrew date</th>
              <th scope="col">עברית</th>
              {displayMode === 'exact_sunset' ? (
                <>
                  <th scope="col">Begins (sunset)</th>
                  <th scope="col">Ends (sunset)</th>
                  <th scope="col">Length</th>
                </>
              ) : (
                <>
                  <th scope="col">All-day span</th>
                  <th scope="col">Ends (exclusive)</th>
                  <th scope="col">Sunset boundaries</th>
                </>
              )}
              <th scope="col">Rule</th>
              <th scope="col">Occurrence key</th>
            </tr>
          </thead>
          <tbody>
            {occurrences.map((occurrence) => (
              <OccurrenceRow
                key={occurrence.key}
                occurrence={occurrence}
                displayMode={displayMode}
              />
            ))}
          </tbody>
        </table>
      </div>

      {occurrences.some((occurrence) => occurrence.warnings.length > 0) ? (
        <details className="rules" open>
          <summary>Notes on flagged years</summary>
          <ul>
            {occurrences
              .filter((occurrence) => occurrence.warnings.length > 0)
              .map((occurrence) => (
                <li key={occurrence.key}>
                  <strong>{occurrence.hebrewYear}:</strong>{' '}
                  {occurrence.warnings.map((warning) => warning.message).join(' ')}
                </li>
              ))}
          </ul>
        </details>
      ) : null}

      {first ? (
        <details className="rules">
          <summary>Event content that would be written to a calendar</summary>
          <p className="mono" style={{ whiteSpace: 'pre-wrap' }}>
            {first.title}
            {'\n\n'}
            {first.description}
          </p>
        </details>
      ) : null}
    </div>
  );
}

function OccurrenceRow({
  occurrence,
  displayMode,
}: {
  occurrence: Occurrence;
  displayMode: DisplayMode;
}) {
  const flagged = occurrence.ambiguities.length > 0;
  const noSunset = occurrence.timing === null;

  return (
    <tr>
      <td>{occurrence.hebrewYear}</td>
      <td className="wrap">
        {occurrence.labels.en}{' '}
        {flagged ? <span className="flag">review</span> : null}
        <div className="mono">{isoDate(occurrence.gregorianDate)}</div>
      </td>
      <td className="hebrew" lang="he" dir="rtl">
        {occurrence.labels.he}
      </td>
      {displayMode === 'exact_sunset' ? (
        <>
          <td>{noSunset ? '—' : formatLocal(occurrence.timing!.startIso)}</td>
          <td>{noSunset ? '—' : formatLocal(occurrence.timing!.endIso)}</td>
          <td>
            {noSunset ? (
              <span className="flag">no sunset</span>
            ) : (
              `${Math.floor(occurrence.timing!.durationMinutes / 60)}h ${occurrence.timing!.durationMinutes % 60}m`
            )}
          </td>
        </>
      ) : (
        <>
          <td>
            {occurrence.allDay.startDate} → {isoDate(occurrence.gregorianDate)}
          </td>
          <td className="mono">{occurrence.allDay.endDateExclusive}</td>
          <td className="mono">
            {occurrence.timing
              ? `${timeOnly(occurrence.timing.startIso)} → ${timeOnly(occurrence.timing.endIso)}`
              : 'no sunset'}
          </td>
        </>
      )}
      <td className="mono">{occurrence.ruleApplied.toLowerCase().replace(/_/g, ' ')}</td>
      <td className="mono">{occurrence.key.slice(0, 10)}…</td>
    </tr>
  );
}

function isoDate(date: { year: number; month: number; day: number }): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/**
 * The ISO string already carries the location's offset, so the wall-clock time
 * is read straight out of it rather than being re-derived in the browser's zone.
 */
function formatLocal(iso: string): string {
  const [datePart, timePart] = iso.split('T');
  return `${datePart} ${timePart?.slice(0, 5) ?? ''}`;
}

function timeOnly(iso: string): string {
  return iso.split('T')[1]?.slice(0, 5) ?? '';
}
