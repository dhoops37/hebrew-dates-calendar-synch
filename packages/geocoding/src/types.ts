/**
 * Geocoding contracts.
 *
 * A place, not a time zone. That distinction is the whole reason this package
 * exists: `America/New_York` spans from Maine to Michigan, and sunset differs
 * by close to an hour across it. A time zone can never *be* a calculation
 * location — it can only ever be a hint that something is then confirmed.
 *
 * So every result from this package is a **candidate**: it carries coordinates,
 * a resolved IANA zone, a display name and its provenance, and it is explicitly
 * not confirmed. `packages/service` is what turns a confirmed candidate into a
 * `CalculationLocation`, and only a user can do the confirming.
 */

/** One place a search matched. Never a calculation location until confirmed. */
export interface PlaceCandidate {
  /**
   * Stable within a provider: `"<provider>:<providerPlaceId>"`.
   *
   * The UI sends this back rather than coordinates, so a form cannot be edited
   * to store a place the user never saw.
   */
  id: string;
  /** What to show the user, e.g. "Lakewood, Ocean County, New Jersey, USA". */
  displayName: string;
  /** A shorter label for a list, e.g. "Lakewood, New Jersey". */
  shortName: string;
  latitude: number;
  longitude: number;
  /** Resolved from the coordinates, never from the user's browser. */
  timezoneId: string;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string;
  /** Metres above sea level, when the provider knows. */
  elevationMeters?: number;
  /** Which provider answered, recorded alongside the saved location. */
  provider: string;
  /** The provider's own identifier, before prefixing. */
  providerPlaceId: string;
  /** What the provider called it, before any tidying. */
  providerDisplayName: string;
  /** What kind of place: 'city', 'town', 'village', 'suburb', … */
  kind: string;
  /**
   * The provider's own confidence, 0–1, when it reports one.
   *
   * Used only for ordering. It is never a reason to skip confirmation.
   */
  relevance?: number;
}

export interface GeocodeQuery {
  /** What the user typed. */
  query: string;
  /** Upper bound on results. Providers may return fewer. */
  limit?: number;
  /** ISO 3166-1 alpha-2 codes to prefer, when the caller has a hint. */
  countryCodes?: string[];
  /** For a provider that localises its labels. */
  language?: string;
}

/**
 * A geocoder.
 *
 * Deliberately narrow: search by text, and look up by the id a previous search
 * returned. Nothing else — no reverse geocoding, no autocomplete session state,
 * because the product needs neither and each would be another vendor coupling.
 */
export interface GeocodingProvider {
  /** Stable name, recorded on the saved location. */
  readonly name: string;
  search(query: GeocodeQuery): Promise<PlaceCandidate[]>;
  /**
   * Re-resolve a candidate by its id.
   *
   * The confirmation step calls this rather than trusting coordinates that came
   * back through the browser, so the values stored are values the provider
   * stands behind.
   */
  lookup(id: string): Promise<PlaceCandidate | undefined>;
}

export class GeocodingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GeocodingError';
  }
}

export class GeocodingUnavailableError extends GeocodingError {
  constructor(provider: string, cause?: unknown) {
    super(
      `The location search service (${provider}) could not be reached. ` +
        'Please try again in a moment, or choose the nearest city from the list.',
      true,
    );
    this.cause = cause;
  }
}

export class QueryTooShortError extends GeocodingError {
  constructor() {
    super('Please type at least three characters of a city or town name.', false);
  }
}

/** Shortest query worth sending upstream. */
export const MIN_QUERY_LENGTH = 3;
