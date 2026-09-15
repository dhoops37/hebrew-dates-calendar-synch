/**
 * The built-in catalogue, as a geocoding provider.
 *
 * The 22 seed locations do not go away when real search arrives; they become
 * the offline fallback. Three reasons they are still worth having:
 *
 *  - **Nominatim can be down or rate-limited.** A user should still be able to
 *    set a location, and for most of this product's users the answer is one of
 *    these cities.
 *  - **They carry elevation**, which a text geocoder does not, and elevation
 *    moves sunset by a couple of minutes at Jerusalem's 754 m.
 *  - **Tests and local development need no network.**
 *
 * It answers the same interface, so the composite below can prefer whichever is
 * available without the caller knowing which answered.
 */
import { SEED_LOCATIONS } from '@hebrew-dates/engine';
import {
  MIN_QUERY_LENGTH,
  QueryTooShortError,
  type GeocodeQuery,
  type GeocodingProvider,
  type PlaceCandidate,
} from './types';

const PROVIDER = 'catalogue';

function toCandidate(location: (typeof SEED_LOCATIONS)[number]): PlaceCandidate {
  return {
    id: `${PROVIDER}:${location.id}`,
    displayName: location.displayName,
    shortName: location.displayName,
    latitude: location.latitude,
    longitude: location.longitude,
    // The catalogue's zones are hand-checked, so they are used as given rather
    // than re-derived. A mismatch would be a bug in the catalogue itself, and
    // there is a test for exactly that.
    timezoneId: location.timezoneId,
    countryCode: location.countryCode,
    ...(location.elevationMeters !== undefined
      ? { elevationMeters: location.elevationMeters }
      : {}),
    provider: PROVIDER,
    providerPlaceId: location.id,
    providerDisplayName: location.displayName,
    kind: 'city',
    // Below anything a real geocoder returns, so a live match always sorts
    // first when both providers answer.
    relevance: 0.5,
  };
}

export class CatalogueProvider implements GeocodingProvider {
  readonly name = PROVIDER;

  async search(query: GeocodeQuery): Promise<PlaceCandidate[]> {
    const needle = query.query.trim().toLowerCase();
    if (needle.length < MIN_QUERY_LENGTH) throw new QueryTooShortError();

    const matches = SEED_LOCATIONS.filter((location) =>
      `${location.displayName} ${location.countryCode}`.toLowerCase().includes(needle),
    );

    // A prefix match is what the user probably meant, so it sorts first.
    matches.sort((left, right) => {
      const leftPrefix = left.displayName.toLowerCase().startsWith(needle) ? 0 : 1;
      const rightPrefix = right.displayName.toLowerCase().startsWith(needle) ? 0 : 1;
      return leftPrefix - rightPrefix || left.displayName.localeCompare(right.displayName);
    });

    return matches.slice(0, query.limit ?? 8).map(toCandidate);
  }

  async lookup(id: string): Promise<PlaceCandidate | undefined> {
    const seedId = id.startsWith(`${PROVIDER}:`) ? id.slice(PROVIDER.length + 1) : id;
    const location = SEED_LOCATIONS.find((candidate) => candidate.id === seedId);
    return location ? toCandidate(location) : undefined;
  }

  /** Everything in the catalogue, for a "or pick from this list" control. */
  async all(): Promise<PlaceCandidate[]> {
    return SEED_LOCATIONS.map(toCandidate);
  }
}
