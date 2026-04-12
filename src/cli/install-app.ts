/**
 * Download and install the trace-mcp menu bar app from GitHub Releases.
 * macOS only — called from `trace-mcp init` or standalone via `trace-mcp install-app`.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execSync } from 'node:child_process';
import { Command } from 'commander';

const GITHUB_REPO = 'nikolai-vysotskyi/trace-mcp';
const APP_NAME = 'trace-mcp.app';
const INSTALL_DIR = path.join(os.homedir(), 'Applications');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InstallAppResult {
  installed: boolean;
  path?: string;
  error?: string;
}

/** Fetch the latest release tag from GitHub API */
function fetchLatestRelease(timeoutMs = 10000): Promise<{ tag: string; assets: { name: string; url: string }[] }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'trace-mcp',
          Accept: 'application/vnd.github.v3+json',
        },
      },
      (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          // Follow redirect
          const location = res.headers.location;
          if (location) {
            https.get(location, { timeout: timeoutMs, headers: { 'User-Agent': 'trace-mcp', Accept: 'application/vnd.github.v3+json' } }, handleResponse).on('error', reject);
          } else {
            reject(new Error('Redirect without location'));
          }
          return;
        }
        handleResponse(res);

        function handleResponse(response: typeof res) {
          let body = '';
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => {
            try {
              const release = JSON.parse(body) as {
                tag_name?: string;
                assets?: { name: string; browser_download_url: string }[];
              };
              if (!release.tag_name) {
                reject(new Error('No release found'));
                return;
              }
              resolve({
                tag: release.tag_name,
                assets: (release.assets ?? []).map((a) => ({
                  name: a.name,
                  url: a.browser_download_url,
                })),
              });
            } catch (e) {
              reject(e);
            }
          });
        }
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API request timed out')); });
  });
}

/** Download a file from URL, following redirects */
function downloadFile(url: string, dest: string, timeoutMs = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const doGet = (targetUrl: string, redirects = 0) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return; }
      const mod = targetUrl.startsWith('https') ? https : require('node:http') as typeof https;
      mod.get(targetUrl, { timeout: timeoutMs, headers: { 'User-Agent': 'trace-mcp' } }, (res) => {
        if ((res.statusCode === 302 || res.statusCode === 301) && res.headers.location) {
          doGet(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    doGet(url);
  });
}

/**
 * Install the trace-mcp menu bar app.
 * 1. Detect arch (arm64 / x64)
 * 2. Fetch latest release from GitHub
 * 3. Download the matching zip
 * 4. Unzip to ~/Applications/trace-mcp.app
 */
export interface InstallGuiAppOptions {
  /** Max retries when the release exists but the arch zip hasn't been uploaded yet */
  retries?: number;
  /** Delay between retries in ms (default 15 000) */
  retryDelayMs?: number;
  /** Called before each retry with attempt number and total */
  onRetry?: (attempt: number, total: number) => void;
}

export async function installGuiApp(opts: InstallGuiAppOptions = {}): Promise<InstallAppResult> {
  if (process.platform !== 'darwin') {
    return { installed: false, error: 'Menu bar app is macOS only' };
  }

  const { retries = 3, retryDelayMs = 15_000, onRetry } = opts;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  // electron-builder names: trace-mcp-{ver}-arm64-mac.zip / trace-mcp-{ver}-mac.zip (x64)
  const findAsset = (assets: { name: string }[]) => {
    const zips = assets.filter((a) => /trace-mcp.*\.zip$/i.test(a.name));
    if (arch === 'arm64') {
      return zips.find((a) => /arm64/i.test(a.name));
    }
    // x64: pick the zip that does NOT contain arm64
    return zips.find((a) => !/arm64/i.test(a.name));
  };

  try {
    // 1. Fetch latest release — retry if the arch asset isn't uploaded yet
    //    (race condition: npm publish finishes before electron-builder uploads the zip)
    let release: Awaited<ReturnType<typeof fetchLatestRelease>>;
    let asset: { name: string; url: string } | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      release = await fetchLatestRelease();
      asset = findAsset(release.assets);
      if (asset) break;

      if (attempt < retries) {
        onRetry?.(attempt + 1, retries);
        await sleep(retryDelayMs);
      }
    }

    if (!asset) {
      return {
        installed: false,
        error: `No ${arch} zip found in release ${release!.tag} (${release!.assets.length} assets available: ${release!.assets.map((a) => a.name).join(', ') || 'none'}). The build may still be in progress — try again in a few minutes with: trace-mcp install-app`,
      };
    }

    // 2. Download to temp
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-app-'));
    const zipPath = path.join(tmpDir, asset.name);
    await downloadFile(asset.url, zipPath);

    // 3. Ensure ~/Applications exists
    fs.mkdirSync(INSTALL_DIR, { recursive: true });

    // 4. Remove old installation if present
    const appPath = path.join(INSTALL_DIR, APP_NAME);
    if (fs.existsSync(appPath)) {
      fs.rmSync(appPath, { recursive: true, force: true });
    }

    // 5. Unzip
    execSync(`unzip -q -o "${zipPath}" -d "${INSTALL_DIR}"`, { stdio: 'pipe' });

    // 6. Write version marker (used by postinstall to skip re-download)
    fs.writeFileSync(path.join(INSTALL_DIR, '.trace-mcp-version'), release!.tag, 'utf-8');

    // 7. Clean up temp
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return { installed: true, path: appPath };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}

/** Check if the app is already installed */
export function isAppInstalled(): boolean {
  return fs.existsSync(path.join(INSTALL_DIR, APP_NAME));
}

/** Standalone CLI command: `trace-mcp install-app` */
export const installAppCommand = new Command('install-app')
  .description('Download and install (or update) the trace-mcp menu bar app (macOS)')
  .option('--retries <n>', 'Number of retries if asset not yet uploaded', '3')
  .option('--retry-delay <ms>', 'Delay between retries in ms', '15000')
  .action(async (opts: { retries: string; retryDelay: string }) => {
    if (process.platform !== 'darwin') {
      console.error('Error: Menu bar app is macOS only.');
      process.exit(1);
    }

    const retries = parseInt(opts.retries, 10);
    const retryDelayMs = parseInt(opts.retryDelay, 10);

    const already = isAppInstalled();
    console.log(already ? 'Updating trace-mcp menu bar app…' : 'Installing trace-mcp menu bar app…');

    const result = await installGuiApp({
      retries,
      retryDelayMs,
      onRetry: (attempt, total) => {
        console.log(`  Asset not yet available, retrying (${attempt}/${total})…`);
      },
    });

    if (result.installed) {
      console.log(`✓ ${already ? 'Updated' : 'Installed'} → ${result.path}`);
    } else {
      console.error(`✗ ${result.error}`);
      process.exit(1);
    }
  });
