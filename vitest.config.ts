import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // sim.ts is deliberately DOM-free, so its tests need no browser
    environment: 'node',
    /* The air is solved for real, so a routing check is thousands of pressure
       sweeps rather than a function call. Slow by nature, not by accident. */
    testTimeout: 180_000,
    include: ['tests/**/*.test.ts'],
    // Playwright specs live in tests/e2e and are run by `npm run e2e`
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
