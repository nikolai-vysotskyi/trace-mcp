import fg from 'fast-glob';
import type { TraceMcpConfig } from '../config.js';
import { logger } from '../logger.js';
import { descendantExcludeGlobs } from '../registry.js';
import type { TraceignoreMatcher } from '../utils/traceignore.js';
import type { WorkspaceInfo } from './monorepo.js';

/** Inputs `collectFiles` needs, extracted out of `IndexingPipeline` so the
 *  glob+filter logic can be unit tested and read without the surrounding
 *  class's other lifecycle state. */
export interface FileCollectorParams {
  config: TraceMcpConfig;
  rootPath: string;
  workspaces: WorkspaceInfo[];
  traceignore: TraceignoreMatcher | undefined;
  /** Overridable for tests; defaults to 10_000 (IndexingPipeline.DEFAULT_MAX_FILES). */
  maxFiles: number;
}

/**
 * Resolves the set of repo-relative file paths to index for a run, given the
 * project's include/exclude globs, workspace layout, and .traceignore rules.
 *
 * Moved out of `IndexingPipeline.collectFiles` verbatim (2026-07 complexity
 * reduction pass) — behavior must stay byte-identical to the original
 * private method; only `this.*` field reads became explicit parameters.
 */
export async function collectFiles(params: FileCollectorParams): Promise<string[]> {
  const { config, rootPath, workspaces, traceignore, maxFiles } = params;
  const traceignoreIgnore = traceignore?.toFastGlobIgnore() ?? [];
  // Most-specific registered project owns a path: skip files that live under a
  // registered descendant so an umbrella root doesn't index its child repos
  // into a second DB (the double-index churn behind #209).
  const ignore = [...config.exclude, ...traceignoreIgnore, ...descendantExcludeGlobs(rootPath)];

  // suppressErrors: a path component that matches a directory-shaped glob
  // but is actually a file (e.g. a stray `<ws>/test` FILE meeting the
  // `test/**` include) made fast-glob throw ENOTDIR and abort the whole
  // initial index, bricking the project in 'error' state. Traversal errors
  // (ENOTDIR/EACCES/ELOOP) must skip the entry, not kill indexing.
  let entries = await fg(config.include, {
    cwd: rootPath,
    ignore,
    dot: false,
    absolute: false,
    onlyFiles: true,
    suppressErrors: true,
  });

  // Monorepo / folder-of-projects: the directory-rooted include globs
  // (src/**, app/**, routes/**, ...) only match at the container root, so
  // nested subprojects are missed (e.g. `the/15carats/15carats-laravel/routes`).
  // When workspaces are detected, also discover files with those patterns
  // anchored to each workspace. Global `**/...` patterns already span the whole
  // tree, so only re-anchor the directory-rooted ones. This is deterministic
  // and complete — unlike the entries===0 deep-glob fallback below, which never
  // fires when a root-level file (a stray README, a `**/*.md`) matched first.
  if (workspaces.length > 0) {
    const rooted = config.include.filter((p) => !p.startsWith('**/'));
    if (rooted.length > 0) {
      const wsPatterns = workspaces.flatMap((ws) => rooted.map((p) => `${ws.path}/${p}`));
      const wsEntries = await fg(wsPatterns, {
        cwd: rootPath,
        ignore,
        dot: false,
        absolute: false,
        onlyFiles: true,
        suppressErrors: true,
      });
      if (wsEntries.length > 0) {
        const merged = new Set(entries);
        for (const e of wsEntries) merged.add(e);
        entries = [...merged];
      }
    }
  }

  // Workspace/monorepo fallback: if nothing matched, all code is nested deeper
  // (e.g. root/project/service/src/**). Re-try with **/<pattern> prefixed globs.
  if (entries.length === 0) {
    const deepPatterns = config.include.filter((p) => !p.startsWith('**/')).map((p) => `**/${p}`);

    if (deepPatterns.length > 0) {
      entries = await fg(deepPatterns, {
        cwd: rootPath,
        ignore,
        dot: false,
        absolute: false,
        onlyFiles: true,
        suppressErrors: true,
      });
      if (entries.length > 0) {
        logger.info(
          { count: entries.length, root: rootPath },
          'Workspace root detected — using deep glob patterns',
        );
      }
    }
  }

  if (traceignore) {
    entries = entries.filter((e) => !traceignore.isIgnored(e));
  }

  if (entries.length > maxFiles) {
    logger.warn(
      { found: entries.length, limit: maxFiles },
      'File count exceeds limit — truncating. Increase security.max_files to index more.',
    );
    return entries.slice(0, maxFiles);
  }

  return entries;
}
