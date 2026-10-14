import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
    // TRA-2427: cap worker concurrency on Windows in CI to 2.
    // On 4-vCPU Windows Server 2025 runners with 7 GB RAM, unconstrained Vitest
    // forks (4 workers) concurrently spawning subprocesses (cmd.exe, powershell,
    // git) and running extract worker pools caused severe CPU scheduling latency
    // and disk I/O thrashing on NTFS. Capping workers to 2 bounds peak process
    // creation contention and prevents timeouts.
    maxWorkers: process.env.CI && process.platform === 'win32' ? 2 : undefined,
    // The desktop app and integrations have their own test dependencies and
    // Vitest configs. The core runner must not collect their tests.
    exclude: [...configDefaults.exclude, 'packages/app/**', 'integrations/**'],
    // Redirect the trace-mcp global home (~/.trace-mcp) to a per-worker temp dir
    // BEFORE any project module resolves it at import time, so the suite never
    // reads or writes the developer's real topology.db / decisions.db / registry.
    setupFiles: ['./tests/setup/isolate-home.ts'],
    reporters: ['default', './tests/force-exit-reporter.ts'],
  },
});
