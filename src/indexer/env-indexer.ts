/**
 * EnvIndexer: handles .env file indexing (keys + type metadata only, never values).
 * Extracted from IndexingPipeline to reduce pipeline complexity.
 */
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import picomatch from 'picomatch';
import type { TraceMcpConfig } from '../config.js';
import type { Store } from '../db/store.js';
import { logger } from '../logger.js';
import { descendantExcludeGlobs } from '../registry.js';
import { initContentHasher } from '../util/hash.js';
import { parseEnvFile } from '../utils/env-parser.js';
import { GitignoreMatcher } from '../utils/gitignore.js';
import { hashContent } from '../utils/hasher.js';
import { validatePath } from '../utils/security.js';
import { TraceignoreMatcher } from '../utils/traceignore.js';

const ENV_GLOB = ['.env', '.env.*', '.env.local', '**/.env', '**/.env.*'];
const ENV_FILE_BASENAME = /^\.env(\.[^/]*)?$/;

function isEnvFilePattern(pattern: string): boolean {
  const basename = pattern.split('/').pop() ?? pattern;
  return ENV_FILE_BASENAME.test(basename);
}

/**
 * TRA-2067 finding 3: fast-glob prunes a whole *directory* for a bare
 * directory pattern (e.g. `secrets`), while a bare
 * `picomatch(pattern)(filePath)` probe only matches file paths. Test each
 * ancestor segment too — that is what the glob's directory pruning amounts
 * to. (Spelled without a globstar prefix here: that two-character sequence
 * would terminate this block comment.)
 */
function matchesExclude(m: (p: string) => boolean, relPosix: string): boolean {
  if (m(relPosix)) return true;
  for (let i = relPosix.indexOf('/'); i > 0; i = relPosix.indexOf('/', i + 1)) {
    if (m(relPosix.slice(0, i))) return true;
  }
  return false;
}

export class EnvIndexer {
  private traceignore: TraceignoreMatcher;
  private gitignore: GitignoreMatcher | undefined;

  constructor(
    private store: Store,
    private config: TraceMcpConfig,
    private rootPath: string,
    traceignore?: TraceignoreMatcher,
    gitignore?: GitignoreMatcher,
  ) {
    this.traceignore = traceignore ?? new TraceignoreMatcher(rootPath, config.ignore);
    this.gitignore =
      gitignore ??
      (config.ignore?.gitignore === false ? undefined : new GitignoreMatcher(rootPath));
  }

  async indexEnvFiles(force: boolean): Promise<void> {
    try {
      await this.indexEnvFilesUnsafe(force);
    } catch (err) {
      logger.warn({ err }, 'Env indexing failed — skipping');
    }
  }

  /**
   * TRA-2067 (GH#1450): find indexed env rows the collector no longer owns.
   *
   * `selectOutOfScopeFiles` in pipeline.ts deliberately exempts `language
   * 'env'` rows (the code walk never visits `.env` — default
   * `config.exclude` hides them — so "not in scope" would otherwise wipe
   * every env row on every full walk). That exemption leaked: an env file
   * added to `ignore.patterns` / `.traceignore`, git-ignored afterwards, or
   * deleted from disk kept its key names + comments in the index and kept
   * being served via `get_env_vars` against an explicit user ignore.
   *
   * A row is stale when any gate the collect pass applies would now skip it
   * (traceignore incl. `ignore.patterns`, descendant ownership, gitignore,
   * non-env `config.exclude` patterns) or when it no longer exists on disk.
   * Pure read — callers delete the returned ids via `store.deleteFile`
   * (which cascades `env_vars` through `ON DELETE CASCADE`).
   */
  findStaleEnvFileIds(): number[] {
    let rows: { id: number; path: string }[];
    try {
      rows = this.store
        .getAllFiles()
        .filter((f) => f.language === 'env')
        .map((f) => ({ id: f.id, path: f.path }));
    } catch {
      return [];
    }
    if (rows.length === 0) return [];

    const descendantGlobs = descendantExcludeGlobs(this.rootPath);
    const ownedByDescendant = descendantGlobs.length
      ? picomatch(descendantGlobs, { dot: true })
      : undefined;
    // Same filter as the collect pass: default `config.exclude` carries
    // `**/.env` patterns to keep env files out of the CODE index — those
    // must not count as "excluded" here, only the non-env patterns the
    // collector itself honours via fast-glob `ignore`.
    const nonEnvExcludes = this.config.exclude.filter((p) => !isEnvFilePattern(p));
    const isExcluded =
      nonEnvExcludes.length > 0 ? picomatch(nonEnvExcludes, { dot: true }) : undefined;

    const stale: number[] = [];
    for (const row of rows) {
      const relPosix = row.path.split(path.sep).join('/');
      if (this.traceignore.isIgnored(relPosix)) {
        stale.push(row.id);
        continue;
      }
      if (ownedByDescendant?.(relPosix)) {
        stale.push(row.id);
        continue;
      }
      if (this.gitignore?.isIgnored(relPosix)) {
        stale.push(row.id);
        continue;
      }
      if (isExcluded && matchesExclude(isExcluded, relPosix)) {
        stale.push(row.id);
        continue;
      }
      try {
        const st = fs.statSync(path.resolve(this.rootPath, relPosix));
        if (!st.isFile()) stale.push(row.id);
      } catch (err) {
        // Only confirmed deletions retire the row. Permission / transient
        // I/O errors (EACCES, EMFILE, stale NFS handles) must never turn
        // into data deletion — mirrors reconcileSubprojectIndex
        // (src/subproject/reconcile-index.ts). EACCES rows stay until the
        // path is readable again, when the hash gate re-indexes them.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') stale.push(row.id);
      }
    }
    return stale;
  }

  /**
   * TRA-2067: delete the rows `findStaleEnvFileIds` reports. Best-effort —
   * a locked/closed DB just means the next full walk retries. Returns the
   * number of rows dropped.
   */
  pruneStaleEnvFiles(): number {
    const ids = this.findStaleEnvFileIds();
    if (ids.length === 0) return 0;
    try {
      this.store.db.transaction(() => {
        for (const id of ids) this.store.deleteFile(id);
      })();
    } catch (err) {
      logger.warn({ err }, 'Stale .env prune failed — skipping');
      return 0;
    }
    logger.info({ removed: ids.length }, 'Dropped stale .env rows (ignored or deleted)');
    return ids.length;
  }

  private async indexEnvFilesUnsafe(force: boolean): Promise<void> {
    await initContentHasher();
    // Default config.exclude contains `**/.env` / `**/.env.*` to keep env files out of
    // the code index. EnvIndexer only records keys + inferred types/formats (no values),
    // so those patterns would wrongly hide our input — filter them before globbing.
    // descendantExcludeGlobs: a registered descendant owns its own subtree, so an
    // umbrella root must not index the descendant's .env files into a second DB
    // (#209 / TRA-468 — same gate collectFiles() and filterIndexablePaths apply).
    const descendantGlobs = descendantExcludeGlobs(this.rootPath);
    const ignore = [...this.config.exclude.filter((p) => !isEnvFilePattern(p)), ...descendantGlobs];

    // followSymbolicLinks defaults to false (config.follow_symlinks) — a directory
    // symlink cycling back to an ancestor (e.g. Ansible Molecule's
    // `roles/<role> -> ../../../` layout) would otherwise make fast-glob recurse
    // until ENAMETOOLONG (#218). suppressErrors: true is a second layer of defense
    // on top of the outer try/catch — traversal errors should skip .env discovery,
    // not abort indexing.
    const envPaths = await fg(ENV_GLOB, {
      cwd: this.rootPath,
      ignore,
      dot: true,
      absolute: false,
      onlyFiles: true,
      followSymbolicLinks: this.config.follow_symlinks,
      suppressErrors: true,
    });

    // TRA-2067: prune even when the walk found nothing — an ignore rule
    // that hides every .env file must still retire the rows the previous
    // run wrote, otherwise the early return below re-leaks them forever.
    if (envPaths.length === 0) {
      this.pruneStaleEnvFiles();
      return;
    }

    logger.info({ count: envPaths.length }, 'Indexing .env files (keys only)');

    // Post-glob gates mirroring filterIndexablePaths: the fast-glob ignore
    // above handles the common case, but these catch anything the glob
    // misses so event-driven callers can't re-add excluded rows either.
    const ownedByDescendant = descendantGlobs.length
      ? picomatch(descendantGlobs, { dot: true })
      : undefined;

    for (const relPath of envPaths) {
      if (this.traceignore.isIgnored(relPath)) {
        logger.debug({ file: relPath }, '.env file skipped by .traceignore');
        continue;
      }

      const relPosix = relPath.split(path.sep).join('/');
      if (ownedByDescendant?.(relPosix)) {
        logger.debug(
          { file: relPath },
          '.env file skipped: owned by a more-specific registered project',
        );
        continue;
      }
      if (this.gitignore?.isIgnored(relPosix)) {
        logger.debug({ file: relPath }, '.env file skipped: git-ignored');
        continue;
      }

      const absPath = path.resolve(this.rootPath, relPath);

      const pathCheck = validatePath(relPath, this.rootPath);
      if (pathCheck.isErr()) continue;

      let fileMtimeMs: number | null = null;
      try {
        const stat = fs.lstatSync(absPath);
        fileMtimeMs = Math.floor(stat.mtimeMs);
      } catch {
        // stat failed — readFileSync below will handle ENOENT
      }

      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        logger.warn({ file: relPath }, 'Cannot read .env file');
        continue;
      }

      const hash = hashContent(Buffer.from(content));
      const existing = this.store.getFile(relPath);

      if (!force && existing && existing.content_hash === hash) {
        if (fileMtimeMs != null && existing.mtime_ms !== fileMtimeMs) {
          this.store.updateFileMtime(existing.id, fileMtimeMs);
        }
        continue;
      }

      const entries = parseEnvFile(content);

      let fileId: number;
      if (existing) {
        fileId = existing.id;
        this.store.deleteEnvVarsByFile(fileId);
        this.store.updateFileHash(fileId, hash, content.length, fileMtimeMs);
      } else {
        fileId = this.store.insertFile(relPath, 'env', hash, content.length, null, fileMtimeMs);
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

    // TRA-2067: retire rows the gates above now skip (newly ignored) or that
    // vanished from disk. Runs on every env pass so the incremental-discovery
    // fast path — which never calls `reconcileScope` — converges too.
    this.pruneStaleEnvFiles();
  }
}
