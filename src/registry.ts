/**
 * Global project registry — tracks all projects registered with trace-mcp.
 * Stored at ~/.trace-mcp/registry.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REGISTRY_PATH, ensureGlobalDirs, getDbPath, projectName } from './global.js';

interface RegistryEntry {
  name: string;
  root: string;
  dbPath: string;
  lastIndexed: string | null;
  addedAt: string;
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

export function registerProject(root: string): RegistryEntry {
  const absRoot = path.resolve(root);
  const reg = loadRegistry();

  if (reg.projects[absRoot]) {
    return reg.projects[absRoot];
  }

  const entry: RegistryEntry = {
    name: projectName(absRoot),
    root: absRoot,
    dbPath: getDbPath(absRoot),
    lastIndexed: null,
    addedAt: new Date().toISOString(),
  };

  reg.projects[absRoot] = entry;
  saveRegistry(reg);
  return entry;
}

function unregisterProject(root: string): void {
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
