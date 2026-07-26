/**
 * Sunset calculation.
 *
 * Two things here are easy to get wrong and are therefore handled explicitly:
 *
 * 1. **Server time zone leakage.** @hebcal's `Zmanim` constructor reads
 *    `date.getFullYear() / getMonth() / getDate()` from whatever `Date` it is
 *    given, which are *host-local* accessors. Passing an instant parsed from
 *    e.g. `"2024-06-20T00:00:00Z"` yields the previous day's sunset on any
 *    server west of Greenwich. This module therefore never accepts an instant:
 *    it takes a `CivilDate` and builds the `Date` from local components, which
 *    round-trips correctly under any `TZ`. test/timezones.test.ts pins this.
 *
 * 2. **Places where the sun does not set.** Above the polar circles `sunset()`
 *    returns an Invalid Date. An Invalid Date silently serialises to "Invalid
 *    Date" or throws at format time, and would otherwise reach a calendar
 *    event. It is converted into an explicit `no_sunset` result, classified as
 *    midnight sun or polar night, for the caller to handle.
 */
import { GeoLocation, Zmanim } from '@hebcal/core';
import type { CalculationLocation, CivilDate, SunsetResult } from './types';

/** Standard refraction-corrected solar altitude of sunset, in degrees. */
const SUNSET_ALTITUDE_DEG = -0.833;

function toGeoLocation(location: CalculationLocation): GeoLocation {
  const elevation = location.useElevation ? (location.elevationMeters ?? 0) : 0;
  return new GeoLocation(
    location.displayName,
    location.latitude,
    location.longitude,
    elevation,
    location.timezoneId,
  );
}

/**
 * Build the `Date` that @hebcal will read civil components back out of.
 * Constructed from local components on purpose - see the note above.
 */
function civilDateToHostLocalDate(date: CivilDate): Date {
  const d = new Date(date.year, date.month - 1, date.day, 12, 0, 0, 0);
  // Guard the Date constructor's 0-99 => 1900-1999 remapping.
  d.setFullYear(date.year);
  return d;
}

/** Sunset at a location on a civil day. */
export function sunsetOn(location: CalculationLocation, date: CivilDate): SunsetResult {
  const gloc = toGeoLocation(location);
  const zmanim = new Zmanim(gloc, civilDateToHostLocalDate(date), Boolean(location.useElevation));
  const sunset = zmanim.sunset();

  if (!(sunset instanceof Date) || Number.isNaN(sunset.getTime())) {
    return {
      status: 'no_sunset',
      timezoneId: location.timezoneId,
      reason: classifyPolarDay(location.latitude, date),
    };
  }

  return {
    status: 'ok',
    iso: Zmanim.formatISOWithTimeZone(location.timezoneId, sunset),
    epochMs: sunset.getTime(),
    utcOffset: Zmanim.timeZoneOffset(location.timezoneId, sunset),
    timezoneId: location.timezoneId,
  };
}

/**
 * Decide whether a day with no sunset is midnight sun or polar night.
 * Diagnostic only: this never feeds the sunset time itself, so a low-precision
 * solar declination is sufficient. Accuracy is around a quarter of a degree,
 * which only matters within a day or two of the start and end of the polar
 * period - and on those days there *is* a sunset, so this is not reached.
 */
export function classifyPolarDay(
  latitude: number,
  date: CivilDate,
): 'midnight_sun' | 'polar_night' {
  const declination = approximateSolarDeclinationDeg(date);
  // Altitude of the sun at local solar midnight.
  const midnightAltitude = Math.abs(latitude + declination) - 90;
  return midnightAltitude > SUNSET_ALTITUDE_DEG ? 'midnight_sun' : 'polar_night';
}

/** Low-precision solar declination in degrees (Cooper's equation). */
function approximateSolarDeclinationDeg(date: CivilDate): number {
  const dayOfYear = dayOfYearFor(date);
  return 23.45 * Math.sin(((2 * Math.PI) / 365) * (dayOfYear + 284));
}

function dayOfYearFor(date: CivilDate): number {
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const isLeap =
    (date.year % 4 === 0 && date.year % 100 !== 0) || date.year % 400 === 0;
  const monthOffset = cumulative[date.month - 1] ?? 0;
  return monthOffset + date.day + (isLeap && date.month > 2 ? 1 : 0);
}

/**
 * Format an instant as a wall-clock time in an IANA zone.
 * Used for display only; the stored value is always the RFC 3339 string.
 */
export function formatInZone(
  epochMs: number,
  timezoneId: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  },
  locale = 'en-US',
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezoneId }).format(
    new Date(epochMs),
  );
}
