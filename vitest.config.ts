import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // The desktop app lives in its own repo with its own (jsdom + react)
    // test setup. The core has no react dependency, so its test runner must
    // not pick up packages/app tests (they fail to resolve react/jsx-runtime).
    exclude: [...configDefaults.exclude, 'packages/app/**'],
    reporters: ['default', './tests/force-exit-reporter.ts'],
  },
});
