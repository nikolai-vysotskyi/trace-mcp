/**
 * Shared project registration logic.
 *
 * Every path that registers a project (CLI add, CLI init, daemon addProject,
 * MCP auto-register) MUST go through `setupProject` to guarantee consistent
 * behavior: detect → generate config → save config → create DB → register.
 */

import fs from 'node:fs';
import path from 'node:path';
import { detectProject } from './init/detector.js';
import type { DetectionResult } from './init/detector.js';
import { generateConfig } from './init/config-generator.js';
import { saveProjectConfig } from './config.js';
import { registerProject, getProject } from './registry.js';
import type { RegistryEntry } from './registry.js';
import { ensureGlobalDirs, getDbPath } from './global.js';
import { initializeDatabase } from './db/schema.js';

export interface ProjectSetupResult {
  entry: RegistryEntry;
  detection: DetectionResult;
  dbPath: string;
  migrated: boolean;
  isNew: boolean;
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

  const existing = getProject(absRoot);
  if (existing && !opts?.force) {
    return { entry: existing, detection: { languages: [], frameworks: [], packageManagers: [], rootMarkers: [] }, dbPath: existing.dbPath, migrated: false, isNew: false };
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
