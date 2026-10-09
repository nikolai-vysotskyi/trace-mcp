import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // The desktop app lives in its own repo with its own (jsdom + react)
    // test setup. The core has no react dependency, so its test runner must
    // not pick up packages/app tests (they fail to resolve react/jsx-runtime).
    // integrations/ contains separate npm packages with their own dependencies
    // (e.g. integrations/bb with @get-bb/plugin-sdk) and their own test runners.
    exclude: [...configDefaults.exclude, 'packages/app/**', 'integrations/**'],
    // Redirect the trace-mcp global home (~/.trace-mcp) to a per-worker temp dir
    // BEFORE any project module resolves it at import time, so the suite never
    // reads or writes the developer's real topology.db / decisions.db / registry.
    setupFiles: ['./tests/setup/isolate-home.ts'],
    reporters: ['default', './tests/force-exit-reporter.ts'],
  },
});
