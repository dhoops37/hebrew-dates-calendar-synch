import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The engine is consumed as TypeScript source from the workspace, so Next
  // compiles it rather than requiring a separate build step during the
  // prototype phase.
  transpilePackages: ['@hebrew-dates/engine', '@hebrew-dates/ical'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
