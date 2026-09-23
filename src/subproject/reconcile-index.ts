import fs from 'node:fs';
import path from 'node:path';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { logger } from '../logger.js';

/**
 * Child indexes can outlive their watcher (e.g. a child now covered by a
 * registered umbrella). Contract discovery alone never removes their old
 * source rows. Reconcile confirmed deletions whenever we synchronize topology,
 * before extracting contracts from these same indexes.
 */
export function reconcileSubprojectIndex(root: string, dbPath: string | null): number {
  if (!dbPath || !fs.existsSync(dbPath)) return 0;
  let db: ReturnType<typeof initializeDatabase> | undefined;
  try {
    // An offline/unreadable root is not evidence that every file was deleted.
    if (!fs.statSync(root).isDirectory()) return 0;
    fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
    db = initializeDatabase(dbPath);
    const store = new Store(db);
    const removed = db
      .transaction(() => {
        let count = 0;
        for (const file of store.getAllFiles()) {
          // These rows represent external dependencies, not physical sources.
          if (file.content_hash === '__phantom__' || file.content_hash === '__phantom_pkg__') {
            continue;
          }
          const absolute = path.resolve(root, file.path);
          const relative = path.relative(root, absolute);
          if (
            !relative ||
            relative === '..' ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            continue;
          }
          try {
            // Preserve even dangling symlinks: the source entry still exists.
            fs.lstatSync(absolute);
          } catch (err) {
            // Permission/I/O errors must never turn into data deletion.
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') continue;
            store.deleteFile(file.id);
            count++;
          }
        }
        return count;
      })
      .immediate();
    if (removed > 0) logger.info({ root, removed }, 'Removed deleted files from subproject index');
    return removed;
  } catch (error) {
    // Locked/unavailable indexes must not prevent the remaining repos syncing.
    logger.warn({ root, error }, 'Subproject index reconciliation skipped');
    return 0;
  } finally {
    db?.close();
  }
}
