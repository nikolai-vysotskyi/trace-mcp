/**
 * Worktree delta: which files of a linked git worktree differ from what the
 * canonical (shared) index holds.
 *
 * A linked worktree is served from the main checkout's index (see
 * `registry-worktree.ts` / `ProjectManager.addProject`), so for every file the
 * branch changed, an answer silently describes the canonical version. The
 * delta is the set of paths where that can happen:
 *
 *   git diff --name-status <canonical HEAD>   (run in the worktree: committed,
 *                                              staged and unstaged edits and
 *                                              deletions of tracked files)
 * + git ls-files --others --exclude-standard  (untracked, non-ignored files)
 *
 * It is the foundation for flagging results (`stale_on_branch`), exposing the
 * delta (`get_index_health`, `GET /api/projects/worktree`) and for guard hook
 * routing. It does not change what is indexed.
 *
 * Not covered: uncommitted edits in the canonical checkout itself (the
 * canonical index follows that working tree, the delta is computed against its
 * HEAD commit).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { detectGitWorktree } from './project-root.js';
import { safeGitEnv } from './utils/git-env.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
/** `git diff --name-status` for a branch far behind its base can be large. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * How long a computed delta is reused. HEAD ids alone cannot validate a cache
 * entry: unstaged edits and new untracked files change neither HEAD nor the
 * git index, and they are exactly what an agent produces between two tool
 * calls. A short TTL keeps the cost to at most one `git diff` per window.
 */
export const WORKTREE_DELTA_TTL_MS = 2_000;

/** Entries kept in the per-process cache (one per live worktree). */
export const WORKTREE_DELTA_CACHE_MAX = 64;

/** Cap on paths listed per category in {@link summarizeWorktreeDelta}. */
export const WORKTREE_DELTA_SUMMARY_LIMIT = 200;

export interface WorktreeLink {
  /** Root of the linked worktree (the directory holding the `.git` file). */
  worktreeRoot: string;
  /** Root of the checkout whose index serves this worktree. */
  canonicalRoot: string;
}

export interface WorktreeDelta extends WorktreeLink {
  worktreeHead: string;
  canonicalHead: string;
  /** Tracked files whose content differs from the canonical HEAD (incl. staged additions). */
  modified: string[];
  /** Tracked files deleted on the branch. */
  deleted: string[];
  /** Untracked, non-ignored files. */
  untracked: string[];
  /** Epoch ms the delta was computed at. */
  computedAt: number;
}

export interface WorktreeDeltaSummary {
  is_linked_worktree: true;
  worktree_root: string;
  canonical_root: string;
  worktree_head: string;
  canonical_head: string;
  /** Number of differing files (modified + deleted + untracked). */
  total: number;
  modified: string[];
  deleted: string[];
  untracked: string[];
  /** True when any list above was cut at {@link WORKTREE_DELTA_SUMMARY_LIMIT}. */
  truncated: boolean;
  /**
   * Which index answers this session: the canonical checkout's (results for
   * the files listed here describe the canonical version) or the worktree's
   * own branch index (a copy of the canonical index with this delta
   * re-indexed into it).
   */
  served_from: 'canonical_index' | 'branch_index';
  /** Set when the daemon keeps (or is building) a branch index for this worktree. */
  branch_index?: BranchIndexInfo;
  note: string;
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Walk up from `start` to the first directory holding a `.git` entry. When that
 * entry is a file and the directory is a linked worktree, return the worktree
 * root (toplevel) and the main checkout it hangs off; otherwise null. A cwd
 * inside a subdirectory of a worktree therefore resolves to the same root as the
 * worktree itself.
 */
export function findLinkedWorktree(
  start: string,
): { worktreeRoot: string; mainRoot: string } | null {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 64; depth++) {
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(path.join(dir, '.git'));
    } catch {
      /* no .git here — keep walking */
    }
    if (st) {
      if (!st.isFile()) return null;
      const info = detectGitWorktree(dir);
      if (!info) return null;
      return { worktreeRoot: realpathSafe(dir), mainRoot: realpathSafe(info.mainRoot) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Decide whether a session root is a linked worktree and which checkout
 * serves its index. Reads `.git` metadata directly, no subprocess.
 *
 * `worktreeHint` is the path a stdio proxy forwards when it routed a worktree
 * to a canonical project: the daemon session is then bound to the canonical
 * root, and the worktree identity would otherwise be lost. The hint is
 * untrusted input — it may be any directory inside the worktree, and it is only
 * honoured when that worktree's main checkout is exactly `sessionRoot`.
 *
 * Returns null for anything that is not a linked worktree (a main checkout, a
 * plain directory) — callers use that to leave the non-worktree path
 * untouched.
 */
export function resolveWorktreeLink(
  sessionRoot: string,
  worktreeHint?: string | null,
): WorktreeLink | null {
  if (worktreeHint) {
    const found = findLinkedWorktree(worktreeHint);
    if (!found || found.mainRoot !== realpathSafe(sessionRoot)) return null;
    return { worktreeRoot: found.worktreeRoot, canonicalRoot: found.mainRoot };
  }
  const found = findLinkedWorktree(sessionRoot);
  if (!found) return null;
  return { worktreeRoot: found.worktreeRoot, canonicalRoot: found.mainRoot };
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    // fsmonitor is a repo-config hook: never let a workspace run one here.
    const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: safeGitEnv(),
    });
    return stdout;
  } catch {
    return null;
  }
}

function splitNul(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

/**
 * Parse `git diff --name-status -z --no-renames`: `<status>\0<path>\0` pairs.
 * Exported for tests.
 */
export function parseNameStatusZ(out: string): { modified: string[]; deleted: string[] } {
  const tokens = splitNul(out);
  const modified: string[] = [];
  const deleted: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i];
    const file = tokens[i + 1];
    if (status.startsWith('D')) deleted.push(file);
    else modified.push(file);
  }
  return { modified, deleted };
}

/**
 * Compute the delta once, uncached. Resolves to null when git cannot answer
 * (not a repo, unborn HEAD, canonical HEAD commit missing from this repo's
 * object database) — the caller then simply has no delta.
 */
export async function computeWorktreeDelta(
  link: WorktreeLink,
  now: number = Date.now(),
): Promise<WorktreeDelta | null> {
  const [wtHeadOut, canonHeadOut] = await Promise.all([
    git(link.worktreeRoot, ['rev-parse', '--verify', 'HEAD']),
    git(link.canonicalRoot, ['rev-parse', '--verify', 'HEAD']),
  ]);
  const worktreeHead = wtHeadOut?.trim();
  const canonicalHead = canonHeadOut?.trim();
  if (!worktreeHead || !canonicalHead) return null;

  // `--relative` keeps paths relative to the worktree root (index paths are
  // root-relative), `--no-renames` reports a rename as delete + add so both
  // sides are in the delta.
  const [diffOut, untrackedOut] = await Promise.all([
    git(link.worktreeRoot, [
      'diff',
      '--name-status',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--relative',
      canonicalHead,
      '--',
    ]),
    git(link.worktreeRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (diffOut === null || untrackedOut === null) return null;

  const { modified, deleted } = parseNameStatusZ(diffOut);
  const untracked = splitNul(untrackedOut);
  return {
    ...link,
    worktreeHead,
    canonicalHead,
    modified: modified.sort(),
    deleted: deleted.sort(),
    untracked: untracked.sort(),
    computedAt: now,
  };
}

interface CacheEntry {
  at: number;
  value: Promise<WorktreeDelta | null>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(link: WorktreeLink): string {
  return `${link.worktreeRoot}\0${link.canonicalRoot}`;
}

/** Drop every cached delta. Tests only. */
export function clearWorktreeDeltaCache(): void {
  cache.clear();
}

/**
 * Cached {@link computeWorktreeDelta}: concurrent callers share one in-flight
 * computation, and a result is reused for `ttlMs`. Never rejects.
 */
export function getWorktreeDelta(
  link: WorktreeLink,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<WorktreeDelta | null> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? WORKTREE_DELTA_TTL_MS;
  const key = cacheKey(link);
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;

  if (cache.size >= WORKTREE_DELTA_CACHE_MAX) {
    for (const [k, v] of cache) {
      if (now - v.at >= ttlMs) cache.delete(k);
    }
    if (cache.size >= WORKTREE_DELTA_CACHE_MAX) {
      // Map order is insertion order and `set` on an existing key keeps its
      // slot, so evict by the recorded time, not by position.
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [k, v] of cache) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
  }
  const value = computeWorktreeDelta(link, now).catch(() => null);
  cache.set(key, { at: now, value });
  return value;
}

/** One set per computed delta: tool responses are marked on every call. */
const pathSets = new WeakMap<WorktreeDelta, Set<string>>();

/** All differing paths as one set (modified, deleted and untracked). */
export function worktreeDeltaPaths(delta: WorktreeDelta): Set<string> {
  let set = pathSets.get(delta);
  if (!set) {
    set = new Set([...delta.modified, ...delta.deleted, ...delta.untracked]);
    pathSets.set(delta, set);
  }
  return set;
}

export function worktreeDeltaSize(delta: WorktreeDelta): number {
  return delta.modified.length + delta.deleted.length + delta.untracked.length;
}

/**
 * A linked worktree's branch index as `get_index_health` and
 * `GET /api/projects/worktree` report it (`WorktreeIndexManager.describe`).
 */
export interface BranchIndexInfo {
  /**
   * `ready`: the copy answers. `building`: no copy yet, one is being built.
   * `opening`/`retiring`/`closed`: a copy coming up or going away. `none`:
   * no copy (not built yet, refused or failed — see `last_error`).
   */
  state: 'none' | 'building' | 'opening' | 'ready' | 'retiring' | 'closed';
  /** HEAD the canonical index had indexed when the copy was taken (no copy: absent). */
  canonical_head_at_copy?: string;
  built_at?: string;
  /** Files edited after the copy last re-indexed them (capped at 50). */
  pending: string[];
  /** Files the copy has re-indexed from the worktree so far. */
  reindexed_files: number;
  /** Why the last build did not produce a copy, when it did not. */
  last_error?: string;
}

/**
 * Compact, size-bounded form of the delta for health and API payloads.
 * `served_from` follows `branchIndex`: a ready copy answers, otherwise the
 * canonical index does.
 */
export function summarizeWorktreeDelta(
  delta: WorktreeDelta,
  limit: number = WORKTREE_DELTA_SUMMARY_LIMIT,
  branchIndex: BranchIndexInfo | null = null,
): WorktreeDeltaSummary {
  const servedFrom: WorktreeDeltaSummary['served_from'] =
    branchIndex?.state === 'ready' ? 'branch_index' : 'canonical_index';
  const cut = (xs: string[]): string[] => (xs.length > limit ? xs.slice(0, limit) : xs);
  const truncated =
    delta.modified.length > limit || delta.deleted.length > limit || delta.untracked.length > limit;
  return {
    is_linked_worktree: true,
    worktree_root: delta.worktreeRoot,
    canonical_root: delta.canonicalRoot,
    worktree_head: delta.worktreeHead,
    canonical_head: delta.canonicalHead,
    total: worktreeDeltaSize(delta),
    modified: cut(delta.modified),
    deleted: cut(delta.deleted),
    untracked: cut(delta.untracked),
    truncated,
    served_from: servedFrom,
    ...(branchIndex ? { branch_index: branchIndex } : {}),
    note:
      servedFrom === 'branch_index'
        ? 'This session is served from a branch index: a copy of the canonical checkout index with ' +
          'the files listed here re-indexed from this worktree, so results describe the branch. A ' +
          'file whose latest edit has not been re-indexed yet is flagged stale_on_branch.'
        : 'This session is served from the canonical checkout index. Files listed here differ on this ' +
          'worktree: index results for them describe the canonical version (flagged stale_on_branch), ' +
          'and untracked files are not indexed at all. Read these files from disk.',
  };
}
