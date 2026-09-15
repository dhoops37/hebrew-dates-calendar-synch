/**
 * Location provider.
 *
 * Phase 1 ships a small built-in catalogue rather than calling a geocoder: it
 * keeps the prototype free of API keys and network calls, and it covers the
 * whole test matrix in PRD 35.3. The `LocationProvider` interface is the seam a
 * real geocoder plugs into later (PRD 25, "abstracted behind an internal
 * interface").
 *
 * Every entry carries an IANA time zone alongside the coordinates, because the
 * zone cannot be derived from coordinates at run time and is required to render
 * a sunset instant as a wall-clock time.
 */
import type { CalculationLocation, LocationSource, LocationSuggestion } from './types';

export interface LocationProvider {
  search(query: string, limit?: number): Promise<CalculationLocation[]>;
  getById(id: string): Promise<CalculationLocation | undefined>;
}

/**
 * Elevations are approximate city-centre values.
 *
 * `useElevation` is set explicitly on every entry rather than defaulted
 * anywhere, because it changes the answer: at Jerusalem's ~750 m it moves sunset
 * about five minutes later than the sea-level figure. It is part of the
 * calculation snapshot for exactly that reason.
 *
 * Note for the halachic review: applying elevation to shkia is a real question,
 * and this default differs from hebcal.com, which publishes sea-level times.
 * Flipping it is a one-line data change plus a recalculation job.
 */
export const SEED_LOCATIONS: CalculationLocation[] = [
  {
    id: 'seed:jerusalem',
    displayName: 'Jerusalem, Israel',
    countryCode: 'IL',
    latitude: 31.7683,
    longitude: 35.2137,
    timezoneId: 'Asia/Jerusalem',
    elevationMeters: 754,
    useElevation: true,
  },
  {
    id: 'seed:beit-shemesh',
    displayName: 'Beit Shemesh, Jerusalem District, Israel',
    countryCode: 'IL',
    latitude: 31.7497,
    longitude: 34.9886,
    timezoneId: 'Asia/Jerusalem',
    elevationMeters: 300,
    useElevation: true,
  },
  {
    id: 'seed:tel-aviv',
    displayName: 'Tel Aviv-Yafo, Israel',
    countryCode: 'IL',
    latitude: 32.0853,
    longitude: 34.7818,
    timezoneId: 'Asia/Jerusalem',
    elevationMeters: 5,
    useElevation: true,
  },
  {
    id: 'seed:new-york',
    displayName: 'New York, New York, USA',
    countryCode: 'US',
    latitude: 40.7128,
    longitude: -74.006,
    timezoneId: 'America/New_York',
    elevationMeters: 10,
    useElevation: true,
  },
  {
    id: 'seed:lakewood',
    displayName: 'Lakewood, New Jersey, USA',
    countryCode: 'US',
    latitude: 40.0979,
    longitude: -74.2179,
    timezoneId: 'America/New_York',
    elevationMeters: 16,
    useElevation: true,
  },
  {
    id: 'seed:los-angeles',
    displayName: 'Los Angeles, California, USA',
    countryCode: 'US',
    latitude: 34.0522,
    longitude: -118.2437,
    timezoneId: 'America/Los_Angeles',
    elevationMeters: 71,
    useElevation: true,
  },
  {
    id: 'seed:chicago',
    displayName: 'Chicago, Illinois, USA',
    countryCode: 'US',
    latitude: 41.8781,
    longitude: -87.6298,
    timezoneId: 'America/Chicago',
    elevationMeters: 181,
    useElevation: true,
  },
  {
    id: 'seed:miami',
    displayName: 'Miami, Florida, USA',
    countryCode: 'US',
    latitude: 25.7617,
    longitude: -80.1918,
    timezoneId: 'America/New_York',
    elevationMeters: 2,
    useElevation: true,
  },
  {
    // No daylight saving - PRD 35.3 requires one.
    id: 'seed:phoenix',
    displayName: 'Phoenix, Arizona, USA',
    countryCode: 'US',
    latitude: 33.4484,
    longitude: -112.074,
    timezoneId: 'America/Phoenix',
    elevationMeters: 331,
    useElevation: true,
  },
  {
    id: 'seed:toronto',
    displayName: 'Toronto, Ontario, Canada',
    countryCode: 'CA',
    latitude: 43.6532,
    longitude: -79.3832,
    timezoneId: 'America/Toronto',
    elevationMeters: 76,
    useElevation: true,
  },
  {
    id: 'seed:london',
    displayName: 'London, United Kingdom',
    countryCode: 'GB',
    latitude: 51.5074,
    longitude: -0.1278,
    timezoneId: 'Europe/London',
    elevationMeters: 11,
    useElevation: true,
  },
  {
    id: 'seed:manchester',
    displayName: 'Manchester, United Kingdom',
    countryCode: 'GB',
    latitude: 53.4808,
    longitude: -2.2426,
    timezoneId: 'Europe/London',
    elevationMeters: 38,
    useElevation: true,
  },
  {
    id: 'seed:paris',
    displayName: 'Paris, France',
    countryCode: 'FR',
    latitude: 48.8566,
    longitude: 2.3522,
    timezoneId: 'Europe/Paris',
    elevationMeters: 35,
    useElevation: true,
  },
  {
    id: 'seed:antwerp',
    displayName: 'Antwerp, Belgium',
    countryCode: 'BE',
    latitude: 51.2194,
    longitude: 4.4025,
    timezoneId: 'Europe/Brussels',
    elevationMeters: 7,
    useElevation: true,
  },
  {
    id: 'seed:melbourne',
    displayName: 'Melbourne, Victoria, Australia',
    countryCode: 'AU',
    latitude: -37.8136,
    longitude: 144.9631,
    timezoneId: 'Australia/Melbourne',
    elevationMeters: 31,
    useElevation: true,
  },
  {
    id: 'seed:sydney',
    displayName: 'Sydney, New South Wales, Australia',
    countryCode: 'AU',
    latitude: -33.8688,
    longitude: 151.2093,
    timezoneId: 'Australia/Sydney',
    elevationMeters: 19,
    useElevation: true,
  },
  {
    id: 'seed:johannesburg',
    displayName: 'Johannesburg, South Africa',
    countryCode: 'ZA',
    latitude: -26.2041,
    longitude: 28.0473,
    timezoneId: 'Africa/Johannesburg',
    elevationMeters: 1753,
    useElevation: true,
  },
  {
    id: 'seed:buenos-aires',
    displayName: 'Buenos Aires, Argentina',
    countryCode: 'AR',
    latitude: -34.6037,
    longitude: -58.3816,
    timezoneId: 'America/Argentina/Buenos_Aires',
    elevationMeters: 25,
    useElevation: true,
  },
  {
    id: 'seed:mexico-city',
    displayName: 'Mexico City, Mexico',
    countryCode: 'MX',
    latitude: 19.4326,
    longitude: -99.1332,
    timezoneId: 'America/Mexico_City',
    elevationMeters: 2240,
    useElevation: true,
  },
  {
    id: 'seed:moscow',
    displayName: 'Moscow, Russia',
    countryCode: 'RU',
    latitude: 55.7558,
    longitude: 37.6173,
    timezoneId: 'Europe/Moscow',
    elevationMeters: 156,
    useElevation: true,
  },
  {
    id: 'seed:anchorage',
    displayName: 'Anchorage, Alaska, USA',
    countryCode: 'US',
    latitude: 61.2181,
    longitude: -149.9003,
    timezoneId: 'America/Anchorage',
    elevationMeters: 31,
    useElevation: true,
  },
  {
    // Above the Arctic Circle: the sun does not set in midsummer, and does not
    // rise in midwinter. Included so the no-sunset path is exercised.
    id: 'seed:tromso',
    displayName: 'Tromsø, Norway',
    countryCode: 'NO',
    latitude: 69.6492,
    longitude: 18.9553,
    timezoneId: 'Europe/Oslo',
    elevationMeters: 10,
    useElevation: true,
  },
];

const byId = new Map(SEED_LOCATIONS.map((location) => [location.id, location]));

function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function searchSeedLocations(query: string, limit = 10): CalculationLocation[] {
  const needle = normalise(query);
  if (!needle) return SEED_LOCATIONS.slice(0, limit);
  const matches = SEED_LOCATIONS.filter((location) =>
    normalise(location.displayName).includes(needle),
  );
  // Prefer matches at the start of the name, e.g. "man" -> Manchester.
  matches.sort((a, b) => {
    const aStarts = normalise(a.displayName).startsWith(needle) ? 0 : 1;
    const bStarts = normalise(b.displayName).startsWith(needle) ? 0 : 1;
    return aStarts - bStarts || a.displayName.localeCompare(b.displayName);
  });
  return matches.slice(0, limit);
}

export function getSeedLocation(id: string): CalculationLocation | undefined {
  return byId.get(id);
}

/** A sea-level copy of a location, for comparing against published tables. */
export function atSeaLevel(location: CalculationLocation): CalculationLocation {
  return { ...location, useElevation: false };
}

/**
 * Propose a calculation location from an IANA time zone.
 *
 * Used at setup to pre-fill something sensible — from the destination calendar's
 * own zone once Google is connected, or from the browser's zone before that — so
 * the common case needs no searching.
 *
 * It returns a **suggestion, not a location**, and deliberately so. A time zone
 * is not a place: `America/New_York` spans about 20° of longitude, across which
 * sunset differs by more than half an hour, and some zones span far more. The
 * user confirms the resolved place name during onboarding before anything is
 * calculated from it for real.
 *
 * Returns `undefined` rather than a wrong guess when nothing in the catalogue
 * shares the zone or even the region.
 */
export function suggestLocationForTimezone(
  timezoneId: string | undefined,
  source: LocationSource = 'timezone_suggestion',
): LocationSuggestion | undefined {
  if (!timezoneId) return undefined;

  const exact = SEED_LOCATIONS.find((location) => location.timezoneId === timezoneId);
  // Fall back to the same region, e.g. an unknown "America/Detroit" lands on a
  // catalogue city in the Americas rather than on Jerusalem.
  const region = timezoneId.split('/')[0];
  const sameRegion = SEED_LOCATIONS.find(
    (location) => location.timezoneId.split('/')[0] === region,
  );
  const match = exact ?? sameRegion;
  if (!match) return undefined;

  const origin =
    source === 'calendar_timezone_hint'
      ? "your calendar's time zone"
      : "your device's time zone";
  return {
    location: { ...match, source, confirmedByUser: false },
    source,
    derivedFromTimezoneId: timezoneId,
    explanation:
      `Suggested from ${origin} (${timezoneId}). Sunset is calculated from the ` +
      `coordinates of ${match.displayName}, not from the time zone, so please ` +
      'confirm this is the right place — one time zone can span more than half an ' +
      'hour of sunset difference.',
    requiresConfirmation: true,
  };
}

/**
 * Mark a location as confirmed by the user. This is the only way a location
 * becomes eligible for writing events: the sync planner refuses unconfirmed
 * ones, so a suggestion can never silently become a calculation.
 */
export function confirmLocation(
  location: CalculationLocation,
  source: LocationSource = 'user_selected',
): CalculationLocation {
  return { ...location, source, confirmedByUser: true };
}

/** Built-in provider used by the Phase 1 prototype. */
export const seedLocationProvider: LocationProvider = {
  async search(query, limit) {
    return searchSeedLocations(query, limit);
  },
  async getById(id) {
    return getSeedLocation(id);
  },
};
