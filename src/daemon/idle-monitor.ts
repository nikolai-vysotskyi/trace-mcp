import { logger } from '../logger.js';

export interface IdleMonitorOptions {
  /** ms with no active clients before self-exit. 0 or negative disables. */
  idleTimeoutMs: number;
  /** Called when the idle threshold is reached AND isBusy() still returns false. */
  onIdle: () => Promise<void> | void;
  /** Returns true while any client (stdio proxy, http session, SSE) is connected. */
  isBusy: () => boolean;
}

/**
 * Pure, testable idle monitor.
 *
 * Call `.onActivity()` whenever a client connects/disconnects so the monitor
 * can re-evaluate. The monitor arms a timer only when isBusy() returns false;
 * clients connecting while armed cancel the timer.
 *
 * Disabled if idleTimeoutMs <= 0.
 */
export class DaemonIdleMonitor {
  private readonly opts: IdleMonitorOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: IdleMonitorOptions) {
    this.opts = opts;
  }

  get enabled(): boolean {
    return this.opts.idleTimeoutMs > 0;
  }

  /** Re-evaluate. Call on every client connect/disconnect. */
  onActivity(): void {
    if (this.stopped || !this.enabled) return;
    const busy = this.opts.isBusy();
    if (busy) {
      // Cancel any armed timer — we have work to do.
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return;
    }
    // Idle: arm (or re-arm) the timer.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      // Final re-check — a client might have connected between schedule and fire.
      if (this.opts.isBusy()) return;
      logger.info({ idleMs: this.opts.idleTimeoutMs }, 'Daemon idle — self-exiting');
      void this.opts.onIdle();
    }, this.opts.idleTimeoutMs);
    this.timer.unref?.();
  }

  /** Stop the monitor — no further callbacks will fire. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
