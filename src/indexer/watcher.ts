import * as parcelWatcher from '@parcel/watcher';
import path from 'node:path';
import type { TraceMcpConfig } from '../config.js';
import { logger } from '../logger.js';

const IGNORE_DIRS = [
  'vendor', 'node_modules', '.git', 'storage',
  'bootstrap/cache', '.nuxt', '.next', 'dist', 'build', '.idea',
];

/** Debounce window in ms — coalesces rapid saves from editors. */
export const DEFAULT_DEBOUNCE_MS = 300;

export class FileWatcher {
  private subscription: parcelWatcher.AsyncSubscription | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPaths: Set<string> = new Set();

  constructor(
    private readonly _setTimeout: typeof setTimeout = setTimeout,
    private readonly _clearTimeout: typeof clearTimeout = clearTimeout,
  ) {}

  async start(
    rootPath: string,
    config: TraceMcpConfig,
    onChanges: (paths: string[]) => Promise<void>,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  ): Promise<void> {
    const ignoreDirs = IGNORE_DIRS.map((d) => path.join(rootPath, d));

    this.subscription = await parcelWatcher.subscribe(
      rootPath,
      async (err, events) => {
        if (err) {
          logger.error({ error: err }, 'Watcher error');
          return;
        }

        const changed = events
          .filter((e) => e.type === 'create' || e.type === 'update')
          .map((e) => e.path)
          .filter((p) => !ignoreDirs.some((d) => p.startsWith(d)));

        if (changed.length === 0) return;

        // Accumulate paths and debounce — multiple rapid saves collapse into one call
        for (const p of changed) this.pendingPaths.add(p);

        if (this.debounceTimer) this._clearTimeout(this.debounceTimer);
        this.debounceTimer = this._setTimeout(async () => {
          const paths = Array.from(this.pendingPaths);
          this.pendingPaths.clear();
          this.debounceTimer = null;
          logger.debug({ count: paths.length }, 'File changes detected');
          await onChanges(paths);
        }, debounceMs);
      },
      {
        ignore: ignoreDirs,
      },
    );

    logger.info({ rootPath }, 'File watcher started');
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      this._clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.pendingPaths.clear();
    }
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
      logger.info('File watcher stopped');
    }
  }
}
