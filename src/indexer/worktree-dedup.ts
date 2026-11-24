/**
 * Linked worktrees nested inside an indexed root (umbrella layouts: a folder
 * of repos where agents `git worktree add` task branches next to the main
 * checkout).
 *
 * Every such worktree is another checkout of a repo the same index already
 * holds. Walking each one in full indexed most files once per checkout: on two
 * real umbrellas, 274k and 176k files across checkouts held only 25k and 22k
 * distinct (path, content) pairs, the walk hit `security.max_files`, and every
 * symbol came back once per branch. Excluding worktrees outright is wrong the
 * other way: the branch's own work — the code an agent is writing right now —
 * would vanish from the index.
 *
 * So content decides. Within one repo (main checkout + its worktrees), a
 * worktree file is indexed when it is changed in that worktree (staged,
 * unstaged or untracked — `git status`) or when its committed content is not
 * already indexed for the same repo-relative path, by the main checkout or by
 * an earlier worktree. Committed content is compared by git blob id
 * (`git ls-files -s`), so planning reads git's index, never the files.
 *
 * Only worktrees whose main checkout this root indexes itself are planned; any
 * other worktree has no indexed twin and is walked in full, as before. A
 * worktree git cannot describe is also walked in full.
 *
 * ponytail: a file that becomes identical to an indexed twin (reverted, branch
 * merged) keeps its row until the next full reindex prunes it — the
 * incremental gate decides what to (re)index, it never deletes.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { descendantExcludeGlobs, nestedWorktreeRoots } from '../registry.js';
import { safeGitEnv } from '../utils/git-env.js';
import { findLinkedWorktree } from '../worktree-delta.js';

export interface NestedWorktree {
  /** Worktree directory relative to the indexed root, posix separators. */
  rel: string;
  /** Absolute worktree root. */
  root: string;
  /** Absolute (real) root of the main checkout it belongs to. */
  mainRoot: string;
}

/** Per worktree: repo-relative paths to index, or null to walk it in full. */
export type WorktreePlan = Map<NestedWorktree, Set<string> | null>;

const GIT_CONCURRENCY = 8;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const PLAN_TTL_MS = 60_000;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd,
        encoding: 'utf-8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: safeGitEnv(),
      },
      (err, out) => resolve(err ? null : String(out)),
    );
  });
}

/** `git ls-files -s -z`: tracked path -> blob id (stage 0 entries). */
async function trackedBlobs(cwd: string): Promise<Map<string, string> | null> {
  const out = await git(cwd, ['ls-files', '-s', '-z']);
  if (out === null) return null;
  const map = new Map<string, string>();
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, blob, stage] = entry.slice(0, tab).split(' ');
    if (stage === '0') map.set(entry.slice(tab + 1), blob);
  }
  return map;
}

/** Paths changed in the working copy: staged, unstaged, untracked (renames: both sides). */
async function changedPaths(cwd: string, only?: string[]): Promise<Set<string> | null> {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'];
  const out = await git(cwd, only ? [...args, '--', ...only] : args);
  if (out === null) return null;
  const set = new Set<string>();
  for (const entry of out.split('\0')) if (entry.length > 3) set.add(entry.slice(3));
  return set;
}

async function mapLimited<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(GIT_CONCURRENCY, items.length) }, worker));
  return out;
}

/** Nested linked worktrees whose main checkout is indexed by `rootPath` itself. */
export function dedupableWorktrees(rootPath: string): NestedWorktree[] {
  const absRoot = path.resolve(rootPath);
  const realRoot = realpathSafe(absRoot);
  const descendantGlobs = descendantExcludeGlobs(absRoot);
  const ownedByDescendant = descendantGlobs.length
    ? picomatch(descendantGlobs, { dot: true })
    : () => false;
  const out: NestedWorktree[] = [];
  for (const wt of nestedWorktreeRoots(absRoot)) {
    const found = findLinkedWorktree(wt);
    if (!found) continue;
    const mainRel = path.relative(realRoot, found.mainRoot);
    if (mainRel === '' || mainRel.startsWith('..') || path.isAbsolute(mainRel)) continue;
    if (ownedByDescendant(`${toPosix(mainRel)}/x`)) continue;
    out.push({ rel: toPosix(path.relative(absRoot, wt)), root: wt, mainRoot: found.mainRoot });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Compute which files each nested worktree must contribute (see module doc). */
export async function computeWorktreePlan(rootPath: string): Promise<WorktreePlan> {
  const worktrees = dedupableWorktrees(rootPath);
  const plan: WorktreePlan = new Map();
  if (worktrees.length === 0) return plan;
  const mains = [...new Set(worktrees.map((w) => w.mainRoot))];
  const checkouts = [...mains, ...worktrees.map((w) => w.root)];
  const facts = await mapLimited(checkouts, async (c) => {
    const [tracked, changed] = await Promise.all([trackedBlobs(c), changedPaths(c)]);
    return tracked && changed ? { tracked, changed } : null;
  });
  const factsOf = new Map(checkouts.map((c, i) => [c, facts[i]]));

  for (const main of mains) {
    // "Already indexed" = what the main checkout's rows hold: its committed
    // blobs, minus paths it has changed (those rows hold working-tree content).
    const mainFacts = factsOf.get(main);
    const seen = new Set<string>();
    if (mainFacts) {
      for (const [p, blob] of mainFacts.tracked)
        if (!mainFacts.changed.has(p)) seen.add(`${blob}\0${p}`);
    }
    for (const w of worktrees) {
      if (w.mainRoot !== main) continue;
      const f = factsOf.get(w.root);
      if (!mainFacts || !f) {
        plan.set(w, null);
        continue;
      }
      const keep = new Set(f.changed);
      for (const [p, blob] of f.tracked) {
        if (keep.has(p)) continue;
        const key = `${blob}\0${p}`;
        if (!seen.has(key)) {
          keep.add(p);
          seen.add(key);
        }
      }
      plan.set(w, keep);
    }
  }
  return plan;
}

const planCache = new Map<string, { at: number; plan: Promise<WorktreePlan> }>();

/** Cached {@link computeWorktreePlan}; `fresh` forces a recompute. */
export function getWorktreePlan(rootPath: string, fresh = false): Promise<WorktreePlan> {
  const key = path.resolve(rootPath);
  const hit = planCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan;
  const plan = computeWorktreePlan(key);
  planCache.set(key, { at: Date.now(), plan });
  return plan;
}

/** Test hook. */
export function _resetWorktreePlanCache(): void {
  planCache.clear();
}

/**
 * Incremental gate: drop paths inside a planned worktree that an indexed twin
 * already covers. Each touched worktree's `git status` is read fresh — the
 * batch is an edit report, and a just-edited file is exactly what must pass.
 * A clean file the plan does not list (a checkout/pull moved the branch since
 * the plan was cached) triggers one fresh plan before it is judged. Paths that
 * no longer exist pass through so the pipeline can remove their rows.
 */
export async function dropWorktreeDuplicates(
  rootPath: string,
  relPaths: string[],
): Promise<string[]> {
  if (dedupableWorktrees(rootPath).length === 0) return relPaths;
  const absRoot = path.resolve(rootPath);
  let plan = await getWorktreePlan(rootPath);
  const ownerOf = (p: string) => {
    for (const w of plan.keys()) if (p.startsWith(`${w.rel}/`)) return w;
    return undefined;
  };
  const byWorktree = new Map<NestedWorktree, string[]>();
  for (const p of relPaths) {
    const w = ownerOf(p);
    if (w) byWorktree.set(w, [...(byWorktree.get(w) ?? []), p.slice(w.rel.length + 1)]);
  }
  if (byWorktree.size === 0) return relPaths;

  const touched = [...byWorktree.keys()];
  const changed = await mapLimited(touched, (w) => changedPaths(w.root, byWorktree.get(w)));
  const changedOf = new Map(touched.map((w, i) => [w, changed[i]]));
  const covered = (w: NestedWorktree, sub: string) => {
    const keep = plan.get(w);
    return !keep || keep.has(sub) || !!changedOf.get(w)?.has(sub) || changedOf.get(w) === null;
  };
  const exists = (p: string) => fs.existsSync(path.join(absRoot, p));

  const stale = relPaths.some((p) => {
    const w = ownerOf(p);
    return !!w && exists(p) && !covered(w, p.slice(w.rel.length + 1));
  });
  if (stale) {
    const freshPlan = await getWorktreePlan(rootPath, true);
    // Re-key by rel: a fresh plan holds new NestedWorktree objects.
    const byRel = new Map([...freshPlan].map(([w, keep]) => [w.rel, keep]));
    plan = new Map(touched.map((w) => [w, byRel.has(w.rel) ? (byRel.get(w.rel) ?? null) : null]));
  }
  return relPaths.filter((p) => {
    const w = ownerOf(p) ?? touched.find((t) => p.startsWith(`${t.rel}/`));
    if (!w) return true;
    return covered(w, p.slice(w.rel.length + 1)) || !exists(p);
  });
}
