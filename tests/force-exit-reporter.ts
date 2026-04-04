/**
 * Custom vitest reporter that forces process exit after results are printed.
 * Workaround for open handles from native addons (better-sqlite3) keeping
 * vitest's thread pool alive after all tests complete.
 */
export default class ForceExitReporter {
  onFinished() {
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  }
}
