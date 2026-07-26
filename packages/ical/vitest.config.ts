import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Same reasoning as the engine: output must not depend on the host zone.
    env: { TZ: 'America/Los_Angeles' },
  },
});
