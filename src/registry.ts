/**
 * Global project registry — tracks all projects registered with trace-mcp.
 * Stored at ~/.trace-mcp/registry.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REGISTRY_PATH, ensureGlobalDirs, getDbPath, projectName } from './global.js';

export interface RegistryEntry {
  name: string;
  root: string;
  dbPath: string;
  lastIndexed: string | null;
  addedAt: string;
  type?: 'single' | 'multi-root';
  children?: string[];
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

/** Atomic write: tmp file + rename to avoid partial reads. */
function saveRegistry(reg: Registry): void {
  ensureGlobalDirs();
  const tmp = REGISTRY_PATH + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, REGISTRY_PATH);
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

export function listProjects(): RegistryEntry[] {
  const reg = loadRegistry();
  return Object.values(reg.projects);
}

/** Remove entries whose root directory no longer exists. Returns removed paths. */
function pruneStaleProjects(): string[] {
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

export function updateLastIndexed(root: string): void {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();
  if (reg.projects[absRoot]) {
    reg.projects[absRoot].lastIndexed = new Date().toISOString();
    saveRegistry(reg);
  }
}
