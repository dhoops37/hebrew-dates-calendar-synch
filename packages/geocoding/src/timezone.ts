/**
 * Coordinates to IANA time zone, offline.
 *
 * `tz-lookup` carries a compressed shapefile of the zone boundaries and answers
 * from memory. Offline matters here for three reasons: a geocoding search is
 * already one network round trip and does not need a second, an outage in a
 * timezone service would otherwise block location confirmation entirely, and
 * every test can exercise the real thing rather than a stub.
 *
 * The zone is derived from the coordinates and **never** from the browser. A
 * user confirming their home city while travelling must get their home city's
 * zone, not the one they happen to be sitting in.
 */
// A triple-slash reference rather than relying on the declaration being picked
// up ambiently: another package in this workspace compiles this file as part of
// its own program, and an ambient .d.ts that is not in that program's `include`
// is simply not loaded.
/// <reference path="./tz-lookup.d.ts" />
import tzLookup from 'tz-lookup';

export class TimezoneLookupError extends Error {}

/**
 * The IANA zone containing a point.
 *
 * Throws rather than guessing. A coordinate with no zone means the input is
 * wrong — out of range, or transposed latitude and longitude — and defaulting
 * to UTC would produce sunset times that are quietly hours out.
 */
export function timezoneForCoordinates(latitude: number, longitude: number): string {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new TimezoneLookupError('Latitude and longitude must be finite numbers.');
  }
  if (latitude < -90 || latitude > 90) {
    throw new TimezoneLookupError(
      `Latitude ${latitude} is out of range. Latitude runs -90 to 90; a value outside ` +
        'that usually means latitude and longitude have been swapped.',
    );
  }
  if (longitude < -180 || longitude > 180) {
    throw new TimezoneLookupError(`Longitude ${longitude} is out of range (-180 to 180).`);
  }

  try {
    const zone = tzLookup(latitude, longitude);
    if (!zone) throw new TimezoneLookupError('No time zone found.');
    return zone;
  } catch (error) {
    if (error instanceof TimezoneLookupError) throw error;
    throw new TimezoneLookupError(
      `No time zone is known for ${latitude}, ${longitude}. Sunset cannot be calculated ` +
        'without one, so this place cannot be used.',
    );
  }
}

/**
 * Whether a string is a zone this runtime can actually format in.
 *
 * Used on the browser-supplied hint. A zone the server's ICU data does not know
 * would fail later, inside a date format, at a point far from the cause.
 */
export function isUsableTimezone(timezoneId: string): boolean {
  if (!timezoneId || timezoneId.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezoneId }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
