import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    reporters: ['default', './tests/force-exit-reporter.ts'],
  },
});
