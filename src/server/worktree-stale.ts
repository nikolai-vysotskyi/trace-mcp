/**
 * Flag tool results that describe a file the worktree has changed.
 *
 * In a linked worktree the shared index holds the canonical checkout's version
 * of every file the branch touched. Instead of editing each tool, the gate
 * walks the finished response and marks every object whose own path field
 * names a delta file with `stale_on_branch: true`, then returns the affected
 * files so the caller can add one short warning.
 */

import { type WorktreeDelta, worktreeDeltaPaths } from '../worktree-delta.js';

/** Keys under which tools report the file an object belongs to. */
const PATH_KEYS = ['path', 'file', 'file_path', 'filePath'] as const;

/** List-of-paths keys: cannot carry a flag per item, but still feed the warning. */
const PATH_LIST_KEY_RE = /^(files|file_paths|filePaths|\w*_files|\w*Files)$/;

const MAX_DEPTH = 16;
/** Files named in the warning; the rest is summarised as a count. */
const WARNING_LIST_LIMIT = 5;

function normalize(p: string, roots: readonly string[]): string {
  let out = p.replace(/\\/g, '/');
  for (const root of roots) {
    const prefix = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
    if (out.startsWith(prefix)) {
      out = out.slice(prefix.length);
      break;
    }
  }
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/**
 * Mark delta files in a parsed tool response, in place.
 * Returns the distinct affected files in order of first appearance.
 */
export function markStaleOnBranch(payload: unknown, delta: WorktreeDelta): string[] {
  const deltaPaths = worktreeDeltaPaths(delta);
  if (deltaPaths.size === 0) return [];
  const roots = [delta.worktreeRoot, delta.canonicalRoot];
  const found = new Set<string>();

  const lookup = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length === 0) return null;
    const rel = normalize(value, roots);
    // Absolute paths outside both roots stay absolute and never match.
    return deltaPaths.has(rel) ? rel : null;
  };

  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const key of PATH_KEYS) {
      const hit = lookup(obj[key]);
      if (hit) {
        obj.stale_on_branch = true;
        found.add(hit);
        break;
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value) && PATH_LIST_KEY_RE.test(key)) {
        for (const item of value) {
          const hit = lookup(item);
          if (hit) found.add(hit);
        }
      }
      visit(value, depth + 1);
    }
  };

  visit(payload, 0);
  return [...found];
}

/**
 * One-line warning for `_warnings`; null when no delta file was involved.
 * `pending`: the session is served from a branch index and these files were
 * edited after it last re-indexed them.
 */
export function staleOnBranchWarning(
  files: readonly string[],
  kind: 'canonical' | 'pending' = 'canonical',
): string | null {
  if (files.length === 0) return null;
  const shown = files.slice(0, WARNING_LIST_LIMIT);
  const more = files.length > shown.length ? ` (+${files.length - shown.length} more)` : '';
  if (kind === 'pending') {
    return (
      `Worktree: ${files.length} file(s) in this result changed after the branch index last ` +
      `re-indexed them (marked stale_on_branch; re-indexing is under way). Read them from disk: ` +
      `${shown.join(', ')}${more}.`
    );
  }
  return (
    `Worktree: ${files.length} file(s) in this result changed on this branch and the shared index ` +
    `holds the canonical version (marked stale_on_branch). Read them from disk: ${shown.join(', ')}${more}.`
  );
}
