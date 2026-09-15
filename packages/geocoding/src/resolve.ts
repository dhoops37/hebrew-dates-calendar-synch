/**
 * Choosing a geocoder from the environment.
 *
 * One function, so the decision is in one place. The rule: use Nominatim when a
 * User-Agent is configured, and otherwise run catalogue-only. There is
 * deliberately no default User-Agent — OpenStreetMap's policy requires one that
 * identifies the deployment, and inventing a generic one on a user's behalf is
 * how an application gets blocked.
 */
import { CatalogueProvider } from './catalogue';
import { CompositeGeocoder } from './composite';
import { NominatimProvider } from './nominatim';

export interface ResolvedGeocoder {
  geocoder: CompositeGeocoder;
  /** 'nominatim+catalogue' or 'catalogue'. Shown in diagnostics. */
  description: string;
  /** False when only the built-in cities are searchable. */
  liveSearchEnabled: boolean;
}

export function resolveGeocoder(
  environment: NodeJS.ProcessEnv = process.env,
  options: { onPrimaryFailure?: (error: unknown) => void } = {},
): ResolvedGeocoder {
  const userAgent = environment.GEOCODER_USER_AGENT;

  if (!userAgent) {
    // Catalogue-only rather than an error: the product still works, just with
    // 22 cities, and saying so is better than refusing to start.
    return {
      geocoder: new CompositeGeocoder({ catalogue: new CatalogueProvider() }),
      description: 'Built-in city list only (set GEOCODER_USER_AGENT for live search)',
      liveSearchEnabled: false,
    };
  }

  return {
    geocoder: new CompositeGeocoder({
      primary: new NominatimProvider({
        userAgent,
        ...(environment.GEOCODER_ENDPOINT ? { endpoint: environment.GEOCODER_ENDPOINT } : {}),
      }),
      catalogue: new CatalogueProvider(),
      ...(options.onPrimaryFailure ? { onPrimaryFailure: options.onPrimaryFailure } : {}),
    }),
    description: 'OpenStreetMap Nominatim, with the built-in city list as a fallback',
    liveSearchEnabled: true,
  };
}
