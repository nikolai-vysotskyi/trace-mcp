/**
 * Shared project registration logic.
 *
 * Every path that registers a project (CLI add, CLI init, daemon addProject,
 * MCP auto-register) MUST go through `setupProject` to guarantee consistent
 * behavior: detect → generate config → save config → create DB → register.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProjectConfig } from './config.js';
import { initializeDatabase } from './db/schema.js';
import { ensureGlobalDirs, getDbPath } from './global.js';
import { generateConfig } from './init/config-generator.js';
import type { DetectionResult } from './init/detector.js';
import { detectProject } from './init/detector.js';
import type { RegistryEntry } from './registry.js';
import { getProject, registerProject } from './registry.js';

export interface ProjectSetupResult {
  entry: RegistryEntry;
  detection: DetectionResult;
  dbPath: string;
  migrated: boolean;
  isNew: boolean;
}

/**
 * Reject obviously-wrong project roots: filesystem root, user home, top-level
 * system directories. An MCP client spawned with cwd=/ would otherwise cause
 * trace-mcp to index the entire filesystem and crash on SIP-protected paths
 * like /Library/Bluetooth.
 *
 * Returns null if the path is acceptable, or a human-readable reason if it
 * should be rejected.
 */
export function isDangerousProjectRoot(absRoot: string): string | null {
  const parsed = path.parse(absRoot);

  // Filesystem root: "/" on POSIX, "C:\" on Windows
  if (absRoot === parsed.root) return 'filesystem root';

  // User home directory
  if (absRoot === os.homedir()) return 'home directory';

  // Top-level system/user-container directories (POSIX + macOS)
  const SYSTEM_DIRS = new Set([
    '/Users',
    '/home',
    '/root',
    '/System',
    '/Library',
    '/private',
    '/tmp',
    '/var',
    '/etc',
    '/bin',
    '/sbin',
    '/usr',
    '/opt',
    '/dev',
    '/Volumes',
    '/Applications',
    '/Network',
    '/cores',
    '/proc',
    '/sys',
  ]);
  if (SYSTEM_DIRS.has(absRoot)) return 'system directory';

  return null;
}

/**
 * Standard project registration pipeline:
 * 1. Detect frameworks, languages, package managers
 * 2. Generate & save per-project config
 * 3. Migrate old local DB (if migrateOldDb is set)
 * 4. Initialize database at global path
 * 5. Register in global registry
 *
 * Idempotent when `force` is false — returns existing entry if already registered.
 */
export function setupProject(
  projectRoot: string,
  opts?: { force?: boolean; migrateOldDb?: boolean },
): ProjectSetupResult {
  const absRoot = path.resolve(projectRoot);

  const dangerReason = isDangerousProjectRoot(absRoot);
  if (dangerReason) {
    throw new Error(
      `Refusing to register "${absRoot}" as a trace-mcp project: ${dangerReason}. ` +
        `Projects must point to a specific source directory, not a system or root path. ` +
        `This usually means an MCP client spawned trace-mcp with an unexpected working directory — ` +
        `configure a "cwd" on the MCP server entry or run trace-mcp from inside your project folder.`,
    );
  }

  const existing = getProject(absRoot);
  if (existing && !opts?.force) {
    return {
      entry: existing,
      detection: { languages: [], frameworks: [], packageManagers: [], rootMarkers: [] },
      dbPath: existing.dbPath,
      migrated: false,
      isNew: false,
    };
  }

  // 1. Detect project
  const detection = detectProject(absRoot);

  // 2. Generate & save config
  const config = generateConfig(detection);
  saveProjectConfig(absRoot, {
    root: config.root,
    include: config.include,
    exclude: config.exclude,
  });

  // 3. Ensure global dirs & DB path
  ensureGlobalDirs();
  const dbPath = getDbPath(absRoot);

  // 4. Migrate old local DB if requested
  let migrated = false;
  if (opts?.migrateOldDb) {
    const oldDbPath = path.join(absRoot, '.trace-mcp', 'index.db');
    if (fs.existsSync(oldDbPath) && !fs.existsSync(dbPath)) {
      fs.copyFileSync(oldDbPath, dbPath);
      migrated = true;
    }
  }

  // 5. Initialize database
  const db = initializeDatabase(dbPath);
  db.close();

  // 6. Register in global registry
  const entry = registerProject(absRoot);

  return { entry, detection, dbPath, migrated, isNew: !existing };
}
