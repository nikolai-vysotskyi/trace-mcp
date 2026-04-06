/**
 * File watcher for auto-reindexing — watches the project directory for changes
 * and triggers incremental reindexing with debounce.
 *
 * Uses Node.js native fs.watch (recursive) to avoid extra dependencies.
 * Only reindexes files with extensions known to the plugin registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { TraceignoreMatcher, type TraceignoreConfig } from './utils/traceignore.js';

interface FileWatcherOptions {
  /** Debounce interval in ms (default 2000) */
  debounceMs?: number;
  /** Set of file extensions to watch (e.g. '.ts', '.py'). If empty, watches all. */
  extensions?: Set<string>;
  /** Directories/patterns to ignore */
  ignoreDirs?: string[];
  /** Traceignore config from project/global config */
  ignoreConfig?: TraceignoreConfig;
}

export class FileWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pendingFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly extensions: Set<string>;
  private readonly traceignore: TraceignoreMatcher;
  private readonly projectRoot: string;
  private readonly onChanged: (files: string[]) => Promise<void>;

  constructor(
    projectRoot: string,
    onChanged: (files: string[]) => Promise<void>,
    options: FileWatcherOptions = {},
  ) {
    this.projectRoot = projectRoot;
    this.onChanged = onChanged;
    this.debounceMs = options.debounceMs ?? 2000;
    this.extensions = options.extensions ?? new Set();
    this.traceignore = new TraceignoreMatcher(projectRoot, options.ignoreConfig);
  }

  start(): void {
    try {
      this.watcher = fs.watch(this.projectRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (this.shouldIgnore(filename)) return;
        if (this.extensions.size > 0) {
          const ext = path.extname(filename);
          if (!this.extensions.has(ext)) return;
        }
        this.pendingFiles.add(filename);
        this.scheduleBatch();
      });

      this.watcher.on('error', (err) => {
        logger.debug({ error: err }, 'File watcher error (non-fatal)');
      });

      logger.debug({ root: this.projectRoot }, 'File watcher started');
    } catch (err) {
      // Graceful degradation — watcher is best-effort
      logger.debug({ error: err }, 'Failed to start file watcher (auto-reindex disabled)');
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.pendingFiles.clear();
  }

  private scheduleBatch(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flushBatch();
    }, this.debounceMs);
  }

  private flushBatch(): void {
    if (this.pendingFiles.size === 0) return;
    const files = [...this.pendingFiles];
    this.pendingFiles.clear();
    logger.debug({ count: files.length }, 'Auto-reindex triggered by file changes');
    this.onChanged(files).catch((err) => {
      logger.debug({ error: err }, 'Auto-reindex failed (non-fatal)');
    });
  }

  private shouldIgnore(filePath: string): boolean {
    return this.traceignore.isIgnored(filePath);
  }
}
