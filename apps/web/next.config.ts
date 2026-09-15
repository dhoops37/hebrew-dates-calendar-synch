import type { NextConfig } from 'next';

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
