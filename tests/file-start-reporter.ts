/**
 * Vitest reporter that prints each test file path BEFORE it loads.
 *
 * Default + verbose reporters only print after a test/file completes, which
 * hides the culprit when a file hangs at module-load (top-level await,
 * native binding init, dynamic import that never resolves). With this
 * reporter, the file path is printed first thing, so the last printed
 * "[FILE START] ..." line is the hung file.
 *
 * Wired into vitest.config.ts only when DIAG_FILE_STARTS=1 to keep noise out
 * of normal test runs.
 */
export default class FileStartReporter {
  onTestModuleQueued(testModule: { moduleId?: string; filepath?: string }): void {
    const path = testModule?.moduleId ?? testModule?.filepath ?? '<unknown>';
    process.stderr.write(`[FILE QUEUED] ${path}\n`);
  }
  onTestModuleStart(testModule: { moduleId?: string; filepath?: string }): void {
    const path = testModule?.moduleId ?? testModule?.filepath ?? '<unknown>';
    process.stderr.write(`[FILE START] ${path}\n`);
  }
  onTestModuleEnd(testModule: { moduleId?: string; filepath?: string }): void {
    const path = testModule?.moduleId ?? testModule?.filepath ?? '<unknown>';
    process.stderr.write(`[FILE END] ${path}\n`);
  }
}
