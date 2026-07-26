import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The engine must be independent of the server's local time zone.
    // Tests deliberately run under a non-UTC zone so that any accidental
    // reliance on the host zone fails here rather than in production.
    env: { TZ: 'America/Los_Angeles' },
  },
});
