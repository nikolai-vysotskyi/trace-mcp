import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // The desktop app and bb plugin have their own test dependencies and
    // Vitest configs. The core runner must not collect their tests.
    exclude: [...configDefaults.exclude, 'packages/app/**', 'integrations/bb/**'],
    // Redirect the trace-mcp global home (~/.trace-mcp) to a per-worker temp dir
    // BEFORE any project module resolves it at import time, so the suite never
    // reads or writes the developer's real topology.db / decisions.db / registry.
    setupFiles: ['./tests/setup/isolate-home.ts'],
    reporters: ['default', './tests/force-exit-reporter.ts'],
  },
});
