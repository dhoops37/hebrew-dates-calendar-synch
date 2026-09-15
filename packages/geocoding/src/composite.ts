/**
 * Search the live geocoder, fall back to the catalogue.
 *
 * The failure this exists for: Nominatim is rate-limited or down, and a user is
 * sitting on the location step unable to proceed. Falling back means they can
 * still pick a nearby city and get correct sunset times, which is a far better
 * outcome than an error message.
 *
 * Both sets are merged rather than one replacing the other, because the
 * catalogue carries elevation that the live geocoder does not: if a search for
 * "Jerusalem" returns both, the catalogue's entry is the better record and
 * should be offered alongside.
 */
import { CatalogueProvider } from './catalogue';
import {
  GeocodingError,
  type GeocodeQuery,
  type GeocodingProvider,
  type PlaceCandidate,
} from './types';

export interface CompositeOptions {
  /** Tried first. Omit to run catalogue-only, as local development may. */
  primary?: GeocodingProvider;
  catalogue?: CatalogueProvider;
  /** Called when the primary fails, so a route can log or surface a warning. */
  onPrimaryFailure?: (error: unknown) => void;
}

export interface SearchOutcome {
  candidates: PlaceCandidate[];
  /** Which providers contributed, in the order they were tried. */
  providersUsed: string[];
  /**
   * Set when the live geocoder failed and only the catalogue answered, so the
   * UI can say "showing nearby cities only" rather than pretending the list is
   * complete.
   */
  degraded: boolean;
}

export class CompositeGeocoder implements GeocodingProvider {
  readonly name = 'composite';
  readonly #primary: GeocodingProvider | undefined;
  readonly #catalogue: CatalogueProvider;
  readonly #onPrimaryFailure: ((error: unknown) => void) | undefined;

  constructor(options: CompositeOptions = {}) {
    this.#primary = options.primary;
    this.#catalogue = options.catalogue ?? new CatalogueProvider();
    this.#onPrimaryFailure = options.onPrimaryFailure;
  }

  /** Search with provenance, which is what the UI wants. */
  async searchWithOutcome(query: GeocodeQuery): Promise<SearchOutcome> {
    const catalogueMatches = await this.#catalogue.search(query).catch(() => []);

    if (!this.#primary) {
      return {
        candidates: catalogueMatches,
        providersUsed: [this.#catalogue.name],
        degraded: false,
      };
    }

    try {
      const liveMatches = await this.#primary.search(query);
      return {
        candidates: merge(catalogueMatches, liveMatches, query.limit ?? 8),
        providersUsed: [this.#primary.name, this.#catalogue.name],
        degraded: false,
      };
    } catch (error) {
      // A query the user must fix — too short — is theirs to hear about, not
      // something to paper over with a fallback.
      if (error instanceof GeocodingError && !error.retryable) throw error;

      this.#onPrimaryFailure?.(error);
      return {
        candidates: catalogueMatches,
        providersUsed: [this.#catalogue.name],
        degraded: true,
      };
    }
  }

  async search(query: GeocodeQuery): Promise<PlaceCandidate[]> {
    return (await this.searchWithOutcome(query)).candidates;
  }

  /** Route a lookup to whichever provider minted the id. */
  async lookup(id: string): Promise<PlaceCandidate | undefined> {
    if (id.startsWith('catalogue:')) return this.#catalogue.lookup(id);
    if (!this.#primary) return undefined;
    return this.#primary.lookup(id);
  }

  /** The catalogue in full, for the "or pick a nearby city" control. */
  async catalogue(): Promise<PlaceCandidate[]> {
    return this.#catalogue.all();
  }
}

/**
 * Merge two result sets, catalogue entries first where they coincide.
 *
 * "Coincide" is within about 25 km, which is close enough that the two are the
 * same place for sunset purposes — roughly a minute of difference — and far
 * enough apart that two genuinely distinct towns are not collapsed.
 */
function merge(
  catalogueMatches: PlaceCandidate[],
  liveMatches: PlaceCandidate[],
  limit: number,
): PlaceCandidate[] {
  const merged = [...catalogueMatches];

  for (const candidate of liveMatches) {
    const duplicate = merged.some(
      (existing) => roughDistanceKm(existing, candidate) < 25,
    );
    if (!duplicate) merged.push(candidate);
  }

  // Highest relevance first, then alphabetically so the order is stable. A
  // catalogue entry that coincides with a live result is already in front of it.
  merged.sort(
    (left, right) =>
      (right.relevance ?? 0) - (left.relevance ?? 0) ||
      left.displayName.localeCompare(right.displayName),
  );
  return merged.slice(0, limit);
}

/**
 * Equirectangular approximation, in kilometres.
 *
 * Accurate enough well inside the 25 km threshold and far cheaper than
 * haversine, which this does not need to be.
 */
export function roughDistanceKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const meanLatitudeRadians = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const northSouthKm = (a.latitude - b.latitude) * 111.32;
  const eastWestKm = (a.longitude - b.longitude) * 111.32 * Math.cos(meanLatitudeRadians);
  return Math.hypot(northSouthKm, eastWestKm);
}
