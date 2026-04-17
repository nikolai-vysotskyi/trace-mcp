import { isDaemonRunning } from '../client.js';
import { logger } from '../../logger.js';
import type { DaemonWatcher } from './types.js';

export interface DaemonWatcherOptions {
  port: number;
  /** How often to ping /health (ms). */
  pollIntervalMs?: number;
  /** How long a new state must persist before it's reported as "stable" (ms). */
  stabilityMs?: number;
}

/**
 * Polls the daemon /health endpoint and reports *stable* state changes.
 *
 * Strategy:
 *   - Poll every pollIntervalMs (default 10s).
 *   - When observed state differs from the last reported state, start a stability timer.
 *   - Only emit onStableChange if the new state persists across all polls for stabilityMs.
 *   - If the state flips back before the stability window closes, cancel — no event.
 *
 * Initial state (first poll) is reported without delay so startup is fast.
 */
export class PollingDaemonWatcher implements DaemonWatcher {
  private readonly port: number;
  private readonly pollIntervalMs: number;
  private readonly stabilityMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private currentReported: boolean | null = null;
  private pendingState: boolean | null = null;
  private subscribers: Array<(state: boolean) => void> = [];
  private stopped = false;

  constructor(opts: DaemonWatcherOptions) {
    this.port = opts.port;
    this.pollIntervalMs = opts.pollIntervalMs ?? 10_000;
    this.stabilityMs = opts.stabilityMs ?? 30_000;
  }

  getCurrentState(): boolean {
    return this.currentReported === true;
  }

  onStableChange(cb: (daemonActive: boolean) => void): void {
    this.subscribers.push(cb);
  }

  async start(): Promise<void> {
    if (this.pollTimer) return;
    // Initial poll, no debounce — set the baseline immediately.
    const initial = await isDaemonRunning(this.port).catch(() => false);
    this.currentReported = initial;
    this.pendingState = initial;
    logger.debug({ initial, port: this.port }, 'DaemonWatcher: initial state');
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.pollTimer = null;
    this.stabilityTimer = null;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const state = await isDaemonRunning(this.port).catch(() => false);
    if (this.stopped) return;

    if (state === this.currentReported) {
      // Same as currently-reported: cancel any pending flip.
      if (this.stabilityTimer) {
        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = null;
      }
      this.pendingState = state;
      return;
    }

    if (state === this.pendingState && this.stabilityTimer) {
      // Still pending same new state — timer is already running, let it finish.
      return;
    }

    // State differs from current, and is either new or reversal of a pending reversal.
    this.pendingState = state;
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.stopped) return;
      if (this.pendingState !== null && this.pendingState !== this.currentReported) {
        const next = this.pendingState;
        const prev = this.currentReported;
        this.currentReported = next;
        logger.info({ from: prev, to: next }, 'DaemonWatcher: stable state change');
        for (const cb of this.subscribers) {
          try { cb(next); } catch (err) { logger.warn({ err }, 'DaemonWatcher: subscriber threw'); }
        }
      }
    }, this.stabilityMs);
    this.stabilityTimer.unref?.();
  }
}
