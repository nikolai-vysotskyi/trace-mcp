import { writeFileSync } from 'node:fs';
import { StallWatchdog } from '../../stall-watchdog.js';

const [alertFile, logFile] = process.argv.slice(2);
if (!alertFile || !logFile) throw new Error('expected alert and log paths');

const at = (time: string) => Date.parse(`2026-10-22 ${time} +0400`);
const clock = new SharedArrayBuffer(8);
const view = new BigInt64Array(clock);
Atomics.store(view, 0, BigInt(at('22:34:20')));
writeFileSync(
  logFile,
  [
    '2026-10-22 22:34:27 +0400 Sleep               \tEntering Sleep state',
    '2026-10-22 22:36:23 +0400 DarkWake            \tDarkWake from Deep Idle',
    '2026-10-22 22:36:32 +0400 Sleep               \tEntering Sleep state',
    '2026-10-22 22:44:22 +0400 DarkWake            \tDarkWake from Deep Idle',
    '2026-10-22 22:44:27 +0400 Sleep               \tEntering Sleep state',
    '2026-10-22 22:53:56 +0400 Wake                \tWake from Deep Idle',
  ].join('\n'),
);

const watchdog = new StallWatchdog({
  alertFile,
  checkIntervalMs: 10,
  alertAfterMs: 30_000,
  fatalAfterMs: 60_000,
  testClock: clock,
  testSleepLogFile: logFile,
});
watchdog.start();
await new Promise((resolve) => setTimeout(resolve, 50));
Atomics.store(view, 0, BigInt(at('22:53:56')));
await new Promise((resolve) => setTimeout(resolve, 100));
// Past the five-second wake grace, only correct sleep subtraction can save us.
Atomics.store(view, 0, BigInt(at('22:54:03')));
await new Promise((resolve) => setTimeout(resolve, 100));
watchdog.beat();
await new Promise((resolve) => setTimeout(resolve, 50));
await watchdog.stop();
