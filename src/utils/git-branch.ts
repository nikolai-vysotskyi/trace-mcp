/**
 * Git branch detection for branch-aware decision memory.
 *
 * Decisions captured on a feature branch (`feat/refactor-auth`) shouldn't pollute
 * the agent's context when the user `git checkout master`. Each decision row carries
 * a `git_branch` tag; reads filter by the current branch + branch-agnostic (NULL) rows
 * by default.
 *
 * Uses `git rev-parse --abbrev-ref HEAD` via execFile (no shell). On detached HEAD
 * the command returns "HEAD" — we map that to NULL so the decision is treated as
 * branch-agnostic. Worktrees just work: `--abbrev-ref HEAD` resolves the per-worktree
 * branch from the linked `.git` file, not the parent repo's HEAD.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { safeGitEnv } from './git-env.js';

/**
 * Best-effort current branch lookup for a git working tree.
 *
 * Returns the branch name on success, or `null` when:
 * - `repoPath` does not exist
 * - `repoPath` is not inside a git work-tree
 * - HEAD is detached (the command yields the literal string "HEAD")
 * - git is not available, or the call times out
 *
 * Callers should treat `null` as "branch-agnostic" — store NULL, match every branch
 * filter mode.
 */
export function getCurrentBranch(repoPath: string): string | null {
  if (!repoPath || !fs.existsSync(repoPath)) return null;

  let raw: string;
  try {
    raw = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
      env: safeGitEnv(),
    });
  } catch {
    return null;
  }

  const branch = raw.trim();
  if (!branch) return null;
  // Detached HEAD returns the literal "HEAD" — treat as branch-agnostic.
  if (branch === 'HEAD') return null;
  return branch;
}
