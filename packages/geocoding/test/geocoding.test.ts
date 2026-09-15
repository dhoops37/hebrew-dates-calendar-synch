/**
 * Geocoding.
 *
 * The Nominatim double returns real response shapes — the payloads below are
 * trimmed copies of what the live service actually sends, including the long
 * administrative chain and the postcode that has to be stripped.
 *
 * The properties under test are the product's, not the vendor's: a time zone is
 * derived from coordinates rather than trusted from anywhere else, the usage
 * policy is honoured rather than documented, and a geocoder outage degrades to
 * the built-in cities instead of blocking a user on the location step.
 */
import { describe, expect, it } from 'vitest';
import { SEED_LOCATIONS } from '@hebrew-dates/engine';
import {
  CatalogueProvider,
  CompositeGeocoder,
  GeocodingUnavailableError,
  NominatimProvider,
  QueryTooShortError,
  TimezoneLookupError,
  isUsableTimezone,
  resolveGeocoder,
  roughDistanceKm,
  tidyDisplayName,
  timezoneForCoordinates,
} from '../src/index';

const USER_AGENT = 'HebrewDates/1.0 (https://hebrewdates.test; test@example.test)';

/** Trimmed from a real `search?q=Lakewood` response. */
const LAKEWOOD = {
  place_id: 298741234,
  osm_type: 'relation',
  osm_id: 172917,
  lat: '40.0959589',
  lon: '-74.2176928',
  display_name:
    'Lakewood Township, Ocean County, New Jersey, 08701, United States',
  name: 'Lakewood Township',
  type: 'administrative',
  class: 'boundary',
  importance: 0.5423,
  address: {
    town: 'Lakewood Township',
    county: 'Ocean County',
    state: 'New Jersey',
    postcode: '08701',
    country: 'United States',
    country_code: 'us',
  },
};

const JERUSALEM = {
  place_id: 297162543,
  osm_type: 'relation',
  osm_id: 1382494,
  lat: '31.7788242',
  lon: '35.2257626',
  display_name: 'Jerusalem, Jerusalem District, Israel',
  name: 'Jerusalem',
  type: 'city',
  class: 'place',
  importance: 0.7541,
  address: {
    city: 'Jerusalem',
    state: 'Jerusalem District',
    country: 'Israel',
    country_code: 'il',
  },
};

/** A shop. Real results include these; the product must not offer them. */
const A_SHOP = {
  place_id: 1,
  osm_type: 'node',
  osm_id: 999,
  lat: '40.1',
  lon: '-74.2',
  display_name: "Gelbstein's Bakery, Clifton Avenue, Lakewood, New Jersey, United States",
  name: "Gelbstein's Bakery",
  type: 'bakery',
  class: 'shop',
  importance: 0.12,
  address: { road: 'Clifton Avenue', state: 'New Jersey', country_code: 'us' },
};

interface FakeNominatimOptions {
  places?: unknown[];
  status?: number;
  failTimes?: number;
}

function fakeNominatim(options: FakeNominatimOptions = {}) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  let remainingFailures = options.failTimes ?? 0;

  const doFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url, headers });

    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return new Response('rate limited', { status: 429 });
    }
    if (options.status && options.status !== 200) {
      return new Response('error', { status: options.status });
    }
    return new Response(JSON.stringify(options.places ?? [LAKEWOOD]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetch: doFetch, requests };
}

/** No real sleeping; record what the throttle asked for. */
function instantSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

/* ------------------------------------------------------------- time zones -- */

describe('timezoneForCoordinates', () => {
  it('resolves a zone from coordinates alone', () => {
    expect(timezoneForCoordinates(31.7781, 35.2352)).toBe('Asia/Jerusalem');
    expect(timezoneForCoordinates(40.6782, -73.9442)).toBe('America/New_York');
    expect(timezoneForCoordinates(-34.6037, -58.3816)).toBe('America/Argentina/Buenos_Aires');
    expect(timezoneForCoordinates(27.7172, 85.324)).toBe('Asia/Kathmandu');
  });

  it('distinguishes places a time zone cannot', () => {
    // The reason a time zone is never a calculation location: these two are in
    // the same zone and their sunsets differ by around 40 minutes.
    const lakewood = timezoneForCoordinates(40.0979, -74.2179);
    const detroit = timezoneForCoordinates(42.3314, -83.0458);
    expect(lakewood).toBe('America/New_York');
    expect(detroit).toBe('America/Detroit');

    // And these genuinely share one, nearly 900 km apart.
    expect(timezoneForCoordinates(44.9778, -93.265)).toBe('America/Chicago');
    expect(timezoneForCoordinates(29.7604, -95.3698)).toBe('America/Chicago');
  });

  it('refuses coordinates that look transposed', () => {
    // 35.2, 31.8 is a plausible-looking swap of Jerusalem. Guessing UTC here
    // would give sunset times hours out with no visible cause.
    expect(() => timezoneForCoordinates(135.5, 35.2)).toThrow(TimezoneLookupError);
    expect(() => timezoneForCoordinates(135.5, 35.2)).toThrow(/swapped/);
  });

  it.each([
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY],
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
  ])('refuses (%s, %s)', (latitude, longitude) => {
    expect(() => timezoneForCoordinates(latitude, longitude)).toThrow(TimezoneLookupError);
  });

  it('answers for open ocean rather than failing', () => {
    // tz-lookup covers the nautical zones, and a user will never pick one — but
    // a throw here would be a crash rather than an empty result list.
    expect(timezoneForCoordinates(0, -30)).toBeTruthy();
  });
});

describe('isUsableTimezone', () => {
  it('accepts zones this runtime knows', () => {
    expect(isUsableTimezone('Asia/Jerusalem')).toBe(true);
    expect(isUsableTimezone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isUsableTimezone('UTC')).toBe(true);
  });

  it('rejects anything else, including a plausible-looking invention', () => {
    expect(isUsableTimezone('Asia/Jerusalem_Old_City')).toBe(false);
    expect(isUsableTimezone('')).toBe(false);
    expect(isUsableTimezone('x'.repeat(200))).toBe(false);
  });
});

/* ------------------------------------------------------------- catalogue -- */

describe('CatalogueProvider', () => {
  const catalogue = new CatalogueProvider();

  it('finds a seed city by partial name', async () => {
    const results = await catalogue.search({ query: 'jerus' });
    expect(results[0]?.displayName).toContain('Jerusalem');
    expect(results[0]?.provider).toBe('catalogue');
    expect(results[0]?.id).toBe('catalogue:seed:jerusalem');
  });

  it('carries elevation, which a text geocoder does not', async () => {
    // Jerusalem at 754 m moves sunset by a couple of minutes, so the catalogue
    // entry is a better record than a geocoded one.
    const [jerusalem] = await catalogue.search({ query: 'Jerusalem' });
    expect(jerusalem?.elevationMeters).toBeGreaterThan(700);
  });

  it('prefers a prefix match', async () => {
    const results = await catalogue.search({ query: 'new' });
    expect(results[0]?.displayName.toLowerCase().startsWith('new')).toBe(true);
  });

  it('refuses a query too short to be meaningful', async () => {
    await expect(catalogue.search({ query: 'je' })).rejects.toThrow(QueryTooShortError);
  });

  it('looks a candidate back up by id', async () => {
    const found = await catalogue.lookup('catalogue:seed:jerusalem');
    expect(found?.timezoneId).toBe('Asia/Jerusalem');
    expect(await catalogue.lookup('catalogue:seed:atlantis')).toBeUndefined();
  });

  it('has a correct time zone for every seed city', async () => {
    // The catalogue's zones are hand-written, so this checks them against the
    // shapefile. A wrong zone here would be a silently wrong sunset for
    // everyone who picked that city.
    for (const location of SEED_LOCATIONS) {
      expect(
        timezoneForCoordinates(location.latitude, location.longitude),
        location.displayName,
      ).toBe(location.timezoneId);
    }
  });
});

/* ------------------------------------------------------------- nominatim -- */

describe('NominatimProvider', () => {
  it('refuses to be constructed without a User-Agent', () => {
    expect(() => new NominatimProvider({ userAgent: '' })).toThrow(/usage policy/);
    expect(() => new NominatimProvider({ userAgent: 'app' })).toThrow(/User-Agent/);
  });

  it('sends the User-Agent and Referer the policy requires', async () => {
    const fake = fakeNominatim();
    const timing = instantSleep();
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: timing.sleep,
    });

    await provider.search({ query: 'Lakewood' });
    expect(fake.requests[0]?.headers['user-agent']).toBe(USER_AGENT);
    expect(fake.requests[0]?.headers['referer']).toBe(USER_AGENT);
  });

  it('derives the time zone from the returned coordinates', async () => {
    // Nominatim does not return a zone, and should not: a zone is not a
    // property of a search result.
    const fake = fakeNominatim({ places: [LAKEWOOD] });
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: instantSleep().sleep,
    });

    const [result] = await provider.search({ query: 'Lakewood' });
    expect(result?.timezoneId).toBe('America/New_York');
    expect(result?.latitude).toBeCloseTo(40.0959589, 5);
    expect(result?.longitude).toBeCloseTo(-74.2176928, 5);
    expect(fake.requests[0]?.url).not.toContain('timezone');
  });

  it('keeps full coordinate precision', async () => {
    const fake = fakeNominatim({ places: [JERUSALEM] });
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: instantSleep().sleep,
    });
    const [result] = await provider.search({ query: 'Jerusalem' });
    // Not rounded: sunset is sensitive to these, and the database stores
    // numeric(9,6) precisely for this reason.
    expect(result?.latitude).toBe(31.7788242);
  });

  it('strips the postcode and the repeated level from a display name', () => {
    expect(tidyDisplayName('Lakewood Township, Ocean County, New Jersey, 08701, United States'))
      .toBe('Lakewood Township, Ocean County, New Jersey, United States');
    expect(tidyDisplayName('Lakewood, Lakewood Township, Ocean County, New Jersey, United States'))
      .toBe('Lakewood, Ocean County, New Jersey, United States');
    expect(tidyDisplayName('Jerusalem, Jerusalem District, Israel'))
      .toBe('Jerusalem, Israel');
  });

  it('offers a short label that tells two places apart', async () => {
    const fake = fakeNominatim({ places: [LAKEWOOD] });
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: instantSleep().sleep,
    });
    const [result] = await provider.search({ query: 'Lakewood' });
    expect(result?.shortName).toBe('Lakewood Township, New Jersey');
  });

  it('does not offer a bakery as a sunset location', async () => {
    const fake = fakeNominatim({ places: [A_SHOP, LAKEWOOD] });
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: instantSleep().sleep,
    });
    const results = await provider.search({ query: 'Lakewood' });
    expect(results.map((result) => result.kind)).toEqual(['administrative']);
  });

  it('honours one request per second, under concurrency', async () => {
    // The policy this application would be blocked for ignoring. Enforced by a
    // queue rather than left to the caller.
    const fake = fakeNominatim();
    const timing = instantSleep();
    let clock = 0;
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      // Advance the clock as the throttle "sleeps", so intervals are real.
      sleep: async (ms) => {
        timing.waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });

    await Promise.all([
      provider.search({ query: 'Lakewood' }),
      provider.search({ query: 'Jerusalem' }),
      provider.search({ query: 'Brooklyn' }),
    ]);

    expect(fake.requests).toHaveLength(3);
    // Two waits for three requests, each over a second.
    expect(timing.waits).toHaveLength(2);
    for (const wait of timing.waits) expect(wait).toBeGreaterThan(1000);
  });

  it('caches a repeated search rather than re-asking', async () => {
    const fake = fakeNominatim();
    let clock = 0;
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: async () => {},
      now: () => clock,
    });

    await provider.search({ query: 'Lakewood' });
    await provider.search({ query: 'lakewood' });
    await provider.search({ query: '  Lakewood  ' });
    expect(fake.requests).toHaveLength(1);

    // Past the cache TTL: asked again.
    clock += 11 * 60 * 1000;
    await provider.search({ query: 'Lakewood' });
    expect(fake.requests).toHaveLength(2);
  });

  it('reports a rate limit as retryable', async () => {
    const fake = fakeNominatim({ failTimes: 1 });
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: async () => {},
    });

    const error = await provider.search({ query: 'Lakewood' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GeocodingUnavailableError);
    expect((error as GeocodingUnavailableError).retryable).toBe(true);
    // The message tells the user what to do instead.
    expect((error as Error).message).toContain('nearest city from the list');
  });

  it('keeps working after a failure, rather than wedging the queue', async () => {
    // The queue chains promises, so an unhandled rejection in one request would
    // block every later search behind it.
    const fake = fakeNominatim({ failTimes: 1 });
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: async () => {},
    });

    await expect(provider.search({ query: 'Lakewood' })).rejects.toThrow();
    await expect(provider.search({ query: 'Jerusalem' })).resolves.toBeDefined();
  });

  it('refuses a query too short to send upstream', async () => {
    const fake = fakeNominatim();
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    await expect(provider.search({ query: 'la' })).rejects.toThrow(QueryTooShortError);
    // Nothing was sent: the check is local.
    expect(fake.requests).toHaveLength(0);
  });

  it('drops a result with no usable coordinates or country', async () => {
    const fake = fakeNominatim({
      places: [
        { ...LAKEWOOD, lat: 'not-a-number' },
        { ...JERUSALEM, address: { country_code: '' } },
        LAKEWOOD,
      ],
    });
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    // One odd row must not fail the whole search.
    const results = await provider.search({ query: 'Lakewood' });
    expect(results).toHaveLength(1);
  });

  it('looks a candidate back up by its OSM id', async () => {
    const fake = fakeNominatim({ places: [LAKEWOOD] });
    const provider = new NominatimProvider({
      userAgent: USER_AGENT,
      fetch: fake.fetch,
      sleep: async () => {},
    });

    const found = await provider.lookup('nominatim:R172917');
    expect(found?.timezoneId).toBe('America/New_York');
    expect(fake.requests[0]?.url).toContain('osm_ids=R172917');

    // A malformed id is not sent upstream.
    expect(await provider.lookup('nominatim:not-an-id')).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
  });
});

/* ------------------------------------------------------------- composite -- */

describe('CompositeGeocoder', () => {
  it('offers a live result the catalogue does not have', async () => {
    // Bnei Brak is not one of the 22, so this is the case real search exists
    // for: a place the built-in list cannot offer at all.
    const BNEI_BRAK = {
      ...LAKEWOOD,
      osm_id: 1382522,
      lat: '32.0807',
      lon: '34.8338',
      display_name: 'Bnei Brak, Tel Aviv District, Israel',
      name: 'Bnei Brak',
      type: 'city',
      address: { city: 'Bnei Brak', state: 'Tel Aviv District', country_code: 'il' },
    };
    const fake = fakeNominatim({ places: [BNEI_BRAK] });
    const geocoder = new CompositeGeocoder({
      primary: new NominatimProvider({
        userAgent: USER_AGENT,
        fetch: fake.fetch,
        sleep: async () => {},
      }),
    });

    const outcome = await geocoder.searchWithOutcome({ query: 'Bnei Brak' });
    expect(outcome.degraded).toBe(false);
    expect(outcome.providersUsed).toContain('nominatim');

    const bneiBrak = outcome.candidates.find((candidate) => candidate.provider === 'nominatim');
    // Three levels, none repeated, so all three are kept. (Jerusalem collapses
    // to two because "Jerusalem District" repeats the city's own name.)
    expect(bneiBrak?.displayName).toBe('Bnei Brak, Tel Aviv District, Israel');
    expect(bneiBrak?.shortName).toBe('Bnei Brak, Tel Aviv District');
    expect(bneiBrak?.timezoneId).toBe('Asia/Jerusalem');
  });

  it('prefers the catalogue entry when both describe the same place', async () => {
    // Jerusalem is in both, and the catalogue's entry carries elevation.
    const fake = fakeNominatim({ places: [JERUSALEM] });
    const geocoder = new CompositeGeocoder({
      primary: new NominatimProvider({
        userAgent: USER_AGENT,
        fetch: fake.fetch,
        sleep: async () => {},
      }),
    });

    const results = await geocoder.search({ query: 'Jerusalem' });
    // Jerusalem itself appears once — the catalogue entry, which carries
    // elevation — and the coinciding live result is dropped. "Beit Shemesh,
    // Jerusalem District" also matches the query and is a different place, so
    // the filter is on the city itself.
    const jerusalems = results.filter((result) => result.displayName === 'Jerusalem, Israel');
    expect(jerusalems).toHaveLength(1);
    expect(jerusalems[0]?.provider).toBe('catalogue');
    expect(jerusalems[0]?.elevationMeters).toBeGreaterThan(700);
    expect(results.some((result) => result.provider === 'nominatim')).toBe(false);
  });

  it('falls back to the catalogue when the geocoder is down', async () => {
    // A user on the location step must still be able to proceed.
    const failures: unknown[] = [];
    const fake = fakeNominatim({ failTimes: 5 });
    const geocoder = new CompositeGeocoder({
      primary: new NominatimProvider({
        userAgent: USER_AGENT,
        fetch: fake.fetch,
        sleep: async () => {},
      }),
      onPrimaryFailure: (error) => failures.push(error),
    });

    const outcome = await geocoder.searchWithOutcome({ query: 'Jerusalem' });
    expect(outcome.degraded).toBe(true);
    expect(outcome.providersUsed).toEqual(['catalogue']);
    expect(outcome.candidates.length).toBeGreaterThan(0);
    expect(outcome.candidates.every((candidate) => candidate.provider === 'catalogue')).toBe(true);
    // The failure is surfaced to the caller rather than swallowed.
    expect(failures).toHaveLength(1);
  });

  it('does not hide a query the user must fix', async () => {
    const fake = fakeNominatim();
    const geocoder = new CompositeGeocoder({
      primary: new NominatimProvider({
        userAgent: USER_AGENT,
        fetch: fake.fetch,
        sleep: async () => {},
      }),
    });
    await expect(geocoder.search({ query: 'je' })).rejects.toThrow(QueryTooShortError);
  });

  it('runs catalogue-only with no primary configured', async () => {
    const geocoder = new CompositeGeocoder();
    const outcome = await geocoder.searchWithOutcome({ query: 'Jerusalem' });
    expect(outcome.degraded).toBe(false);
    expect(outcome.providersUsed).toEqual(['catalogue']);
  });

  it('routes a lookup to whichever provider minted the id', async () => {
    const fake = fakeNominatim({ places: [LAKEWOOD] });
    const geocoder = new CompositeGeocoder({
      primary: new NominatimProvider({
        userAgent: USER_AGENT,
        fetch: fake.fetch,
        sleep: async () => {},
      }),
    });

    expect((await geocoder.lookup('catalogue:seed:jerusalem'))?.provider).toBe('catalogue');
    expect(fake.requests).toHaveLength(0);
    expect((await geocoder.lookup('nominatim:R172917'))?.provider).toBe('nominatim');
    expect(fake.requests).toHaveLength(1);
  });

  it('offers the whole catalogue for a "nearby city" control', async () => {
    const all = await new CompositeGeocoder().catalogue();
    expect(all).toHaveLength(SEED_LOCATIONS.length);
  });
});

describe('roughDistanceKm', () => {
  it('is accurate enough for the duplicate threshold', () => {
    // Jerusalem's two entries here are about 800 m apart.
    expect(roughDistanceKm({ latitude: 31.7781, longitude: 35.2352 }, { latitude: 31.7788, longitude: 35.2258 })).toBeLessThan(2);
    // Jerusalem to Tel Aviv, about 54 km.
    const distance = roughDistanceKm(
      { latitude: 31.7781, longitude: 35.2352 },
      { latitude: 32.0853, longitude: 34.7818 },
    );
    expect(distance).toBeGreaterThan(45);
    expect(distance).toBeLessThan(65);
  });

  it('keeps two distinct nearby towns apart', () => {
    // Lakewood and Toms River are about 12 km apart and would merge; Lakewood
    // and Brooklyn are about 80 km and must not.
    expect(
      roughDistanceKm(
        { latitude: 40.0979, longitude: -74.2179 },
        { latitude: 40.6782, longitude: -73.9442 },
      ),
    ).toBeGreaterThan(25);
  });
});

describe('resolveGeocoder', () => {
  it('runs catalogue-only with no User-Agent configured', () => {
    const resolved = resolveGeocoder({} as NodeJS.ProcessEnv);
    expect(resolved.liveSearchEnabled).toBe(false);
    expect(resolved.description).toContain('GEOCODER_USER_AGENT');
  });

  it('enables live search when one is configured', () => {
    const resolved = resolveGeocoder({
      GEOCODER_USER_AGENT: USER_AGENT,
    } as NodeJS.ProcessEnv);
    expect(resolved.liveSearchEnabled).toBe(true);
    expect(resolved.description).toContain('Nominatim');
  });
});
