/**
 * Global project registry — tracks all projects registered with trace-mcp.
 * Stored at ~/.trace-mcp/registry.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ensureGlobalDirs,
  getDbPath,
  getProjectRemoteIdentity,
  projectName,
  REGISTRY_PATH,
} from './global.js';
import { announceDbHolder, hasLiveHolder, releaseDbHolder } from './db-holders.js';
import { atomicWriteJson } from './utils/atomic-write.js';
import { readIfExists } from './utils/safe-fs.js';

export interface RegistryEntry {
  name: string;
  root: string;
  dbPath: string;
  lastIndexed: string | null;
  addedAt: string;
  type?: 'single' | 'multi-root';
  children?: string[];
  /**
   * Stamped by post-update migrations when the bundled trace-mcp version
   * changes. The next time this project is opened by the daemon (ProjectManager.addProject)
   * a lazy background reindex runs and the flag is cleared. Decouples
   * "version bump" from "reindex storm" so a slow startup can't drive
   * the desktop app's /health watchdog into a restart loop. See updater.ts.
   */
  pendingReindexForVersion?: string;
  /**
   * How many times a daemon has *started* the forced rebuild for
   * {@link pendingReindexForVersion} without finishing it. Bounded by
   * {@link MAX_PENDING_REINDEX_ATTEMPTS} so a daemon that keeps getting
   * restarted mid-rebuild eventually gives up instead of force-rebuilding
   * every project on every boot forever (TRA-274).
   */
  pendingReindexAttempts?: number;
  /**
   * ISO timestamp of the first time this root was observed missing. Set by
   * {@link sweepMissingRoots}, cleared the moment the root reappears (e.g. an
   * unmounted drive). Lets the automatic startup sweep wait out a grace period
   * before deleting, instead of `pruneStaleProjects`'s immediate removal (fine
   * for that path since it only runs on explicit `doctor --fix`/`prune --apply`).
   */
  missingRootSince?: string;
  /**
   * Normalized git remote identity (`host/org/repo`) resolved at
   * registration time, e.g. `github.com/nikolai-vysotskyi/trace-mcp` — see
   * `getProjectRemoteIdentity` in global.ts. Absent for non-git projects or
   * a git repo with no remote configured. Cached here (rather than
   * re-reading `.git/config` on every lookup) so a later registration of
   * *another* checkout of the same repo can find this entry even if this
   * entry's own `root` directory has since been deleted (e.g. a cleaned-up
   * Multica ephemeral checkout) — see `findRegisteredEntryByRemote` (TRA-38).
   */
  remoteIdentity?: string;
}

interface Registry {
  version: 1;
  projects: Record<string, RegistryEntry>;
}

function emptyRegistry(): Registry {
  return { version: 1, projects: {} };
}

// mtime-keyed cache of the parsed registry. Every exported reader (getProject,
// resolveRegisteredAncestor, listProjects, ...) calls loadRegistry, and the
// per-/mcp-request resolveDeepestKnownRoot path hits it on every tool call —
// previously re-reading + JSON.parsing the whole registry.json each time. We
// keep the parsed object and hand callers a structuredClone so they can mutate
// their copy freely (registerProject etc. mutate then saveRegistry) without
// corrupting the cache.
// ponytail: mtime is the cross-process invalidation signal (another daemon/CLI
// writing the file bumps it); within-process writes drop the cache explicitly
// in saveRegistry. mtime alone is not enough: filesystem timestamp granularity
// is coarse (~15ms on Windows), so two writes can share one mtime and hide the
// second (TRA-326). Size is a cheap second signal, and any file younger than
// one granularity tick is never trusted from cache at all.
const MTIME_GRANULARITY_MS = 50;
let _registryCache: { mtimeMs: number; size: number; reg: Registry } | null = null;

/** Keys that would reach `Object.prototype` if used as a `projects` map key. */
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

function loadRegistry(): Registry {
  // Stat and read through one descriptor: the metadata we key the cache on then
  // describes exactly the bytes we parsed, even if the file is replaced midway.
  let fd: number;
  try {
    fd = fs.openSync(REGISTRY_PATH, 'r');
  } catch {
    return emptyRegistry(); // no registry file yet
  }
  try {
    const { mtimeMs, size } = fs.fstatSync(fd);
    const settled = Date.now() - mtimeMs >= MTIME_GRANULARITY_MS;
    if (settled && _registryCache?.mtimeMs === mtimeMs && _registryCache.size === size) {
      return structuredClone(_registryCache.reg);
    }
    const raw = JSON.parse(fs.readFileSync(fd, 'utf-8'));
    if (raw.version === 1 && raw.projects) {
      // Registry keys are always `path.resolve()` output, so a bare `__proto__`
      // can never be written by us — but the file is hand-editable and the
      // daemon holds this map for its whole life, so drop the dangerous keys
      // on read rather than trusting the writer (CodeQL js/prototype-polluting-assignment).
      for (const key of DANGEROUS_KEYS) delete raw.projects[key];
      _registryCache = { mtimeMs, size, reg: raw as Registry };
      return structuredClone(raw as Registry);
    }
    return emptyRegistry();
  } catch {
    return emptyRegistry();
  } finally {
    fs.closeSync(fd);
  }
}

function saveRegistry(reg: Registry): void {
  ensureGlobalDirs();
  atomicWriteJson(REGISTRY_PATH, reg);
  _registryCache = null; // force reload on next read (new mtime + fresh object)
}

/**
 * Try to take a share of a sibling's index DB for `absRoot` (TRA-304).
 *
 * Announces our holder first, then scans; returns false — and gives the claim
 * back — as soon as any other root turns out to be holding that DB. Any fs
 * error is also a false: fail toward isolation, never toward silent sharing.
 */
function claimSharedDb(siblingDbPath: string, absRoot: string): boolean {
  try {
    announceDbHolder(siblingDbPath, absRoot);
    if (!hasLiveHolder(siblingDbPath, absRoot)) return true;
  } catch {
    /* unreadable/unwritable holder dir — treat as "a sibling is live" */
  }
  releaseDbHolder(siblingDbPath, absRoot);
  return false;
}

export function registerProject(
  root: string,
  opts?: { type?: 'single' | 'multi-root'; children?: string[] },
): RegistryEntry {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();

  if (reg.projects[absRoot] && !opts) {
    // Already registered: the dbPath decision was made on a previous run, but
    // this process is about to open that DB, so re-announce the holder (TRA-304)
    // — that is what stops a *sibling* checkout from sharing it while we're up.
    try {
      announceDbHolder(reg.projects[absRoot].dbPath, absRoot);
    } catch {
      /* best effort — an unannounced holder only costs isolation, not safety */
    }
    return reg.projects[absRoot];
  }

  // TRA-38: a fresh checkout of a repo that's already registered somewhere
  // else (e.g. Multica's `repo checkout` landing the same repo under a new
  // per-run ephemeral directory every time) should reuse that project's
  // existing index instead of building a brand-new one from scratch. Detect
  // this by normalized git remote identity, not by path. Repos with no
  // resolvable remote (non-git projects, or a repo with no `origin`
  // configured) fall through to the exact same path-based `dbPath` this
  // function has always computed — zero behavior change for them.
  const remoteIdentity = getProjectRemoteIdentity(absRoot);
  const sibling = remoteIdentity ? findRegisteredEntryByRemote(remoteIdentity, absRoot) : null;
  // TRA-304: that sharing is only safe when the checkouts are used
  // *sequentially*. Announce ourselves under the sibling's DB first, then look
  // for a holder from a different root — announce-then-scan makes a symmetric
  // race (two checkouts registering at the same moment) resolve toward
  // isolation, which is the safe direction to fail.
  //
  // Note the decision is sticky: `dbPath` is persisted here and never
  // re-evaluated per query, so "a sibling was live when we registered" is a
  // proxy for "concurrent", not a guarantee. It is a good proxy only because
  // registration happens at run start; don't read it as airtight.
  const shareWithSibling = sibling ? claimSharedDb(sibling.dbPath, absRoot) : false;
  const dbPath = shareWithSibling ? sibling!.dbPath : getDbPath(absRoot);
  try {
    if (!shareWithSibling) announceDbHolder(dbPath, absRoot);
  } catch {
    /* our own DB, nobody else to confuse — proceed unannounced */
  }

  const entry: RegistryEntry = {
    name: projectName(absRoot),
    root: absRoot,
    dbPath,
    // Inherit the sibling's lastIndexed so tooling doesn't present a project
    // whose DB already has data as "never indexed" just because this
    // particular root is a new registry row.
    lastIndexed: shareWithSibling ? (sibling?.lastIndexed ?? null) : null,
    addedAt: new Date().toISOString(),
    ...(remoteIdentity && { remoteIdentity }),
    ...(opts?.type && { type: opts.type }),
    ...(opts?.children && { children: opts.children }),
  };

  reg.projects[absRoot] = entry;
  saveRegistry(reg);
  return entry;
}

/**
 * Find an already-registered project (other than `excludeRoot`) whose git
 * remote identity matches `remoteIdentity`. Used by `registerProject` to
 * detect "this is another checkout of a repo we already know about" so the
 * new registration can reuse the existing entry's `dbPath` instead of
 * spawning a duplicate index (TRA-38).
 *
 * Falls back to computing `remoteIdentity` on the fly for entries registered
 * before this field existed (`entry.remoteIdentity` absent) — a live re-read
 * of that entry's `.git/config`, which is a no-op (returns null, no match)
 * if the entry's root no longer exists on disk. No persisted index is
 * needed: registries are small (tens to low hundreds of entries) and this
 * only runs once per *new* registration, mirroring the existing live-scan
 * style of `findOverlappingProjects` / `findOverlapForNewRoot` in this file.
 */
export function findRegisteredEntryByRemote(
  remoteIdentity: string,
  excludeRoot?: string,
): RegistryEntry | null {
  const absExclude = excludeRoot ? path.resolve(excludeRoot) : null;
  for (const entry of listProjects()) {
    if (absExclude && entry.root === absExclude) continue;
    const entryIdentity = entry.remoteIdentity ?? getProjectRemoteIdentity(entry.root);
    if (entryIdentity === remoteIdentity) return entry;
  }
  return null;
}

/** Find a multi-root project that contains this child root. */
export function findParentProject(childRoot: string): RegistryEntry | null {
  const absChild = path.resolve(childRoot);
  const reg = loadRegistry();
  for (const entry of Object.values(reg.projects)) {
    if (entry.type === 'multi-root' && entry.children?.includes(absChild)) {
      return entry;
    }
  }
  return null;
}

/**
 * Walk up from `requestedRoot` and return the closest already-registered project.
 * Matches `requestedRoot` itself, any registered ancestor, or a `multi-root` parent
 * that lists `requestedRoot` (or an ancestor of it) as a child. Returns null if no
 * registered project covers this path.
 *
 * Used to route subdirectory requests (e.g. `repo/packages/app`) to the parent
 * project's index instead of registering a duplicate per nested package.
 */
export function resolveRegisteredAncestor(requestedRoot: string): RegistryEntry | null {
  const absRequested = path.resolve(requestedRoot);
  const reg = loadRegistry();

  const childToParent = new Map<string, RegistryEntry>();
  for (const entry of Object.values(reg.projects)) {
    if (entry.type === 'multi-root' && entry.children) {
      for (const child of entry.children) childToParent.set(child, entry);
    }
  }

  let dir = absRequested;
  while (true) {
    const direct = reg.projects[dir];
    if (direct) return direct;
    const viaMultiRoot = childToParent.get(dir);
    if (viaMultiRoot) return viaMultiRoot;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function unregisterProject(root: string): void {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();
  delete reg.projects[absRoot];
  saveRegistry(reg);
}

export function getProject(root: string): RegistryEntry | null {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();
  return reg.projects[absRoot] ?? null;
}

export interface RegistryOverlap {
  ancestor: RegistryEntry;
  descendant: RegistryEntry;
}

/**
 * Find registered project pairs where one root is an ancestor directory of
 * another (e.g. a container folder like `~/Projects` registered alongside
 * `~/Projects/my-app`). Each such pair means the same files are indexed into
 * two separate DBs and watched by two watchers — every change costs double
 * CPU, and watcher-driven reindexes multiply across daemon + stdio sessions.
 * Declared `multi-root` children are intentional and NOT reported.
 */
export function findOverlappingProjects(): RegistryOverlap[] {
  const entries = listProjects();
  const overlaps: RegistryOverlap[] = [];
  for (const ancestor of entries) {
    for (const descendant of entries) {
      if (ancestor.root === descendant.root) continue;
      const rel = path.relative(ancestor.root, descendant.root);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (ancestor.type === 'multi-root' && ancestor.children?.includes(descendant.root)) continue;
      overlaps.push({ ancestor, descendant });
    }
  }
  return overlaps;
}

export interface NewRootOverlap {
  /** The already-registered project this candidate root would overlap with. */
  existing: RegistryEntry;
  /** Whether `existing` would become the container (ancestor) of the candidate, or land inside it. */
  relation: 'existing_contains_candidate' | 'candidate_contains_existing';
}

/**
 * Check whether registering `candidateRoot` would create a new container/nested
 * overlap (see findOverlappingProjects) with an already-registered project.
 * Lets `add` warn/block *before* creating a new overlap instead of only
 * surfacing it after the fact via `doctor`. Declared multi-root parent/child
 * pairs are intentional and not reported.
 */
export function findOverlapForNewRoot(candidateRoot: string): NewRootOverlap | null {
  const absCandidate = path.resolve(candidateRoot);
  for (const entry of listProjects()) {
    if (entry.root === absCandidate) continue;
    if (entry.type === 'multi-root' && entry.children?.includes(absCandidate)) continue;

    const relFromEntry = path.relative(entry.root, absCandidate);
    if (relFromEntry !== '' && !relFromEntry.startsWith('..') && !path.isAbsolute(relFromEntry)) {
      return { existing: entry, relation: 'existing_contains_candidate' };
    }
    const relToEntry = path.relative(absCandidate, entry.root);
    if (relToEntry !== '' && !relToEntry.startsWith('..') && !path.isAbsolute(relToEntry)) {
      return { existing: entry, relation: 'candidate_contains_existing' };
    }
  }
  return null;
}

export function listProjects(): RegistryEntry[] {
  const reg = loadRegistry();
  return Object.values(reg.projects);
}

/**
 * Registered project roots that live strictly inside `root` — accidental
 * "container overlap" projects (a parent folder registered alongside child
 * repos). Declared `multi-root` children of `root` are intentional and excluded,
 * mirroring findOverlappingProjects().
 *
 * Indexing and file-watching use this so the *most-specific* registered project
 * owns a path: an ancestor project skips files that live under a registered
 * descendant instead of indexing them into a second DB and watching them with a
 * second watcher. That double-indexing is the churn + daemon-starvation cause
 * behind #209, and it mirrors resolveRegisteredAncestor(), which already routes
 * subdirectory *requests* to the most-specific project.
 */
export function registeredDescendantRoots(root: string): string[] {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();
  const self = reg.projects[absRoot];
  const declaredChildren = new Set(self?.type === 'multi-root' ? (self.children ?? []) : []);
  return Object.values(reg.projects)
    .map((e) => e.root)
    .filter((r) => {
      if (r === absRoot || declaredChildren.has(r)) return false;
      const rel = path.relative(absRoot, r);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
}

/**
 * fast-glob / parcel-watcher ignore globs (POSIX, relative to `root`) for every
 * registered descendant of `root`. Feed into collectFiles()'s ignore list and
 * the incremental indexFiles() gate so an ancestor never indexes a
 * descendant-owned file. Empty when `root` has no registered descendants.
 */
export function descendantExcludeGlobs(root: string): string[] {
  const absRoot = path.resolve(root);
  return registeredDescendantRoots(absRoot).map(
    (r) => `${path.relative(absRoot, r).split(path.sep).join('/')}/**`,
  );
}

/** Directory names never worth descending into while scanning for nested repos. */
const NESTED_REPO_SCAN_SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
]);

export interface UnregisteredNestedRepo {
  parentName: string;
  parentRoot: string;
  nestedRepoRoot: string;
}

/**
 * Find sibling repos (their own `.git`) living under a registered project's
 * tree that were never registered themselves — the "zero index coverage" gap
 * (TRA-86), distinct from findOverlappingProjects' "both registered, doubly
 * indexed" case. A nested repo in a language/framework the parent's include
 * globs don't reach (e.g. a Vue frontend sibling under a Laravel root) is
 * invisible to search/get_symbol even though its files exist on disk, and
 * nothing else catches it since it was never added to the registry.
 *
 * Bounded to `maxDepth` directories below each registered root — deep enough
 * for the common "workspace/service-a, workspace/service-b" layout without
 * risking a pathological walk on huge trees. Stops descending the moment it
 * finds a `.git`, registered or not, so nested-inside-nested repos are only
 * reported once (at the outermost unregistered boundary).
 */
export function findUnregisteredNestedRepos(maxDepth = 4): UnregisteredNestedRepo[] {
  const parents = listProjects();
  const registeredRoots = new Set(parents.map((e) => e.root));
  const results: UnregisteredNestedRepo[] = [];

  const walk = (dir: string, depth: number, parent: RegistryEntry) => {
    if (depth > maxDepth) return;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (!child.isDirectory() || NESTED_REPO_SCAN_SKIP_DIRS.has(child.name)) continue;
      const childPath = path.join(dir, child.name);
      if (fs.existsSync(path.join(childPath, '.git'))) {
        if (!registeredRoots.has(childPath)) {
          results.push({
            parentName: parent.name,
            parentRoot: parent.root,
            nestedRepoRoot: childPath,
          });
        }
        continue; // boundary reached either way — don't recurse past a repo root
      }
      walk(childPath, depth + 1, parent);
    }
  };

  for (const parent of parents) {
    walk(parent.root, 1, parent);
  }

  return results;
}

/**
 * Path shape Multica's `repo checkout` uses for one-shot agent-run workdirs:
 * `.../multica_workspaces_<host>/<workspace-id>/<run-id>/workdir`. Each task
 * run gets a brand-new directory, so a project matching this shape is queried
 * exactly once, for the lifetime of that single run, and never touched again.
 */
const EPHEMERAL_WORKDIR_PATTERN =
  /[/\\]multica_workspaces[^/\\]*[/\\][^/\\]+[/\\][^/\\]+[/\\]workdir$/i;

export interface EphemeralProjectCandidate {
  name: string;
  root: string;
  addedAt: string;
  ageHours: number;
}

/**
 * Registered projects whose root looks like a one-shot Multica agent-run
 * checkout (TRA-94) and were added more than `minAgeHours` ago. Nothing else
 * ever revisits these — the run that created them finished long ago — but
 * they stay registered forever, permanently reindexed alongside real
 * projects and holding onto their index DB on disk.
 */
export function findEphemeralProjects(minAgeHours = 24): EphemeralProjectCandidate[] {
  const now = Date.now();
  const out: EphemeralProjectCandidate[] = [];
  for (const entry of listProjects()) {
    if (!EPHEMERAL_WORKDIR_PATTERN.test(entry.root)) continue;
    const addedMs = Date.parse(entry.addedAt);
    if (Number.isNaN(addedMs)) continue;
    const ageHours = (now - addedMs) / (60 * 60 * 1000);
    if (ageHours < minAgeHours) continue;
    out.push({ name: entry.name, root: entry.root, addedAt: entry.addedAt, ageHours });
  }
  return out;
}

/** Remove entries whose root directory no longer exists. Returns removed paths. */
export function pruneStaleProjects(): string[] {
  const reg = loadRegistry();
  const removed: string[] = [];

  for (const [root, _entry] of Object.entries(reg.projects)) {
    if (!fs.existsSync(root)) {
      delete reg.projects[root];
      removed.push(root);
    }
  }

  if (removed.length > 0) saveRegistry(reg);
  return removed;
}

const MISSING_ROOT_SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

export interface MissingRootSweepResult {
  /** Roots removed (grace period elapsed) — their DBs were also deleted. */
  removed: string[];
  /** Roots newly observed missing this run (grace period just started). */
  newlyMissing: string[];
}

/**
 * Automatic, unattended counterpart to `pruneStaleProjects` (TRA-36). Runs on
 * daemon startup: a root missing for the first time only gets timestamped, not
 * removed, so a transiently-unmounted drive doesn't lose its registration. Only
 * once a root has stayed missing for `graceDays` does this deregister it AND
 * delete its DB — unlike `pruneStaleProjects`, which only unregisters and is
 * reserved for the explicit, human-reviewed `doctor --fix` / `prune --apply` path.
 */
export function sweepMissingRoots(graceDays = 7): MissingRootSweepResult {
  const reg = loadRegistry();
  const graceMs = graceDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const removed: string[] = [];
  const newlyMissing: string[] = [];
  let changed = false;

  for (const [root, entry] of Object.entries(reg.projects)) {
    if (fs.existsSync(root)) {
      if (entry.missingRootSince) {
        delete entry.missingRootSince;
        changed = true;
      }
      continue;
    }

    if (!entry.missingRootSince) {
      entry.missingRootSince = new Date().toISOString();
      newlyMissing.push(root);
      changed = true;
      continue;
    }

    const missingSinceMs = Date.parse(entry.missingRootSince);
    if (Number.isNaN(missingSinceMs) || now - missingSinceMs < graceMs) continue;

    delete reg.projects[root];
    removed.push(root);
    changed = true;
    for (const suffix of MISSING_ROOT_SIDECARS) {
      try {
        fs.unlinkSync(entry.dbPath + suffix);
      } catch {
        /* missing sidecar or already gone — fine */
      }
    }
  }

  if (changed) saveRegistry(reg);
  return { removed, newlyMissing };
}

export interface RegistryFileInspection {
  /** registry.json is present on disk. */
  exists: boolean;
  /** File exists but is unparseable or has the wrong shape. `loadRegistry`
   *  silently treats this as empty; `doctor` surfaces it so the user knows
   *  their project list was lost rather than never created (#168). */
  corrupt: boolean;
  /** Parsed entries (empty when missing or corrupt). */
  entries: RegistryEntry[];
}

/**
 * Inspect registry.json without the silent corrupt→empty coercion that
 * `loadRegistry` applies. Distinguishes "missing" from "corrupt" so the doctor
 * report can tell the user which one they're looking at.
 */
export function inspectRegistry(): RegistryFileInspection {
  const content = readIfExists(REGISTRY_PATH);
  if (content === null) {
    return { exists: false, corrupt: false, entries: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { exists: true, corrupt: true, entries: [] };
  }
  const reg = raw as Partial<Registry> | null;
  if (!reg || typeof reg !== 'object' || reg.version !== 1 || typeof reg.projects !== 'object') {
    return { exists: true, corrupt: true, entries: [] };
  }
  return {
    exists: true,
    corrupt: false,
    entries: Object.values(reg.projects as Record<string, RegistryEntry>),
  };
}

export function updateLastIndexed(root: string): void {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();
  if (reg.projects[absRoot]) {
    reg.projects[absRoot].lastIndexed = new Date().toISOString();
    saveRegistry(reg);
  }
}

/**
 * Stamp every registered project with `pendingReindexForVersion=version`.
 * Called by post-update migrations to defer the actual reindex to the
 * first ProjectManager.addProject() of each project, so the daemon can
 * become reachable instantly after a version bump.
 */
export function markAllProjectsPendingReindex(version: string): number {
  const reg = loadRegistry();
  let count = 0;
  for (const entry of Object.values(reg.projects)) {
    if (entry.pendingReindexForVersion !== version) {
      entry.pendingReindexForVersion = version;
      delete entry.pendingReindexAttempts;
      count++;
    }
  }
  if (count > 0) saveRegistry(reg);
  return count;
}

/**
 * Give up on the forced post-update rebuild after this many daemon starts that
 * began it but never finished. Beyond the cap the project falls back to the
 * cheap incremental index; a genuinely stale schema is still repaired by the
 * FK-auto-recovery retry in ProjectManager.addProject.
 */
export const MAX_PENDING_REINDEX_ATTEMPTS = 3;

/**
 * Record that a daemon is starting the forced rebuild for this project and
 * return the new attempt count. Persisted BEFORE the rebuild runs so a daemon
 * killed mid-rebuild still burns an attempt — that is what makes the storm
 * terminate (TRA-274).
 */
export function recordPendingReindexAttempt(root: string): number {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();
  const entry = reg.projects[absRoot];
  if (!entry) return 0;
  entry.pendingReindexAttempts = (entry.pendingReindexAttempts ?? 0) + 1;
  saveRegistry(reg);
  return entry.pendingReindexAttempts;
}

/** Clear the pending-reindex flag for one project after a successful reindex. */
export function clearPendingReindex(root: string): void {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();
  const entry = reg.projects[absRoot];
  if (
    entry &&
    (entry.pendingReindexForVersion !== undefined || entry.pendingReindexAttempts !== undefined)
  ) {
    delete entry.pendingReindexForVersion;
    delete entry.pendingReindexAttempts;
    saveRegistry(reg);
  }
}
