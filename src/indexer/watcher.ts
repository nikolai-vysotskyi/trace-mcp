import * as parcelWatcher from '@parcel/watcher';
import path from 'node:path';
import type { TraceMcpConfig } from '../config.js';
import { logger } from '../logger.js';

const IGNORE_DIRS = [
  'vendor', 'node_modules', '.git', 'storage',
  'bootstrap/cache', '.nuxt', '.next', 'dist', 'build', '.idea',
];

export class FileWatcher {
  private subscription: parcelWatcher.AsyncSubscription | null = null;

  async start(
    rootPath: string,
    config: TraceMcpConfig,
    onChanges: (paths: string[]) => Promise<void>,
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

        if (changed.length > 0) {
          logger.debug({ count: changed.length }, 'File changes detected');
          await onChanges(changed);
        }
      },
      {
        ignore: ignoreDirs,
      },
    );

    logger.info({ rootPath }, 'File watcher started');
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
      logger.info('File watcher stopped');
    }
  }
}
