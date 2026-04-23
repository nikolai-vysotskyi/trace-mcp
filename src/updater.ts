import https from 'node:https';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { TRACE_MCP_HOME, ensureGlobalDirs, getDbPath } from './global.js';
import { logger } from './logger.js';

declare const PKG_VERSION_INJECTED: string;
const CURRENT_VERSION =
  typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';

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
}

/** Back-off window after a failed auto-update install. */
const FAILED_INSTALL_RETRY_MS = 60 * 60 * 1000; // 1 hour

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
    fs.writeFileSync(UPDATE_CACHE_PATH, JSON.stringify(cache));
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

  const intervalMs = (opts.checkIntervalHours ?? 12) * 3_600_000;
  const now = Date.now();
  const cache = readCache();

  let latestVersion: string;

  if (cache && now - cache.lastChecked < intervalMs) {
    latestVersion = cache.latestVersion;
    logger.debug({ current: CURRENT_VERSION, latest: latestVersion }, 'Auto-update: using cached version info');
  } else {
    try {
      latestVersion = await fetchLatestVersion();
      writeCache({ lastChecked: now, latestVersion });
      logger.debug({ current: CURRENT_VERSION, latest: latestVersion }, 'Auto-update: fetched latest version from registry');
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
  if (
    cache?.lastFailedVersion === latestVersion &&
    cache.lastFailedInstall &&
    now - cache.lastFailedInstall < FAILED_INSTALL_RETRY_MS
  ) {
    logger.debug(
      { version: latestVersion, failedAgo: now - cache.lastFailedInstall },
      'Auto-update: skipping retry, previous install failed recently',
    );
    return false;
  }

  logger.info(
    { current: CURRENT_VERSION, latest: latestVersion },
    'Auto-update: newer version found, installing...',
  );

  // Pre-flight: wipe any `.trace-mcp-<rand>` scratch dirs from prior interrupted
  // installs. `--force` swaps the package dir wholesale instead of relying on
  // npm's rename dance, which is the fragile step that fails with ENOTEMPTY.
  const npmRoot = resolveNpmRoot();
  if (npmRoot) cleanStaleScratchDirs(npmRoot);

  const runInstall = () =>
    spawnSync('npm', ['install', '-g', `trace-mcp@${latestVersion}`, '--force'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      encoding: 'utf-8',
    });

  let result = runInstall();

  // ENOTEMPTY even after --force means the main `trace-mcp` dir itself is in a
  // corrupt half-extracted state. Nuke it along with any scratches and retry once.
  if (result.status !== 0 && /ENOTEMPTY/.test(result.stderr ?? '') && npmRoot) {
    logger.warn('Auto-update: ENOTEMPTY detected, nuking corrupt install dir and retrying');
    cleanStaleScratchDirs(npmRoot);
    try {
      fs.rmSync(path.join(npmRoot, 'trace-mcp'), { recursive: true, force: true });
    } catch {}
    result = runInstall();
  }

  if (result.status !== 0) {
    logger.warn(
      { stderr: (result.stderr ?? '').slice(-500), status: result.status },
      'Auto-update: npm install failed',
    );
    // Stamp the failure so future spawns skip retry for FAILED_INSTALL_RETRY_MS.
    writeCache({
      lastChecked: now,
      latestVersion,
      installedVersion: cache?.installedVersion,
      lastFailedInstall: now,
      lastFailedVersion: latestVersion,
    });
    return false;
  }

  // Record the version we just installed so the restarted process can detect
  // the upgrade and run post-update migrations. Clear any prior failure stamp.
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

  // Dynamic imports — only needed during post-update, avoid loading at every startup
  const [
    { migrateGlobalConfig },
    { detectGuardHook },
    { installGuardHook, installReindexHook, installPrecompactHook, installWorktreeHook },
    { updateClaudeMd },
    { listProjects, updateLastIndexed },
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

  // 4. Reindex all registered projects
  const projects = listProjects();
  if (projects.length > 0) {
    logger.info({ count: projects.length }, 'Post-update: reindexing registered projects...');

    const [{ initializeDatabase }, { Store }, { PluginRegistry }, { IndexingPipeline }, { loadConfig }] = await Promise.all([
      import('./db/schema.js'),
      import('./db/store.js'),
      import('./plugin-api/registry.js'),
      import('./indexer/pipeline.js'),
      import('./config.js'),
    ]);

    for (const proj of projects) {
      if (!fs.existsSync(proj.root)) {
        logger.debug({ root: proj.root }, 'Post-update: skipping stale project (directory missing)');
        continue;
      }

      try {
        const configResult = await loadConfig(proj.root);
        if (configResult.isErr()) {
          logger.warn({ root: proj.root, error: configResult.error }, 'Post-update: config load failed, skipping');
          continue;
        }

        const dbPath = getDbPath(proj.root);
        const db = initializeDatabase(dbPath);
        const store = new Store(db);

        const registry = PluginRegistry.createWithDefaults();

        const pipeline = new IndexingPipeline(store, registry, configResult.value, proj.root);
        const result = await pipeline.indexAll(true); // force = true
        updateLastIndexed(proj.root);
        db.close();

        logger.info(
          { root: proj.root, indexed: result.indexed, skipped: result.skipped, errors: result.errors },
          'Post-update: project reindexed',
        );
      } catch (err) {
        logger.warn({ root: proj.root, error: err }, 'Post-update: project reindex failed (non-fatal)');
      }
    }
  }

  // Stamp the current version so we don't re-run on next startup
  writeCache({ ...cache, installedVersion: CURRENT_VERSION });
  logger.info({ version: CURRENT_VERSION }, 'Post-update: migrations complete');
}
