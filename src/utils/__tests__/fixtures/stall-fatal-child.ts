/**
 * Fatal-path child for the StallWatchdog test (TRA-1957).
 *
 * Spawned by `stall-watchdog.test.ts` via `node --import tsx/esm/api` with
 * millisecond thresholds and `fatalExit: true`. Starts the REAL StallWatchdog,
 * then blocks the main thread synchronously past `fatalAfterMs` — the wedged
 * daemon in miniature. The worker must SIGKILL this process: reaching the
 * `process.exitCode = 42` line means the watchdog failed.
 *
 * Usage: stall-fatal-child.ts <alertFile> <alertAfterMs> <fatalAfterMs>
 */
import { StallWatchdog } from '../../stall-watchdog.js';

const [alertFile, alertAfterRaw, fatalAfterRaw] = process.argv.slice(2);
if (!alertFile || !alertAfterRaw || !fatalAfterRaw) {
  throw new Error('usage: stall-fatal-child.ts <alertFile> <alertAfterMs> <fatalAfterMs>');
}

const watchdog = new StallWatchdog({
  alertFile,
  checkIntervalMs: 10,
  alertAfterMs: Number(alertAfterRaw),
  fatalAfterMs: Number(fatalAfterRaw),
  fatalExit: true,
});
watchdog.start();

// Wedged: no beats, no yields, no timers — exactly one synchronous span.
const end = Date.now() + Number(fatalAfterRaw) + 5000;
while (Date.now() < end) {
  // busy-wait
}

// Survival is failure: the worker should have SIGKILLed us long ago.
process.exitCode = 42;
await watchdog.stop();
