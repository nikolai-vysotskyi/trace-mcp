/**
 * Global project registry — tracks all projects registered with trace-mcp.
 * Stored at ~/.trace-mcp/registry.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureGlobalDirs, getDbPath, projectName, REGISTRY_PATH } from './global.js';
import { atomicWriteJson } from './utils/atomic-write.js';

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
}

interface Registry {
  version: 1;
  projects: Record<string, RegistryEntry>;
}

function emptyRegistry(): Registry {
  return { version: 1, projects: {} };
}

function loadRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) return emptyRegistry();
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    if (raw.version === 1 && raw.projects) return raw as Registry;
    return emptyRegistry();
  } catch {
    return emptyRegistry();
  }
}

function saveRegistry(reg: Registry): void {
  ensureGlobalDirs();
  atomicWriteJson(REGISTRY_PATH, reg);
}

export function registerProject(
  root: string,
  opts?: { type?: 'single' | 'multi-root'; children?: string[] },
): RegistryEntry {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();

  if (reg.projects[absRoot] && !opts) {
    return reg.projects[absRoot];
  }

  const entry: RegistryEntry = {
    name: projectName(absRoot),
    root: absRoot,
    dbPath: getDbPath(absRoot),
    lastIndexed: null,
    addedAt: new Date().toISOString(),
    ...(opts?.type && { type: opts.type }),
    ...(opts?.children && { children: opts.children }),
  };

  reg.projects[absRoot] = entry;
  saveRegistry(reg);
  return entry;
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

export function listProjects(): RegistryEntry[] {
  const reg = loadRegistry();
  return Object.values(reg.projects);
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
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { exists: false, corrupt: false, entries: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
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
      count++;
    }
  }
  if (count > 0) saveRegistry(reg);
  return count;
}

/** Clear the pending-reindex flag for one project after a successful reindex. */
export function clearPendingReindex(root: string): void {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();
  const entry = reg.projects[absRoot];
  if (entry && entry.pendingReindexForVersion !== undefined) {
    delete entry.pendingReindexForVersion;
    saveRegistry(reg);
  }
}
