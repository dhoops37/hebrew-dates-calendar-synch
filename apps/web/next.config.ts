import type { NextConfig } from 'next';

/**
 * Nothing here controls how Vercel builds this app — that lives in the Vercel
 * project's own settings, and `docs/DEPLOYMENT.md` records the one that cost a
 * morning: an **empty-string** Build/Install/Output setting is not the same as
 * an unset one. Empty means "run nothing", and produces a deployment that
 * succeeds in ~100ms with no output and 404s every route. They must read
 * "Auto".
 */
const nextConfig: NextConfig = {
  // The engine is consumed as TypeScript source from the workspace, so Next
  // compiles it rather than requiring a separate build step during the
  // prototype phase.
  transpilePackages: [
    '@hebrew-dates/engine',
    '@hebrew-dates/ical',
    '@hebrew-dates/db',
    '@hebrew-dates/crypto',
    '@hebrew-dates/google-client',
    '@hebrew-dates/google-calendar',
    '@hebrew-dates/sync',
    '@hebrew-dates/geocoding',
    '@hebrew-dates/service',
  ],
  // Native modules that must not be bundled into the serverless function.
  serverExternalPackages: ['pg', '@google-cloud/kms', 'tz-lookup'],
  // Route literals are type-checked, so a renamed page cannot leave a dead
  // link behind. Route *handlers* are not pages, so those are plain anchors.
  typedRoutes: true,
};

export default nextConfig;
