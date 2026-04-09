import https from 'node:https';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { TRACE_MCP_HOME } from './global.js';
import { logger } from './logger.js';

declare const PKG_VERSION_INJECTED: string;
const CURRENT_VERSION =
  typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';

const UPDATE_CACHE_PATH = path.join(TRACE_MCP_HOME, 'update-check.json');

interface UpdateCache {
  lastChecked: number;
  latestVersion: string;
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

  logger.info(
    { current: CURRENT_VERSION, latest: latestVersion },
    'Auto-update: newer version found, installing...',
  );

  const result = spawnSync('npm', ['install', '-g', `trace-mcp@${latestVersion}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    logger.warn(
      { stderr: (result.stderr ?? '').slice(0, 500), status: result.status },
      'Auto-update: npm install failed',
    );
    return false;
  }

  logger.info({ version: latestVersion }, 'Auto-update: installed successfully, restarting...');
  return true;
}
