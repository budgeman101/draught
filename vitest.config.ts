import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // sim.ts is deliberately DOM-free, so its tests need no browser
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Playwright specs live in tests/e2e and are run by `npm run e2e`
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
