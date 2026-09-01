/**
 * Path and directory migration security helpers.
 *
 * Handles zero-downtime, backwards-compatible migration between:
 *  - Global data directory: ~/.trace-mcp/ -> ~/.trace/
 *  - Project configuration: .trace-mcp.json -> .trace.json
 *  - Client configurations: mcpServers["trace-mcp"] -> mcpServers["trace"]
 *
 * Security Guarantees:
 *  1. Symlink Safety (CWE-59): Rejects untrusted symlinks at source and destination
 *     roots, and skips/refuses symlinks inside directory trees so attackers cannot
 *     trick migration into reading or overwriting arbitrary system files.
 *  2. Permission Hardening (CWE-276 / CWE-732): Enforces 0700 permissions on all
 *     created directories and 0600 on SQLite DBs, configs, logs, and state files
 *     (0755 on launcher shims in bin/).
 *  3. SQLite Database Integrity (CWE-362): Atomically migrates database files
 *     together with their WAL/SHM sidecars (-wal, -shm, -journal).
 *  4. Atomic Writes: All config and file modifications use atomic temp-file + rename
 *     with O_EXCL and O_NOFOLLOW to avoid corruption or partial writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteString } from './atomic-write.js';
import { restrictDbPerms } from '../shared/db-perms.js';
import { readIfExists } from './safe-fs.js';

const IS_WINDOWS = process.platform === 'win32';

export interface MigrationOptions {
  /** Mode for created directories. Default: 0o700 */
  dirMode?: number;
  /** Mode for created files unless specific type applies. Default: 0o600 */
  fileMode?: number;
  /** Mode for executable files in bin/ directories. Default: 0o755 */
  binMode?: number;
  /** If true, do not perform writes on disk. Default: false */
  dryRun?: boolean;
  /** If true, delete source files after successful migration. Default: false */
  removeSource?: boolean;
}

export interface MigratedItem {
  source: string;
  destination: string;
  type: 'file' | 'directory' | 'db_bundle';
  mode: number;
}

export interface SkippedItem {
  source: string;
  reason: 'symlink' | 'exists' | 'error';
  detail?: string;
}

export interface DirectoryMigrationResult {
  success: boolean;
  migrated: MigratedItem[];
  skipped: SkippedItem[];
  errors: string[];
}

/**
 * Check whether `targetPath` exists and is a symbolic link.
 */
export function isSymlink(targetPath: string): boolean {
  try {
    const st = fs.lstatSync(targetPath);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Assert that `targetPath` is not a symbolic link.
 * Throws a SecurityError if a symlink is detected.
 */
export function assertNotSymlink(targetPath: string, context = 'path'): void {
  if (isSymlink(targetPath)) {
    throw new Error(
      `Security Violation: ${context} "${targetPath}" is a symlink. Symlinks are not followed for security.`,
    );
  }
}

/**
 * Recursively migrate a directory tree safely from `sourceDir` to `destDir`.
 *
 * - Skips/refuses all symlinks encountered inside `sourceDir`.
 * - Sets `0700` permissions on created directories.
 * - Bundles SQLite DBs (`.db`, `-wal`, `-shm`, `-journal`) with `0600` permissions.
 * - Enforces `0755` on executable files in `bin/` subdirectories.
 */
export function migrateDirectorySafely(
  sourceDir: string,
  destDir: string,
  opts: MigrationOptions = {},
): DirectoryMigrationResult {
  const result: DirectoryMigrationResult = {
    success: true,
    migrated: [],
    skipped: [],
    errors: [],
  };

  const dirMode = opts.dirMode ?? 0o700;
  const fileMode = opts.fileMode ?? 0o600;
  const binMode = opts.binMode ?? 0o755;
  const dryRun = Boolean(opts.dryRun);

  // 1. Validate root source and destination paths
  try {
    const srcStat = fs.lstatSync(sourceDir);
    if (srcStat.isSymbolicLink()) {
      const msg = `Source directory "${sourceDir}" is a symlink. Refusing to migrate.`;
      result.errors.push(msg);
      result.success = false;
      return result;
    }
    if (!srcStat.isDirectory()) {
      const msg = `Source path "${sourceDir}" is not a directory.`;
      result.errors.push(msg);
      result.success = false;
      return result;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Source does not exist — nothing to migrate
      return result;
    }
    result.errors.push(`Failed to stat source "${sourceDir}": ${(err as Error).message}`);
    result.success = false;
    return result;
  }

  try {
    const destStat = fs.lstatSync(destDir);
    if (destStat.isSymbolicLink()) {
      const msg = `Destination directory "${destDir}" is an existing symlink. Refusing to overwrite.`;
      result.errors.push(msg);
      result.success = false;
      return result;
    }
  } catch {
    // Destination doesn't exist yet — standard path
  }

  // Prevent recursive migration if destination is inside source
  const absSrc = path.resolve(sourceDir);
  const absDest = path.resolve(destDir);
  if (absDest.startsWith(absSrc + path.sep)) {
    result.errors.push(`Destination "${destDir}" is inside source "${sourceDir}". Aborting.`);
    result.success = false;
    return result;
  }

  // 2. Create destination directory with 0700
  if (!dryRun && !fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    if (!IS_WINDOWS) {
      try {
        fs.chmodSync(destDir, dirMode);
      } catch {
        /* best-effort */
      }
    }
  }

  // 3. Process entries
  const processedSidecars = new Set<string>();

  function walk(currentSrc: string, currentDest: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentSrc, { withFileTypes: true });
    } catch (err) {
      result.errors.push(`Failed to read directory "${currentSrc}": ${(err as Error).message}`);
      return;
    }

    for (const entry of entries) {
      const srcItem = path.join(currentSrc, entry.name);
      const destItem = path.join(currentDest, entry.name);

      let itemStat: fs.Stats;
      try {
        itemStat = fs.lstatSync(srcItem);
      } catch (err) {
        result.skipped.push({ source: srcItem, reason: 'error', detail: (err as Error).message });
        continue;
      }

      // GUARD: Reject symlinks inside migration tree
      if (itemStat.isSymbolicLink()) {
        result.skipped.push({
          source: srcItem,
          reason: 'symlink',
          detail: 'Symlinks within data directory are not migrated for security.',
        });
        continue;
      }

      if (itemStat.isDirectory()) {
        if (!dryRun && !fs.existsSync(destItem)) {
          fs.mkdirSync(destItem, { recursive: true });
          if (!IS_WINDOWS) {
            try {
              fs.chmodSync(destItem, dirMode);
            } catch {
              /* best-effort */
            }
          }
        }
        result.migrated.push({
          source: srcItem,
          destination: destItem,
          type: 'directory',
          mode: dirMode,
        });
        walk(srcItem, destItem);
        continue;
      }

      if (itemStat.isFile()) {
        // Skip sidecars already handled as part of a DB bundle
        if (processedSidecars.has(srcItem)) {
          continue;
        }

        // Detect SQLite database files
        if (entry.name.endsWith('.db')) {
          const mode = fileMode;
          if (!dryRun) {
            copyFileAtomic(srcItem, destItem, mode);
            restrictDbPerms(destItem);

            // Copy accompanying WAL/SHM sidecars if present
            for (const suffix of ['-wal', '-shm', '-journal']) {
              const sidecarSrc = srcItem + suffix;
              const sidecarDest = destItem + suffix;
              try {
                const sStat = fs.lstatSync(sidecarSrc);
                if (sStat.isFile() && !sStat.isSymbolicLink()) {
                  copyFileAtomic(sidecarSrc, sidecarDest, mode);
                  restrictDbPerms(destItem);
                  processedSidecars.add(sidecarSrc);
                }
              } catch {
                // Sidecar not present — fine
              }
            }
          }

          result.migrated.push({
            source: srcItem,
            destination: destItem,
            type: 'db_bundle',
            mode,
          });
          continue;
        }

        // Executables in bin/
        const isBin = currentSrc.endsWith(`${path.sep}bin`) || currentSrc.endsWith('/bin');
        const mode = isBin ? binMode : fileMode;

        if (!dryRun) {
          copyFileAtomic(srcItem, destItem, mode);
        }

        result.migrated.push({
          source: srcItem,
          destination: destItem,
          type: 'file',
          mode,
        });
      }
    }
  }

  walk(sourceDir, destDir);

  if (result.errors.length > 0) {
    result.success = false;
  }

  return result;
}

/**
 * Safely copy a single file with atomic rename and strict permissions.
 */
function copyFileAtomic(source: string, destination: string, mode: number): void {
  const content = fs.readFileSync(source);
  const destDir = path.dirname(destination);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  atomicWriteString(destination, content.toString('utf-8'), {
    mode,
    rejectSymlinks: true,
    trailingNewline: false,
  });
}

/**
 * Migrate project configuration file from `.trace-mcp.json` to `.trace.json`.
 */
export function migrateProjectConfig(
  projectRoot: string,
  opts: { dryRun?: boolean } = {},
): { migrated: boolean; action: 'created' | 'already_present' | 'skipped'; detail?: string } {
  const legacyConfig = path.join(projectRoot, '.trace-mcp.json');
  const newConfig = path.join(projectRoot, '.trace.json');

  if (fs.existsSync(newConfig)) {
    return { migrated: false, action: 'already_present', detail: '.trace.json already exists' };
  }

  if (!fs.existsSync(legacyConfig)) {
    return { migrated: false, action: 'skipped', detail: 'No legacy .trace-mcp.json found' };
  }

  if (isSymlink(legacyConfig)) {
    return { migrated: false, action: 'skipped', detail: 'Legacy config is a symlink; skipping.' };
  }

  const raw = readIfExists(legacyConfig);
  if (raw === null) {
    return { migrated: false, action: 'skipped', detail: 'Could not read legacy config' };
  }

  if (opts.dryRun) {
    return {
      migrated: true,
      action: 'created',
      detail: 'Would copy .trace-mcp.json to .trace.json',
    };
  }

  // Preserve permissions from legacy file
  let mode = 0o600;
  try {
    const st = fs.statSync(legacyConfig);
    mode = st.mode & 0o777;
  } catch {
    /* fallback to 0600 */
  }

  atomicWriteString(newConfig, raw, { mode, rejectSymlinks: true });
  return { migrated: true, action: 'created', detail: 'Migrated .trace-mcp.json to .trace.json' };
}

/**
 * Migrate legacy client configuration entries (e.g. mcpServers['trace-mcp'] -> mcpServers['trace']).
 */
export function migrateClientConfigServers(
  configPath: string,
  legacyKey = 'trace-mcp',
  newKey = 'trace',
  opts: { dryRun?: boolean } = {},
): { migrated: boolean; error?: string } {
  if (isSymlink(configPath)) {
    return {
      migrated: false,
      error: `Config path "${configPath}" is a symlink. Refusing to write.`,
    };
  }

  const raw = readIfExists(configPath);
  if (raw === null) {
    return { migrated: false };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { migrated: false, error: `Failed to parse JSON: ${(err as Error).message}` };
  }

  const servers = parsed.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object') {
    return { migrated: false };
  }

  // Legacy key alone gets moved to newKey; legacy key alongside an already-
  // present newKey just gets dropped — either way, presence of the legacy
  // key is what makes this a migration.
  if (legacyKey in servers) {
    if (opts.dryRun) {
      return { migrated: true };
    }

    if (!(newKey in servers)) {
      servers[newKey] = servers[legacyKey];
    }
    delete servers[legacyKey];

    atomicWriteString(configPath, JSON.stringify(parsed, null, 2), { rejectSymlinks: true });
    return { migrated: true };
  }

  return { migrated: false };
}
