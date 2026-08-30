import { defineConfig } from 'vitest/config';

// ponytail: exists only to stop vitest walking up to the repo-root
// vitest.config.ts, which is written for the main package and can't resolve
// its imports from here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
