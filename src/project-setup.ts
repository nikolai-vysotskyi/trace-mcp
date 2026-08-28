/**
 * Shared project registration logic.
 *
 * Every path that registers a project (CLI add, CLI init, daemon addProject,
 * MCP auto-register) MUST go through `setupProject` to guarantee consistent
 * behavior: detect → generate config → save config → create DB → register.
 */

import fs from 'node:fs';
import path from 'node:path';
import { saveProjectConfig } from './config.js';
import { initializeDatabase } from './db/schema.js';
import { ensureGlobalDirs, getDbPath } from './global.js';
import { generateConfig } from './init/config-generator.js';
import type { DetectionResult } from './init/types.js';
import { detectProject } from './init/detector.js';
import { logger } from './logger.js';
import type { NewRootOverlap, RegistryEntry } from './registry.js';
import { findOverlapForNewRoot, getProject, registerProject } from './registry.js';
import { isDangerousProjectRoot } from './dangerous-root.js';

// Re-exported so the many existing `from './project-setup.js'` importers keep working.
export { isDangerousProjectRoot };

export interface ProjectSetupResult {
  entry: RegistryEntry;
  detection: DetectionResult;
  dbPath: string;
  migrated: boolean;
  isNew: boolean;
  /**
   * Set when this root overlaps an already-registered project (ancestor or
   * descendant, excluding declared multi-root children). Registering nested
   * repos separately is supported (the ancestor's watcher/index excludes the
   * descendant — see #209), but the overlap is worth surfacing to whoever
   * called `setupProject` since it's easy to form by accident.
   */
  overlapWarning?: NewRootOverlap;
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
 * Also checks for ancestor/descendant overlap with an already-registered
 * project (see `findOverlapForNewRoot`) and logs a warning plus returns it as
 * `overlapWarning` — registration still proceeds, since a nested repo
 * registered on its own is a supported pattern, not necessarily a mistake.
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
      detection: {
        projectRoot: absRoot,
        languages: [],
        frameworks: [],
        packageManagers: [],
        mcpClients: [],
        existingConfig: null,
        existingDb: null,
        hasClaudeMd: false,
        claudeMdHasTraceMcpBlock: false,
        hasGuardHook: false,
        guardHookVersion: null,
      },
      dbPath: existing.dbPath,
      migrated: false,
      isNew: false,
    };
  }

  // Prevention gap (TRA-95): findOverlapForNewRoot() existed with full test
  // coverage but nothing ever called it before writing a new registry entry,
  // so overlapping registrations kept forming with zero signal until someone
  // ran `doctor`. Check here, the one choke point every registration path
  // goes through, and surface it — but don't block: a nested repo registered
  // on its own is a supported pattern (the ancestor's watcher/index excludes
  // it, see #209 / project-manager-ancestor-watcher.test.ts), so refusing
  // outright would break that flow.
  const overlap = findOverlapForNewRoot(absRoot);
  if (overlap) {
    const { existing, relation } = overlap;
    const detail =
      relation === 'existing_contains_candidate'
        ? `nested inside the already-registered project "${existing.root}"`
        : `would contain the already-registered project "${existing.root}"`;
    logger.warn(
      { candidateRoot: absRoot, existingRoot: existing.root, relation },
      `Registering "${absRoot}": ${detail}. If unintentional, this double-indexes shared files; ` +
        `run \`trace-mcp doctor\` to review, or register "${existing.root}" as a multi-root ` +
        `project with "${absRoot}" listed as a child.`,
    );
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

  // 4. Migrate old local DB if requested. We treat an EMPTY (0-byte) local
  // .trace-mcp/index.db as cruft from a previous run, not as a real migration
  // candidate — older versions created the empty file on init even when the
  // daemon was the real index home. Such 0-byte files persist forever and
  // confuse users into thinking the local index is broken. Drop them.
  let migrated = false;
  const oldDbPath = path.join(absRoot, '.trace-mcp', 'index.db');
  if (fs.existsSync(oldDbPath)) {
    try {
      const size = fs.statSync(oldDbPath).size;
      if (size === 0) {
        // Best-effort cleanup; ignore failures (read-only FS, permissions, etc.)
        try {
          fs.unlinkSync(oldDbPath);
        } catch {
          /* leave the stray file rather than crashing setup */
        }
      } else if (opts?.migrateOldDb && !fs.existsSync(dbPath)) {
        fs.copyFileSync(oldDbPath, dbPath);
        migrated = true;
      }
    } catch {
      /* unreadable — don't block setup */
    }
  }

  // 5. Initialize database
  const db = initializeDatabase(dbPath);
  db.close();

  // 6. Register in global registry
  const entry = registerProject(absRoot);

  return {
    entry,
    detection,
    dbPath,
    migrated,
    isNew: !existing,
    overlapWarning: overlap ?? undefined,
  };
}
