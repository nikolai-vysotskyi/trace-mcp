/**
 * Worktree-aware project resolution.
 *
 * `git worktree add <path>` creates a linked working tree that shares the
 * underlying object database with the main checkout. AI agents (Codex,
 * Cursor, Continue, Cline, Roo Code) often invoke trace-mcp from these
 * temporary worktree paths and treat them as fresh unindexed repos —
 * because the project key in the registry is just the absolute path,
 * which is different per worktree.
 *
 * The cost: each short-lived feature branch builds its own redundant index.
 * The fix: when a worktree path doesn't match any registered project
 * directly, resolve to a canonical (already-indexed) repo that shares
 * the same `--git-common-dir`. Read-only lookups (search, get_symbol,
 * get_outline, etc.) can route to the canonical index; clients that
 * specifically need branch-local / uncommitted state can still index the
 * worktree explicitly.
 *
 * Mirrors jcodemunch v1.82.0 canonical-candidates behavior.
 */

import path from 'node:path';
import { logger } from './logger.js';
import { listProjects, type RegistryEntry, resolveRegisteredAncestor } from './registry.js';
import { probeWorktree, type WorktreeProbe } from './utils/git-worktree.js';

export interface CanonicalCandidate {
  /** The registered project that shares the worktree's common-dir. */
  entry: RegistryEntry;
  /** Why we proposed this — useful for the user-facing hint. */
  rationale: 'shared_git_common_dir' | 'main_worktree_match';
}

export interface WorktreeResolveResult {
  /**
   * Direct registry hit — `requestedRoot` itself or one of its ancestors
   * is a registered project. Wins over any worktree-aware fallback.
   */
  direct: RegistryEntry | null;
  /**
   * True when `requestedRoot` is a *linked* worktree (not the main one)
   * and at least one canonical_candidate was found. Use this to decide
   * whether to surface the routing hint to the caller.
   */
  isLinkedWorktree: boolean;
  /**
   * Already-indexed projects that share the same `--git-common-dir` as
   * `requestedRoot`. Empty when no match. Sorted by likelihood (main
   * worktree first if detectable).
   */
  canonicalCandidates: CanonicalCandidate[];
  /** Raw worktree probe — null when path isn't inside a git work-tree. */
  probe: WorktreeProbe | null;
}

/**
 * Resolve a requested project root with worktree awareness.
 *
 * Priority:
 *   1. Direct registry ancestor lookup (existing semantics).
 *   2. If the path is a linked git worktree, find registered projects
 *      that share its `--git-common-dir` and return them as candidates.
 *
 * Returns even when `direct` is non-null so callers can opt into
 * worktree-aware behavior without losing the direct match.
 */
export function resolveWorktreeAware(requestedRoot: string): WorktreeResolveResult {
  const direct = resolveRegisteredAncestor(requestedRoot);

  // Fast path: direct registry match. We still probe so the caller can
  // detect when *that* registered project is itself a linked worktree.
  let probe: WorktreeProbe | null = null;
  try {
    probe = probeWorktree(requestedRoot);
  } catch (e) {
    logger.debug({ err: e, requestedRoot }, 'worktree probe failed (best-effort)');
  }

  if (!probe || !probe.isInsideWorkTree) {
    return { direct, isLinkedWorktree: false, canonicalCandidates: [], probe };
  }

  // Only volunteer canonical candidates when the requested path is a
  // *linked* worktree. The main worktree's common-dir is its own .git
  // dir; finding "candidates" that share it would be self-referential.
  if (!probe.isLinkedWorktree) {
    return { direct, isLinkedWorktree: false, canonicalCandidates: [], probe };
  }

  const targetCommon = probe.commonDir;
  if (!targetCommon) {
    return { direct, isLinkedWorktree: true, canonicalCandidates: [], probe };
  }

  const candidates: CanonicalCandidate[] = [];
  for (const entry of listProjects()) {
    // Don't propose the same path that's being requested
    if (path.resolve(entry.root) === path.resolve(requestedRoot)) continue;

    let entryProbe: WorktreeProbe | null = null;
    try {
      entryProbe = probeWorktree(entry.root);
    } catch {
      continue;
    }
    if (!entryProbe?.commonDir) continue;
    if (path.resolve(entryProbe.commonDir) !== path.resolve(targetCommon)) continue;

    // Prefer the main worktree (its mainWorktreePath equals its own root)
    // over other linked worktrees of the same shared repo.
    const isMain = !entryProbe.isLinkedWorktree;
    candidates.push({
      entry,
      rationale: isMain ? 'main_worktree_match' : 'shared_git_common_dir',
    });
  }

  // Main worktree first, then alphabetical by name for determinism.
  candidates.sort((a, b) => {
    if (a.rationale !== b.rationale) {
      return a.rationale === 'main_worktree_match' ? -1 : 1;
    }
    return a.entry.name.localeCompare(b.entry.name);
  });

  return { direct, isLinkedWorktree: true, canonicalCandidates: candidates, probe };
}

/**
 * Build the user-facing hint string. Returns null when there's nothing
 * to surface (path isn't a linked worktree, or no canonical candidates).
 */
export function worktreeHint(result: WorktreeResolveResult): string | null {
  if (!result.isLinkedWorktree || result.canonicalCandidates.length === 0) return null;
  const main = result.canonicalCandidates[0];
  return (
    `This is a Git worktree of an already-indexed repo (${main.entry.name}). ` +
    'Read-only lookups can route to the canonical index for free; ' +
    'index this worktree explicitly only when you need branch-local or uncommitted state.'
  );
}
