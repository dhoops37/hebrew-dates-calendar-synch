/**
 * OpenStreetMap Nominatim.
 *
 * Chosen for a free, donation-supported product: no API key, no account, no
 * per-request cost, and coverage of every locality anyone is likely to type.
 * The trade is its usage policy, which this implementation takes seriously
 * because ignoring it gets an application blocked:
 *
 *  - **A real User-Agent identifying the application.** Required. A generic or
 *    absent one is the documented reason for a block.
 *  - **At most one request per second.** Enforced here by a queue rather than
 *    left to the caller, because "the caller will be careful" is not a rate
 *    limit. Note this is per instance; the per-user limit in the service layer
 *    is what bounds the total.
 *  - **Results cached**, so a user refining a search does not re-ask for the
 *    same string.
 *
 * If this ever needs to move to a paid provider — better relevance ranking,
 * a commercial support agreement — the `GeocodingProvider` interface is the
 * whole surface to reimplement.
 *
 * Nominatim does **not** return a time zone, which is correct: a time zone is
 * not a property of a search result. The zone is derived from the returned
 * coordinates by `timezoneForCoordinates`.
 */
import {
  GeocodingUnavailableError,
  MIN_QUERY_LENGTH,
  QueryTooShortError,
  type GeocodeQuery,
  type GeocodingProvider,
  type PlaceCandidate,
} from './types';
import { timezoneForCoordinates } from './timezone';

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org';

/** Nominatim's policy is one request per second. */
const MIN_REQUEST_INTERVAL_MS = 1100;

/** How long a search result stays usable. */
const CACHE_TTL_MS = 10 * 60 * 1000;

const PROVIDER = 'nominatim';

/**
 * Place kinds worth offering.
 *
 * A user setting a sunset location wants a populated place, not a road or a
 * shop. Filtering here keeps the list short and relevant; a user whose village
 * is missing can still search for the nearest town.
 */
const USEFUL_KINDS = new Set([
  'city',
  'town',
  'village',
  'hamlet',
  'suburb',
  'neighbourhood',
  'quarter',
  'municipality',
  'borough',
  'city_district',
  'administrative',
  'county',
  'state',
  'region',
  'island',
]);

interface NominatimPlace {
  place_id?: number | string;
  osm_type?: string;
  osm_id?: number | string;
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  type?: string;
  class?: string;
  importance?: number;
  address?: Record<string, string>;
}

export interface NominatimOptions {
  /**
   * Sent as `User-Agent` and `Referer`. **Required** by the usage policy, and
   * it must identify this deployment — a contact address or a domain.
   */
  userAgent: string;
  endpoint?: string;
  fetch?: typeof fetch;
  /** Injected in tests so the throttle does not actually sleep. */
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  /** Per-request timeout. A slow geocoder must not hold a page open. */
  timeoutMs?: number;
}

export class NominatimProvider implements GeocodingProvider {
  readonly name = PROVIDER;
  readonly #endpoint: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  /**
   * When the last request left, for spacing the next one.
   *
   * Starts at -Infinity rather than 0 so the *first* request goes out
   * immediately: there is nothing to space it from, and making a user wait a
   * second for their first keystroke to resolve is a real cost for no benefit.
   */
  #lastRequestAt = Number.NEGATIVE_INFINITY;
  /** Serialises requests so the one-per-second rule holds under concurrency. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #cache = new Map<string, { at: number; candidates: PlaceCandidate[] }>();

  constructor(options: NominatimOptions) {
    if (!options.userAgent || options.userAgent.length < 8) {
      // Not a nicety. A missing or generic User-Agent is the documented reason
      // Nominatim blocks an application, and being blocked would take location
      // search down for every user.
      throw new Error(
        'NominatimProvider needs a User-Agent identifying this deployment, e.g. ' +
          '"HebrewDates/1.0 (https://hebrewdates.app; contact@example.com)". ' +
          "OpenStreetMap's usage policy requires it and blocks applications without one.",
      );
    }
    this.#userAgent = options.userAgent;
    this.#endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 8000;
  }

  async search(query: GeocodeQuery): Promise<PlaceCandidate[]> {
    const trimmed = query.query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) throw new QueryTooShortError();

    const cacheKey = JSON.stringify({
      q: trimmed.toLowerCase(),
      limit: query.limit ?? 8,
      countries: query.countryCodes?.map((code) => code.toLowerCase()).sort() ?? [],
      language: query.language ?? 'en',
    });
    const cached = this.#cache.get(cacheKey);
    if (cached && this.#now() - cached.at < CACHE_TTL_MS) return cached.candidates;

    const url = new URL(`${this.#endpoint}/search`);
    url.searchParams.set('q', trimmed);
    url.searchParams.set('format', 'jsonv2');
    // More than asked for, because the kind filter below discards some.
    url.searchParams.set('limit', String(Math.min((query.limit ?? 8) * 3, 40)));
    url.searchParams.set('addressdetails', '1');
    // Nominatim's own dedup, so "London" does not return five Londons in one city.
    url.searchParams.set('dedupe', '1');
    if (query.countryCodes?.length) {
      url.searchParams.set('countrycodes', query.countryCodes.join(',').toLowerCase());
    }
    url.searchParams.set('accept-language', query.language ?? 'en');

    const places = await this.#request<NominatimPlace[]>(url);
    const candidates = places
      .map((place) => this.#toCandidate(place))
      .filter((candidate): candidate is PlaceCandidate => candidate !== undefined)
      .filter((candidate) => USEFUL_KINDS.has(candidate.kind))
      .slice(0, query.limit ?? 8);

    this.#cache.set(cacheKey, { at: this.#now(), candidates });
    return candidates;
  }

  /**
   * Re-resolve by id.
   *
   * Nominatim's `lookup` endpoint takes OSM type+id rather than its internal
   * `place_id`, so the id this provider hands out encodes the former.
   */
  async lookup(id: string): Promise<PlaceCandidate | undefined> {
    const osmId = id.startsWith(`${PROVIDER}:`) ? id.slice(PROVIDER.length + 1) : id;
    if (!/^[NWR]\d+$/.test(osmId)) return undefined;

    const url = new URL(`${this.#endpoint}/lookup`);
    url.searchParams.set('osm_ids', osmId);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');

    const places = await this.#request<NominatimPlace[]>(url);
    const first = places[0];
    return first ? this.#toCandidate(first) : undefined;
  }

  /** Cached search strings, for a diagnostics panel. */
  get cacheSize(): number {
    return this.#cache.size;
  }

  /* ---------------------------------------------------------------- internal -- */

  /**
   * One request, throttled and serialised.
   *
   * The queue is the mechanism: each call chains onto the last, so however many
   * callers arrive at once, requests leave one at a time and at most one per
   * `MIN_REQUEST_INTERVAL_MS`.
   */
  async #request<T>(url: URL): Promise<T> {
    const run = this.#queue.then(async () => {
      const waitFor = this.#lastRequestAt + MIN_REQUEST_INTERVAL_MS - this.#now();
      if (waitFor > 0) await this.#sleep(waitFor);
      this.#lastRequestAt = this.#now();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(url.toString(), {
          headers: {
            // Both required by the usage policy.
            'user-agent': this.#userAgent,
            referer: this.#userAgent,
            accept: 'application/json',
          },
          signal: controller.signal,
        });

        if (response.status === 429 || response.status === 503) {
          throw new GeocodingUnavailableError(
            PROVIDER,
            new Error(`rate limited or unavailable (HTTP ${response.status})`),
          );
        }
        if (!response.ok) {
          throw new GeocodingUnavailableError(
            PROVIDER,
            new Error(`unexpected status ${response.status}`),
          );
        }

        const body = (await response.json()) as unknown;
        if (!Array.isArray(body)) {
          throw new GeocodingUnavailableError(PROVIDER, new Error('response was not a list'));
        }
        return body as T;
      } catch (error) {
        if (error instanceof GeocodingUnavailableError) throw error;
        throw new GeocodingUnavailableError(PROVIDER, error);
      } finally {
        clearTimeout(timer);
      }
    });

    // The queue must keep going even when one request fails, or a single error
    // would wedge every later search behind a rejected promise.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Map one Nominatim place to a candidate.
   *
   * Returns undefined rather than throwing for anything unusable — a result
   * with no coordinates, or coordinates with no time zone. One odd row in a
   * list of ten must not fail the whole search.
   */
  #toCandidate(place: NominatimPlace): PlaceCandidate | undefined {
    const latitude = Number(place.lat);
    const longitude = Number(place.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;

    const osmType = place.osm_type?.[0]?.toUpperCase();
    if (!osmType || !place.osm_id || !'NWR'.includes(osmType)) return undefined;
    const providerPlaceId = `${osmType}${place.osm_id}`;

    let timezoneId: string;
    try {
      timezoneId = timezoneForCoordinates(latitude, longitude);
    } catch {
      // No zone means no sunset calculation, so the place is not offerable.
      return undefined;
    }

    const address = place.address ?? {};
    const countryCode = (address.country_code ?? '').toUpperCase();
    if (countryCode.length !== 2) return undefined;

    const displayName = place.display_name ?? place.name ?? '';
    if (!displayName) return undefined;

    return {
      id: `${PROVIDER}:${providerPlaceId}`,
      displayName: tidyDisplayName(displayName),
      shortName: shortLabel(place, displayName),
      latitude,
      longitude,
      timezoneId,
      countryCode,
      provider: PROVIDER,
      providerPlaceId,
      providerDisplayName: displayName,
      kind: place.type ?? place.class ?? 'unknown',
      ...(typeof place.importance === 'number' ? { relevance: place.importance } : {}),
    };
  }
}

/**
 * Trim a Nominatim display name to something readable.
 *
 * Nominatim returns the full administrative chain, e.g. "Lakewood, Lakewood
 * Township, Ocean County, New Jersey, 08701, United States". The postcode and
 * repeated levels are noise for this purpose; the country is not.
 */
export function tidyDisplayName(displayName: string): string {
  const parts = displayName
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    // Drop postcodes: mostly digits, with optional letters and spaces.
    .filter((part) => !/^[\d][\d\s-]*$/.test(part) && !/^[A-Z]{1,2}\d/.test(part));

  // Collapse an immediately repeated level ("Lakewood, Lakewood Township").
  const collapsed = parts.filter((part, index) => {
    const previous = parts[index - 1];
    return !previous || !(part.startsWith(previous) || previous.startsWith(part));
  });

  // First three levels plus the country reads best: locality, area, country.
  if (collapsed.length <= 4) return collapsed.join(', ');
  const country = collapsed[collapsed.length - 1] as string;
  return [...collapsed.slice(0, 3), country].join(', ');
}

/** "Lakewood, New Jersey" — enough to tell two places apart in a list. */
function shortLabel(place: NominatimPlace, displayName: string): string {
  const address = place.address ?? {};
  const locality =
    place.name ??
    address.city ??
    address.town ??
    address.village ??
    address.hamlet ??
    address.suburb ??
    displayName.split(',')[0]?.trim() ??
    '';
  const region = address.state ?? address.county ?? address.country ?? '';
  return region && region !== locality ? `${locality}, ${region}` : locality;
}
