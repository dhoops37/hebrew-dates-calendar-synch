/**
 * Choosing a geocoder from the environment.
 *
 * One function, so the decision is in one place. The rule: use Nominatim when a
 * User-Agent is configured, and otherwise run catalogue-only. There is
 * deliberately no default User-Agent — OpenStreetMap's policy requires one that
 * identifies the deployment, and inventing a generic one on a user's behalf is
 * how an application gets blocked.
 *
 * Two knobs make the public endpoint replaceable without touching application
 * logic, which is the point of the `GeocodingProvider` seam:
 *
 *  - `GEOCODER_ENDPOINT` points at a self-hosted Nominatim or a compatible
 *    mirror. A self-hosted instance has no one-per-second policy, so
 *    `GEOCODER_UNTHROTTLED=1` lifts the gate for that case — and only that
 *    case, since lifting it against the public endpoint is the thing the policy
 *    forbids.
 *  - A different vendor entirely is a new `GeocodingProvider` and one branch
 *    here. Nothing above this file knows which provider answered.
 */
import { CatalogueProvider } from './catalogue';
import { CompositeGeocoder } from './composite';
import { NOMINATIM_ATTRIBUTION, NominatimProvider } from './nominatim';
import type { GeocoderAttribution, OutboundGate } from './types';

export interface ResolvedGeocoder {
  geocoder: CompositeGeocoder;
  /** 'nominatim+catalogue' or 'catalogue'. Shown in diagnostics. */
  description: string;
  /** False when only the built-in cities are searchable. */
  liveSearchEnabled: boolean;
  /**
   * The credit the UI must render when live search is on.
   *
   * `undefined` for catalogue-only, whose data is ours and needs none.
   */
  attribution: GeocoderAttribution | undefined;
  /**
   * Whether an application-wide request gate is in force.
   *
   * Worth surfacing: live search against the public endpoint *without* a gate
   * is a policy breach waiting to be noticed, and a diagnostics panel that says
   * so is how it gets noticed before OpenStreetMap does.
   */
  globallyThrottled: boolean;
}

export interface ResolveGeocoderOptions {
  onPrimaryFailure?: (error: unknown) => void;
  /**
   * The shared one-per-second gate. Supply it from `packages/db` in any
   * deployment that runs more than one process — which on Vercel is all of
   * them.
   */
  gate?: OutboundGate;
}

export function resolveGeocoder(
  environment: NodeJS.ProcessEnv = process.env,
  options: ResolveGeocoderOptions = {},
): ResolvedGeocoder {
  const userAgent = environment.GEOCODER_USER_AGENT;

  if (!userAgent) {
    // Catalogue-only rather than an error: the product still works, just with
    // 22 cities, and saying so is better than refusing to start.
    return {
      geocoder: new CompositeGeocoder({ catalogue: new CatalogueProvider() }),
      description: 'Built-in city list only (set GEOCODER_USER_AGENT for live search)',
      liveSearchEnabled: false,
      attribution: undefined,
      globallyThrottled: false,
    };
  }

  const endpoint = environment.GEOCODER_ENDPOINT;
  // A self-hosted instance sets its own limits, so the shared gate is only
  // mandatory against the public one. Requiring an explicit opt-out rather than
  // inferring it from the hostname keeps the decision the operator's, and
  // visible in configuration.
  const unthrottled = environment.GEOCODER_UNTHROTTLED === '1' && Boolean(endpoint);
  const gate = unthrottled ? undefined : options.gate;

  return {
    geocoder: new CompositeGeocoder({
      primary: new NominatimProvider({
        userAgent,
        ...(endpoint ? { endpoint } : {}),
        ...(gate ? { gate } : {}),
      }),
      catalogue: new CatalogueProvider(),
      ...(options.onPrimaryFailure ? { onPrimaryFailure: options.onPrimaryFailure } : {}),
    }),
    description: endpoint
      ? `Nominatim at ${endpoint}, with the built-in city list as a fallback`
      : 'OpenStreetMap Nominatim, with the built-in city list as a fallback',
    liveSearchEnabled: true,
    attribution: NOMINATIM_ATTRIBUTION,
    globallyThrottled: gate !== undefined,
  };
}
