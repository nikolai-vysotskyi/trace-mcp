/**
 * Cross-thread stall watchdog (TRA-1957).
 *
 * The TRA-1828 `EventLoopLagMonitor` lives on the daemon's only thread: when
 * that thread parks inside one synchronous span (a pathological `sqlite3_step`
 * runs *inside* a promise continuation, so the event loop never leaves the
 * microtask checkpoint) no same-thread timer can ever fire — the watchdog
 * cannot bark by construction. `/health` dies with it, and the desktop app's
 * 5 s watchdog is the only external observer left.
 *
 * This watchdog moves the *checking* to a `worker_threads` Worker that shares
 * one 8-byte heartbeat with the main thread. The main thread calls `beat()`
 * from the lag-monitor tick (i.e. once per event-loop turn); the worker wakes
 * every `checkIntervalMs` on its own thread and compares. A main thread stuck
 * in SQLite cannot stop the worker from noticing.
 *
 * Two stages, both appended as JSONL to `alertFile` (never to daemon.log —
 * pino is not thread-safe, a second writer would interleave/corrupt it):
 *   - `stalled`  (once per episode, after `alertAfterMs` without a beat):
 *     detection. External supervisors (and humans tailing the file) see it
 *     while the daemon is still wedged.
 *   - `fatal`    (once per episode, after `fatalAfterMs` without a beat):
 *     recovery. The worker SIGKILLs the process so launchd respawns a fresh
 *     daemon. SIGKILL specifically: `process.exit()` called in the worker
 *     only ends the worker (verified), and SIGTERM is unreliable here — the
 *     daemon's shutdown handlers need a live event loop, which is exactly
 *     what a wedged process does not have. Crash-safe by construction: every
 *     indexer chunk is its own transaction and the TRA-1017 repair scope
 *     redoes the interrupted one. The `fatal` line doubles as the death
 *     breadcrumb (cf. TRA-1911 exit records). Disable with `fatalExit: false`
 *     (or `TRACE_MCP_STALL_FATAL=0`) for alert-only mode.
 * A `recovered` line closes the episode when beats resume.
 *
 * The worker is spawned from an eval string (no extra dist entry to bundle)
 * and `unref`'d — it observes the process, never holds it open. `stop()`
 * terminates it; while stopped (or never started) the watchdog is inert.
 */
import { Worker } from 'node:worker_threads';

export interface StallWatchdogOptions {
  /** File the worker appends `stalled`/`fatal`/`recovered` JSONL to. */
  alertFile: string;
  /** How often the worker checks the heartbeat (ms). Default 1000. */
  checkIntervalMs?: number;
  /** Stall duration that logs `stalled` (ms). Default 10_000. */
  alertAfterMs?: number;
  /** Stall duration that logs `fatal` and kills (ms). Default 180_000. */
  fatalAfterMs?: number;
  /** SIGKILL on fatal (default true). False = alert-only. */
  fatalExit?: boolean;
  /** Called on the main thread if the worker dies unexpectedly (for logging). */
  onWorkerExit?: (info: { code: number | null; hadError: boolean }) => void;
}

const WORKER_SOURCE = `
const { workerData } = require('worker_threads');
const fs = require('fs');
const view = new BigInt64Array(workerData.sab);
const cfg = workerData;
let episodeAlerted = false;
let episodeFatal = false;
function line(kind, stallMs) {
  return JSON.stringify({ time: new Date().toISOString(), pid: cfg.pid, kind: kind, stallMs: stallMs, component: 'daemon' }) + '\\n';
}
function check() {
  let stallMs;
  try {
    stallMs = Date.now() - Number(Atomics.load(view, 0));
  } catch (e) {
    return;
  }
  if (stallMs < cfg.alertAfterMs) {
    if (episodeAlerted || episodeFatal) {
      try { fs.appendFileSync(cfg.alertFile, line('recovered', stallMs)); } catch (e) {}
    }
    episodeAlerted = false;
    episodeFatal = false;
    return;
  }
  if (!episodeAlerted) {
    episodeAlerted = true;
    try { fs.appendFileSync(cfg.alertFile, line('stalled', stallMs)); } catch (e) {}
    return;
  }
  if (stallMs >= cfg.fatalAfterMs && !episodeFatal) {
    episodeFatal = true;
    try { fs.appendFileSync(cfg.alertFile, line('fatal', stallMs)); } catch (e) {}
    if (cfg.fatalExit) {
      // process.exit() here would end only the worker and leave the wedged
      // main thread hanging forever (taking further alerts with it) — kill
      // the whole process instead. SIGKILL: SIGTERM would route into the
      // daemon's shutdown handlers, which need a live loop to run.
      try { process.kill(cfg.pid, 'SIGKILL'); } catch (e) {}
    }
  }
}
setInterval(check, cfg.checkIntervalMs);
`;

export class StallWatchdog {
  private readonly alertFile: string;
  private readonly checkIntervalMs: number;
  private readonly alertAfterMs: number;
  private readonly fatalAfterMs: number;
  private readonly fatalExit: boolean;
  private readonly onWorkerExit?: (info: { code: number | null; hadError: boolean }) => void;
  private readonly view: BigInt64Array;
  private readonly sab: SharedArrayBuffer;
  private worker: Worker | null = null;

  constructor(opts: StallWatchdogOptions) {
    this.alertFile = opts.alertFile;
    this.checkIntervalMs = opts.checkIntervalMs ?? 1000;
    this.alertAfterMs = opts.alertAfterMs ?? 10_000;
    this.fatalAfterMs = opts.fatalAfterMs ?? 180_000;
    this.fatalExit = opts.fatalExit ?? true;
    this.onWorkerExit = opts.onWorkerExit;
    this.sab = new SharedArrayBuffer(8);
    this.view = new BigInt64Array(this.sab);
  }

  /** Start watching. Idempotent. Beats immediately so startup isn't a stall. */
  start(): void {
    if (this.worker) return;
    this.beat();
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab: this.sab,
        pid: process.pid,
        alertFile: this.alertFile,
        checkIntervalMs: this.checkIntervalMs,
        alertAfterMs: this.alertAfterMs,
        fatalAfterMs: this.fatalAfterMs,
        fatalExit: this.fatalExit,
      },
    });
    // Observe only: a live watchdog must never keep the process up by itself.
    worker.unref();
    // A dead watchdog is a monitoring gap, not a data bug — report it on the
    // (by definition alive) main thread. No respawn: a crash-looping watcher
    // must not become its own log storm.
    worker.on('error', () => {
      this.worker = null;
      try {
        this.onWorkerExit?.({ code: null, hadError: true });
      } catch {
        /* observing must never break the loop it watches */
      }
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.worker = null;
        try {
          this.onWorkerExit?.({ code, hadError: false });
        } catch {
          /* observing must never break the loop it watches */
        }
      }
    });
    this.worker = worker;
  }

  /** Record one event-loop turn. Call from a per-tick callback. */
  beat(): void {
    Atomics.store(this.view, 0, BigInt(Date.now()));
  }

  /** Stop watching and release the worker. Idempotent. */
  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate().catch(() => {});
  }

  /** True while the worker is believed alive. */
  get running(): boolean {
    return this.worker !== null;
  }
}
