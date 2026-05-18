import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureGlobalDirs, TRACE_MCP_HOME } from './global.js';
import { logger } from './logger.js';
import { atomicWriteJson } from './utils/atomic-write.js';

declare const PKG_VERSION_INJECTED: string;
const CURRENT_VERSION =
  typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';

/**
 * Detect a local dev install that must never be overwritten by a registry
 * release. Two independent signals:
 *   1. Package directory is a symlink — `npm link` places such a symlink at
 *      `<global>/lib/node_modules/trace-mcp` pointing into the source checkout.
 *      This covers the case where the CLI was spawned via the npm-global bin.
 *   2. A `.git` directory sits next to package.json — i.e. we are running
 *      straight out of a source checkout (what the launcher's TRACE_MCP_CLI
 *      points at when `npm link` is used). `npm install`-ed trees never have
 *      this since npm strips the repo metadata on publish.
 */
function isDevCheckout(): boolean {
  // Test-only escape hatch: lets the rollback suite exercise the install path
  // even though `.git` sits next to the source tree the tests run from.
  if (process.env.TRACE_MCP_FORCE_NOT_DEV_CHECKOUT === '1') return false;
  try {
    // dist/cli.js or dist/index.js → the dist dir → its parent is the pkg root.
    const self = fileURLToPath(import.meta.url);
    const pkgRoot = path.resolve(path.dirname(self), '..');
    if (fs.lstatSync(pkgRoot).isSymbolicLink()) return true;
    if (fs.existsSync(path.join(pkgRoot, '.git'))) return true;
    return false;
  } catch {
    return false;
  }
}

const UPDATE_CACHE_PATH = path.join(TRACE_MCP_HOME, 'update-check.json');

interface UpdateCache {
  lastChecked: number;
  latestVersion: string;
  /** The version that was last running — used to detect post-update restarts. */
  installedVersion?: string;
  /** Timestamp of the last failed npm install, to avoid retry storms. */
  lastFailedInstall?: number;
  /** Version that last failed to install — back off only for the same target. */
  lastFailedVersion?: string;
  /** Consecutive failed installs for `lastFailedVersion` (reset on success). */
  consecutiveFailedInstalls?: number;
}

/** Back-off window after a failed auto-update install. */
const FAILED_INSTALL_RETRY_MS = 60 * 60 * 1000; // 1 hour

/** Extended back-off after repeated failures for the same target version. */
const FAILED_INSTALL_LONG_RETRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Switch to the long back-off after this many consecutive failures. */
const FAILED_INSTALL_LONG_RETRY_THRESHOLD = 3;

/** Prefix for atomic-rename backup directories. Deliberately does NOT start
 *  with `.trace-mcp-` so cleanStaleScratchDirs doesn't wipe our own backups. */
const BACKUP_DIR_PREFIX = 'trace-mcp.tmcp-bak-';

/**
 * Resolve the global npm root (`npm root -g`). Used to locate `.trace-mcp-*`
 * scratch directories that npm leaves behind when an install is interrupted.
 *
 * Goes through a login shell so the GUI-launched daemon picks up the same
 * PATH (nvm/volta/homebrew) the user has in the terminal.
 */
function resolveNpmRoot(): string | null {
  const shell = process.env.SHELL;
  const cmd = shell ? shell : 'npm';
  const args = shell ? ['-lc', 'npm root -g'] : ['root', '-g'];
  try {
    const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 30_000 });
    if (result.status !== 0) return null;
    const line = (result.stdout ?? '').trim().split('\n').pop()?.trim() ?? '';
    return line || null;
  } catch {
    return null;
  }
}

/**
 * Remove `.trace-mcp-<rand>` scratch directories left behind by a previous
 * interrupted `npm install -g trace-mcp`. npm performs the module swap via
 * rename-to-scratch-then-rename-back; if the process died mid-swap the scratch
 * dir lingers and the next install fails with ENOTEMPTY.
 */
function cleanStaleScratchDirs(npmRoot: string): void {
  try {
    for (const entry of fs.readdirSync(npmRoot)) {
      if (entry.startsWith('.trace-mcp-')) {
        try {
          fs.rmSync(path.join(npmRoot, entry), { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}
}

/** Check if a PID is still alive. Signal 0 is the standard liveness probe. */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = process exists but we can't signal it.
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/** Parse PID out of `trace-mcp.tmcp-bak-<pid>`. Returns NaN for malformed names. */
function backupPid(entry: string): number {
  if (!entry.startsWith(BACKUP_DIR_PREFIX)) return NaN;
  return parseInt(entry.slice(BACKUP_DIR_PREFIX.length), 10);
}

/**
 * Reconcile any leftover `trace-mcp.tmcp-bak-*` backups from previous crashed
 * updater runs. Two scenarios:
 *
 *   - Main package dir MISSING + backup from dead PID exists → restore it.
 *     A previous run renamed-out, then died before renaming-in. We must
 *     un-brick the install before doing anything else.
 *   - Main package dir PRESENT + backup from dead PID exists → just delete it.
 *     Leftover garbage from a successful retry that never got to clean up.
 *
 * Backups from a still-running PID are left untouched — another updater
 * process owns them.
 */
function reconcileStaleBackups(npmRoot: string): void {
  const mainDir = path.join(npmRoot, 'trace-mcp');
  let entries: string[];
  try {
    entries = fs.readdirSync(npmRoot);
  } catch {
    return;
  }

  const mainExists = fs.existsSync(mainDir);

  for (const entry of entries) {
    const pid = backupPid(entry);
    if (!Number.isFinite(pid)) continue;
    if (isPidAlive(pid)) continue; // Owned by a live updater — leave alone.

    const full = path.join(npmRoot, entry);
    if (!mainExists) {
      // Restore the first dead-PID backup we find, then stop — there can be
      // only one canonical main dir. Any further backups become garbage and
      // will be wiped on the next reconcile pass.
      try {
        fs.renameSync(full, mainDir);
        logger.warn(
          { backup: full, restored: mainDir },
          'Auto-update: restored package dir from stale backup of dead updater process',
        );
        return;
      } catch (err) {
        logger.warn(
          { backup: full, error: err },
          'Auto-update: failed to restore stale backup, leaving in place',
        );
      }
    } else {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        logger.debug({ backup: full }, 'Auto-update: removed stale leftover backup');
      } catch {}
    }
  }
}

function readCache(): UpdateCache | null {
  try {
    if (!fs.existsSync(UPDATE_CACHE_PATH)) return null;
    return JSON.parse(fs.readFileSync(UPDATE_CACHE_PATH, 'utf-8')) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    atomicWriteJson(UPDATE_CACHE_PATH, cache, { indent: 0, trailingNewline: false });
  } catch {}
}

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/[^\d.]/g, '')
      .split('.')
      .map((x) => parseInt(x, 10));
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

function fetchLatestVersion(timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      'https://registry.npmjs.org/trace-mcp/latest',
      {
        timeout: timeoutMs,
        headers: { 'User-Agent': `trace-mcp/${CURRENT_VERSION}` },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const pkg = JSON.parse(body) as { version?: string };
            if (pkg.version) resolve(pkg.version);
            else reject(new Error('No version field in npm response'));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Registry request timed out'));
    });
  });
}

export interface AutoUpdateOptions {
  /** How often to check npm registry. Default: 12 hours. */
  checkIntervalHours?: number;
}

/**
 * Check if a newer trace-mcp version is available and install it globally.
 *
 * Returns true if a new version was successfully installed — the caller should
 * then `process.exit(0)` so the MCP client restarts with the updated binary.
 */
export async function checkAndInstallUpdate(opts: AutoUpdateOptions = {}): Promise<boolean> {
  if (CURRENT_VERSION === '0.0.0-dev') return false;

  // Explicit opt-out for users who manage their own versioning (CI, distros,
  // vendored installs) — also used by our own tests / dev loops.
  if (process.env.TRACE_MCP_NO_AUTO_UPDATE === '1') {
    logger.debug('Auto-update: disabled via TRACE_MCP_NO_AUTO_UPDATE=1');
    return false;
  }

  // Dev checkout (symlinked npm-link OR `.git` next to package.json):
  // never overwrite a source tree with a registry release. The two signals
  // cover both invocation styles — via the npm-global bin (symlink) and via
  // the direct source path the launcher stores in launcher.env.
  if (isDevCheckout()) {
    logger.debug('Auto-update: skipped — running from dev checkout');
    return false;
  }

  const intervalMs = (opts.checkIntervalHours ?? 12) * 3_600_000;
  const now = Date.now();
  const cache = readCache();

  let latestVersion: string;

  if (cache && now - cache.lastChecked < intervalMs) {
    latestVersion = cache.latestVersion;
    logger.debug(
      { current: CURRENT_VERSION, latest: latestVersion },
      'Auto-update: using cached version info',
    );
  } else {
    try {
      latestVersion = await fetchLatestVersion();
      writeCache({ lastChecked: now, latestVersion });
      logger.debug(
        { current: CURRENT_VERSION, latest: latestVersion },
        'Auto-update: fetched latest version from registry',
      );
    } catch (e) {
      logger.debug({ error: e }, 'Auto-update: registry check skipped (unreachable)');
      return false;
    }
  }

  if (!semverGt(latestVersion, CURRENT_VERSION)) {
    logger.debug({ version: CURRENT_VERSION }, 'Auto-update: already up to date');
    return false;
  }

  // Back off on repeated failures for the same target version so a broken
  // install doesn't trigger a `npm install` storm on every MCP client respawn.
  // After FAILED_INSTALL_LONG_RETRY_THRESHOLD consecutive failures for the
  // same target, switch to a 7-day window so an offline / fundamentally broken
  // target version doesn't keep retrying every hour.
  if (cache?.lastFailedVersion === latestVersion && cache.lastFailedInstall) {
    const consecutive = cache.consecutiveFailedInstalls ?? 1;
    const window =
      consecutive >= FAILED_INSTALL_LONG_RETRY_THRESHOLD
        ? FAILED_INSTALL_LONG_RETRY_MS
        : FAILED_INSTALL_RETRY_MS;
    if (now - cache.lastFailedInstall < window) {
      logger.debug(
        {
          version: latestVersion,
          failedAgo: now - cache.lastFailedInstall,
          consecutiveFailedInstalls: consecutive,
          windowMs: window,
        },
        'Auto-update: skipping retry, previous install failed recently',
      );
      return false;
    }
  }

  logger.info(
    { current: CURRENT_VERSION, latest: latestVersion },
    'Auto-update: newer version found, installing...',
  );

  // Pre-flight: wipe any `.trace-mcp-<rand>` scratch dirs from prior interrupted
  // installs. `--force` swaps the package dir wholesale instead of relying on
  // npm's rename dance, which is the fragile step that fails with ENOTEMPTY.
  const npmRoot = resolveNpmRoot();
  if (npmRoot) {
    cleanStaleScratchDirs(npmRoot);
    reconcileStaleBackups(npmRoot);
  }

  const runInstall = () =>
    spawnSync('npm', ['install', '-g', `trace-mcp@${latestVersion}`, '--force'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      encoding: 'utf-8',
    });

  let result = runInstall();

  // ENOTEMPTY even after --force means the main `trace-mcp` dir itself is in a
  // corrupt half-extracted state. Atomic-rename it aside, retry once, and
  // rollback the rename if the retry also fails. NEVER destroy the package dir
  // outright — a second install failure (network blip, ENOSPC, registry hiccup)
  // would leave the user with no trace-mcp at all.
  if (result.status !== 0 && /ENOTEMPTY/.test(result.stderr ?? '') && npmRoot) {
    logger.warn('Auto-update: ENOTEMPTY detected, backing up corrupt install dir and retrying');
    cleanStaleScratchDirs(npmRoot);

    const mainDir = path.join(npmRoot, 'trace-mcp');
    const backupDir = path.join(npmRoot, `${BACKUP_DIR_PREFIX}${process.pid}`);

    // Atomic rename within the same filesystem — see rename(2). If mainDir
    // doesn't exist (already wiped by a previous failed run) we just proceed
    // to install fresh; there's nothing to back up or restore.
    let backedUp = false;
    try {
      fs.renameSync(mainDir, backupDir);
      backedUp = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(
          { error: err, mainDir },
          'Auto-update: failed to back up corrupt install dir before retry',
        );
      }
    }

    result = runInstall();

    if (result.status === 0) {
      // Install succeeded — drop the backup.
      if (backedUp) {
        try {
          fs.rmSync(backupDir, { recursive: true, force: true });
          logger.debug({ backupDir }, 'Auto-update: removed backup after successful retry');
        } catch (err) {
          logger.debug({ error: err, backupDir }, 'Auto-update: backup cleanup failed (non-fatal)');
        }
      }
    } else if (backedUp) {
      // Install failed — rollback. If npm partially extracted a new mainDir,
      // wipe it before renaming the backup back into place.
      if (fs.existsSync(mainDir)) {
        try {
          fs.rmSync(mainDir, { recursive: true, force: true });
        } catch (err) {
          logger.warn(
            { error: err, mainDir },
            'Auto-update: failed to remove partial install before rollback',
          );
        }
      }
      try {
        fs.renameSync(backupDir, mainDir);
        logger.warn(
          { version: latestVersion },
          'Auto-update: install retry failed, previous install restored from backup',
        );
      } catch (restoreErr) {
        // CATASTROPHIC: rollback itself failed. The user must know the package
        // is in a broken state and where their backup lives.
        logger.error(
          {
            error: restoreErr,
            backupDir,
            mainDir,
            recovery: `mv ${backupDir} ${mainDir}`,
          },
          'Auto-update: FATAL — backup restore failed, manual recovery required',
        );
      }
    }
  }

  if (result.status !== 0) {
    logger.warn(
      { stderr: (result.stderr ?? '').slice(-500), status: result.status },
      'Auto-update: npm install failed',
    );
    // Increment the consecutive-failure counter for this exact target.
    const sameTarget = cache?.lastFailedVersion === latestVersion;
    const consecutive = sameTarget ? (cache?.consecutiveFailedInstalls ?? 0) + 1 : 1;
    if (consecutive >= FAILED_INSTALL_LONG_RETRY_THRESHOLD) {
      logger.warn(
        {
          version: latestVersion,
          consecutiveFailedInstalls: consecutive,
          retryAfterDays: FAILED_INSTALL_LONG_RETRY_MS / (24 * 60 * 60 * 1000),
        },
        `Auto-update: disabled for v${latestVersion} until manual intervention (too many failures)`,
      );
    }
    writeCache({
      lastChecked: now,
      latestVersion,
      installedVersion: cache?.installedVersion,
      lastFailedInstall: now,
      lastFailedVersion: latestVersion,
      consecutiveFailedInstalls: consecutive,
    });
    return false;
  }

  // Record the version we just installed so the restarted process can detect
  // the upgrade and run post-update migrations. Clear any prior failure stamp
  // (including the consecutive-failure counter — success resets the streak).
  writeCache({ lastChecked: now, latestVersion, installedVersion: latestVersion });

  logger.info({ version: latestVersion }, 'Auto-update: installed successfully, restarting...');
  return true;
}

/**
 * Detect whether we're running for the first time after an auto-update and,
 * if so, perform post-update migrations:
 *
 *  1. Migrate global config (add new keys, remove stale ones)
 *  2. Re-install hooks (guard, reindex, precompact, worktree) — picks up new
 *     script versions shipped with the update
 *  3. Update global CLAUDE.md block
 *  4. Force-reindex every registered project so index schema changes and new
 *     parser/plugin improvements take effect
 *
 * Safe to call on every startup — it's a no-op when no version change is detected.
 */
export async function runPostUpdateMigrations(): Promise<void> {
  if (CURRENT_VERSION === '0.0.0-dev') return;

  const cache = readCache();
  if (!cache) return;

  // Compare what we recorded as the last-running version with what we are now.
  // On a fresh install `installedVersion` won't exist yet — stamp it and exit.
  if (!cache.installedVersion) {
    writeCache({ ...cache, installedVersion: CURRENT_VERSION });
    return;
  }

  if (cache.installedVersion === CURRENT_VERSION) return;

  // --- Version changed — run migrations ---
  const previousVersion = cache.installedVersion;
  logger.info(
    { from: previousVersion, to: CURRENT_VERSION },
    'Post-update: version change detected, running migrations...',
  );

  // Stamp the new version FIRST, before doing any work. If the daemon is
  // killed mid-migration (e.g. by the desktop app's /health watchdog when
  // event loop is busy), the next startup must not re-run the migration
  // and re-enter the loop. We accept that an aborted migration may leave
  // hooks/CLAUDE.md/reindex partially applied — a partial migration is
  // far better than an infinite restart loop. See tray.js shouldAttemptRestart.
  writeCache({ ...cache, installedVersion: CURRENT_VERSION });

  // Dynamic imports — only needed during post-update, avoid loading at every startup
  const [
    { migrateGlobalConfig },
    { detectGuardHook },
    { installGuardHook, installReindexHook, installPrecompactHook, installWorktreeHook },
    { updateClaudeMd },
    { listProjects, markAllProjectsPendingReindex },
  ] = await Promise.all([
    import('./config-jsonc.js'),
    import('./init/detector.js'),
    import('./init/hooks.js'),
    import('./init/claude-md.js'),
    import('./registry.js'),
  ]);

  // 1. Migrate global config
  ensureGlobalDirs();
  const migration = migrateGlobalConfig();
  if (migration.changed) {
    logger.info({ added: migration.added }, 'Post-update: global config migrated');
  }

  // 2. Re-install hooks (idempotent — overwrites scripts + patches settings.json)
  const { hasGuardHook } = detectGuardHook();
  if (hasGuardHook) {
    try {
      installGuardHook({ global: true });
      installReindexHook({ global: true });
      installPrecompactHook({ global: true });
      installWorktreeHook({ global: true });
      logger.info('Post-update: hooks upgraded');
    } catch (err) {
      logger.warn({ error: err }, 'Post-update: hook upgrade failed (non-fatal)');
    }
  }

  // 3. Update global CLAUDE.md block
  try {
    updateClaudeMd(process.cwd(), { scope: 'global' });
    logger.info('Post-update: CLAUDE.md updated');
  } catch (err) {
    logger.warn({ error: err }, 'Post-update: CLAUDE.md update failed (non-fatal)');
  }

  // 4. Mark every project as needing a reindex at the new version. The
  //    actual reindex is deferred until the daemon's ProjectManager.addProject()
  //    opens each project (lazy, per-project, in the background) — see
  //    clearPendingReindex. Doing it inline here used to take seconds against
  //    a stuffed registry (31 projects in the wild), blocking the event loop
  //    long enough that the desktop app's 5s /health watchdog flagged the
  //    daemon as unreachable and shot it with `daemon restart`, restarting
  //    the migration from scratch — an infinite loop. Deferring breaks it.
  const projects = listProjects();
  if (projects.length > 0) {
    const marked = markAllProjectsPendingReindex(CURRENT_VERSION);
    logger.info(
      { count: projects.length, marked, version: CURRENT_VERSION },
      'Post-update: marked projects for lazy reindex (deferred to ProjectManager.addProject)',
    );
  }

  logger.info({ version: CURRENT_VERSION }, 'Post-update: migrations complete');
}
