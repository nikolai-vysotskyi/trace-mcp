/**
 * EnvIndexer: handles .env file indexing (keys + type metadata only, never values).
 * Extracted from IndexingPipeline to reduce pipeline complexity.
 */
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Store } from '../db/store.js';
import type { TraceMcpConfig } from '../config.js';
import { hashContent } from '../utils/hasher.js';
import { validatePath } from '../utils/security.js';
import { parseEnvFile } from '../utils/env-parser.js';
import { TraceignoreMatcher } from '../utils/traceignore.js';
import { logger } from '../logger.js';

const ENV_GLOB = ['.env', '.env.*', '.env.local', '**/.env', '**/.env.*'];

export class EnvIndexer {
  private traceignore: TraceignoreMatcher;

  constructor(
    private store: Store,
    private config: TraceMcpConfig,
    private rootPath: string,
    traceignore?: TraceignoreMatcher,
  ) {
    this.traceignore = traceignore ?? new TraceignoreMatcher(rootPath, config.ignore);
  }

  async indexEnvFiles(force: boolean): Promise<void> {
    const envPaths = await fg(ENV_GLOB, {
      cwd: this.rootPath,
      ignore: this.config.exclude,
      dot: true,
      absolute: false,
      onlyFiles: true,
    });

    if (envPaths.length === 0) return;

    logger.info({ count: envPaths.length }, 'Indexing .env files (keys only)');

    for (const relPath of envPaths) {
      if (this.traceignore.isIgnored(relPath)) {
        logger.debug({ file: relPath }, '.env file skipped by .traceignore');
        continue;
      }

      const absPath = path.resolve(this.rootPath, relPath);

      const pathCheck = validatePath(relPath, this.rootPath);
      if (pathCheck.isErr()) continue;

      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        logger.warn({ file: relPath }, 'Cannot read .env file');
        continue;
      }

      const hash = hashContent(Buffer.from(content));
      const existing = this.store.getFile(relPath);

      if (!force && existing && existing.content_hash === hash) continue;

      const entries = parseEnvFile(content);

      let fileId: number;
      if (existing) {
        fileId = existing.id;
        this.store.deleteEnvVarsByFile(fileId);
        this.store.updateFileHash(fileId, hash, content.length);
      } else {
        fileId = this.store.insertFile(relPath, 'env', hash, content.length);
        this.store.updateFileStatus(fileId, 'ok', 'config');
      }

      for (const entry of entries) {
        this.store.insertEnvVar(fileId, {
          key: entry.key,
          valueType: entry.valueType,
          valueFormat: entry.valueFormat,
          comment: entry.comment,
          quoted: entry.quoted,
          line: entry.line,
        });
      }

      logger.debug({ file: relPath, keys: entries.length }, '.env file indexed');
    }
  }
}
