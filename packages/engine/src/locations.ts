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
import type { CalculationLocation } from './types';

export interface LocationProvider {
  search(query: string, limit?: number): Promise<CalculationLocation[]>;
  getById(id: string): Promise<CalculationLocation | undefined>;
}

/**
 * Elevations are approximate city-centre values. They are recorded for every
 * entry but only applied when `useElevation` is set on the saved location;
 * sea-level sunset is the default, matching common published calendars.
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
  },
  {
    id: 'seed:beit-shemesh',
    displayName: 'Beit Shemesh, Jerusalem District, Israel',
    countryCode: 'IL',
    latitude: 31.7497,
    longitude: 34.9886,
    timezoneId: 'Asia/Jerusalem',
    elevationMeters: 300,
  },
  {
    id: 'seed:tel-aviv',
    displayName: 'Tel Aviv-Yafo, Israel',
    countryCode: 'IL',
    latitude: 32.0853,
    longitude: 34.7818,
    timezoneId: 'Asia/Jerusalem',
    elevationMeters: 5,
  },
  {
    id: 'seed:new-york',
    displayName: 'New York, New York, USA',
    countryCode: 'US',
    latitude: 40.7128,
    longitude: -74.006,
    timezoneId: 'America/New_York',
    elevationMeters: 10,
  },
  {
    id: 'seed:lakewood',
    displayName: 'Lakewood, New Jersey, USA',
    countryCode: 'US',
    latitude: 40.0979,
    longitude: -74.2179,
    timezoneId: 'America/New_York',
    elevationMeters: 16,
  },
  {
    id: 'seed:los-angeles',
    displayName: 'Los Angeles, California, USA',
    countryCode: 'US',
    latitude: 34.0522,
    longitude: -118.2437,
    timezoneId: 'America/Los_Angeles',
    elevationMeters: 71,
  },
  {
    id: 'seed:chicago',
    displayName: 'Chicago, Illinois, USA',
    countryCode: 'US',
    latitude: 41.8781,
    longitude: -87.6298,
    timezoneId: 'America/Chicago',
    elevationMeters: 181,
  },
  {
    id: 'seed:miami',
    displayName: 'Miami, Florida, USA',
    countryCode: 'US',
    latitude: 25.7617,
    longitude: -80.1918,
    timezoneId: 'America/New_York',
    elevationMeters: 2,
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
  },
  {
    id: 'seed:toronto',
    displayName: 'Toronto, Ontario, Canada',
    countryCode: 'CA',
    latitude: 43.6532,
    longitude: -79.3832,
    timezoneId: 'America/Toronto',
    elevationMeters: 76,
  },
  {
    id: 'seed:london',
    displayName: 'London, United Kingdom',
    countryCode: 'GB',
    latitude: 51.5074,
    longitude: -0.1278,
    timezoneId: 'Europe/London',
    elevationMeters: 11,
  },
  {
    id: 'seed:manchester',
    displayName: 'Manchester, United Kingdom',
    countryCode: 'GB',
    latitude: 53.4808,
    longitude: -2.2426,
    timezoneId: 'Europe/London',
    elevationMeters: 38,
  },
  {
    id: 'seed:paris',
    displayName: 'Paris, France',
    countryCode: 'FR',
    latitude: 48.8566,
    longitude: 2.3522,
    timezoneId: 'Europe/Paris',
    elevationMeters: 35,
  },
  {
    id: 'seed:antwerp',
    displayName: 'Antwerp, Belgium',
    countryCode: 'BE',
    latitude: 51.2194,
    longitude: 4.4025,
    timezoneId: 'Europe/Brussels',
    elevationMeters: 7,
  },
  {
    id: 'seed:melbourne',
    displayName: 'Melbourne, Victoria, Australia',
    countryCode: 'AU',
    latitude: -37.8136,
    longitude: 144.9631,
    timezoneId: 'Australia/Melbourne',
    elevationMeters: 31,
  },
  {
    id: 'seed:sydney',
    displayName: 'Sydney, New South Wales, Australia',
    countryCode: 'AU',
    latitude: -33.8688,
    longitude: 151.2093,
    timezoneId: 'Australia/Sydney',
    elevationMeters: 19,
  },
  {
    id: 'seed:johannesburg',
    displayName: 'Johannesburg, South Africa',
    countryCode: 'ZA',
    latitude: -26.2041,
    longitude: 28.0473,
    timezoneId: 'Africa/Johannesburg',
    elevationMeters: 1753,
  },
  {
    id: 'seed:buenos-aires',
    displayName: 'Buenos Aires, Argentina',
    countryCode: 'AR',
    latitude: -34.6037,
    longitude: -58.3816,
    timezoneId: 'America/Argentina/Buenos_Aires',
    elevationMeters: 25,
  },
  {
    id: 'seed:mexico-city',
    displayName: 'Mexico City, Mexico',
    countryCode: 'MX',
    latitude: 19.4326,
    longitude: -99.1332,
    timezoneId: 'America/Mexico_City',
    elevationMeters: 2240,
  },
  {
    id: 'seed:moscow',
    displayName: 'Moscow, Russia',
    countryCode: 'RU',
    latitude: 55.7558,
    longitude: 37.6173,
    timezoneId: 'Europe/Moscow',
    elevationMeters: 156,
  },
  {
    id: 'seed:anchorage',
    displayName: 'Anchorage, Alaska, USA',
    countryCode: 'US',
    latitude: 61.2181,
    longitude: -149.9003,
    timezoneId: 'America/Anchorage',
    elevationMeters: 31,
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

/** Built-in provider used by the Phase 1 prototype. */
export const seedLocationProvider: LocationProvider = {
  async search(query, limit) {
    return searchSeedLocations(query, limit);
  },
  async getById(id) {
    return getSeedLocation(id);
  },
};
