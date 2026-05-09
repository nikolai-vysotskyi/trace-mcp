/**
 * Git worktree detection.
 *
 * `git worktree add <path>` creates a "linked" working tree that shares the
 * underlying object database with a "main" working tree. Each worktree has
 * its own `.git` *directory* (or *file*, for linked worktrees), but they
 * resolve to the same `--git-common-dir`. Indexing one worktree per branch
 * produces redundant indexes; routing read-only lookups to the canonical
 * (main) checkout avoids the duplication.
 *
 * Mirrors the discovery side of jcodemunch v1.82.0. The integration with
 * resolve_repo lives in src/registry/* and reuses these primitives.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { safeGitEnv } from './git-env.js';

export interface WorktreeProbe {
  /** True if `path` is inside any git working tree (linked or main). */
  isInsideWorkTree: boolean;
  /** True if this specific path is a *linked* worktree (not the main one). */
  isLinkedWorktree: boolean;
  /**
   * Absolute path to the shared git common-dir (the main repo's `.git`
   * directory). Two worktrees share the same value here. `null` when
   * `path` is not inside a git work-tree.
   */
  commonDir: string | null;
  /**
   * Absolute path to the main worktree's working directory (the directory
   * containing the canonical `.git` *directory*). `null` when undetectable
   * — typically because the main worktree has been removed or moved.
   */
  mainWorktreePath: string | null;
}

const NULL_PROBE: WorktreeProbe = {
  isInsideWorkTree: false,
  isLinkedWorktree: false,
  commonDir: null,
  mainWorktreePath: null,
};

/**
 * Probe a path for worktree linkage. Returns NULL_PROBE on any failure
 * (path not in a repo, git not available, command timeout). Best-effort —
 * callers must treat any worktree-aware behavior as advisory.
 */
export function probeWorktree(repoPath: string): WorktreeProbe {
  if (!repoPath || !fs.existsSync(repoPath)) return NULL_PROBE;

  let isInsideWorkTree = false;
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
      env: safeGitEnv(),
    });
    isInsideWorkTree = out.trim() === 'true';
  } catch {
    return NULL_PROBE;
  }
  if (!isInsideWorkTree) return NULL_PROBE;

  let gitDir = '';
  let commonDir = '';
  try {
    const out = execFileSync(
      'git',
      ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'],
      {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1500,
        env: safeGitEnv(),
      },
    );
    const lines = out.trim().split(/\r?\n/);
    gitDir = lines[0] ?? '';
    commonDir = lines[1] ?? '';
    // lines[2] is the toplevel — captured here in case future callers want it
  } catch {
    return NULL_PROBE;
  }

  if (!commonDir) return NULL_PROBE;

  // git resolves these relative to cwd when they aren't absolute
  const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(repoPath, gitDir);
  const absCommonDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(repoPath, commonDir);

  // A linked worktree's git-dir is `<common>/worktrees/<name>/`, so its
  // absolute git-dir differs from the absolute common-dir. The main worktree
  // has them equal.
  const isLinkedWorktree = realpathSafe(absGitDir) !== realpathSafe(absCommonDir);

  // Main worktree path = the directory whose `.git` is `commonDir`.
  // commonDir is typically `<main>/.git`; strip the trailing `.git` to get it.
  const mainWorktreePath = deriveMainWorktreePath(absCommonDir);

  return {
    isInsideWorkTree,
    isLinkedWorktree,
    commonDir: realpathSafe(absCommonDir),
    mainWorktreePath: mainWorktreePath ? realpathSafe(mainWorktreePath) : null,
  };
}

/**
 * Resolve symlinks where possible, fall back to the input on failure.
 *
 * On macOS the system tmp dir resolves through `/var → /private/var`; without
 * canonicalizing, two paths that point at the same on-disk location compare
 * unequal as strings.
 *
 * On Windows, git sometimes returns a path in 8.3 short form
 * (`C:\Users\RUNNER~1\…`) and sometimes the long form
 * (`C:\Users\runneradmin\…`) for the SAME on-disk location, depending on
 * which API it used. JS-mode `fs.realpathSync` does not normalise between
 * the two; the **native** variant calls `GetFinalPathNameByHandle` which
 * always returns the canonical long form. Use the native binding when it's
 * available so two probes of the same dir always compare equal.
 */
function realpathSafe(p: string): string {
  const realpathFn =
    typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync;
  try {
    return realpathFn(p);
  } catch {
    return p;
  }
}

function deriveMainWorktreePath(absCommonDir: string): string | null {
  // Bare repos have commonDir at the repo itself (not "<main>/.git"). Detect
  // by checking the dirname's trailing component.
  const base = path.basename(absCommonDir);
  if (base === '.git') {
    return path.dirname(absCommonDir);
  }
  // Bare/standalone repo — there's no working-tree "main" per se. Return null.
  return null;
}

/**
 * Two paths share the same git common-dir? Useful for matching a worktree
 * against an already-indexed canonical repo. Both arguments are probed in
 * isolation; callers can pre-compute via `probeWorktree`.
 */
export function sharesGitCommonDir(a: string, b: string): boolean {
  const pa = probeWorktree(a);
  const pb = probeWorktree(b);
  if (!pa.commonDir || !pb.commonDir) return false;
  return path.resolve(pa.commonDir) === path.resolve(pb.commonDir);
}
