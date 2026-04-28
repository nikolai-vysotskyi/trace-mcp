/**
 * Download and install the trace-mcp menu bar app from GitHub Releases.
 * Supports macOS and Windows.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

const GITHUB_REPO = 'nikolai-vysotskyi/trace-mcp';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

const APP_NAME = isMac ? 'trace-mcp.app' : 'trace-mcp';
const INSTALL_DIR = isMac
  ? path.join(os.homedir(), 'Applications')
  : path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'Programs',
      'trace-mcp',
    );

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InstallAppResult {
  installed: boolean;
  path?: string;
  error?: string;
}

/** Fetch the latest release tag from GitHub API */
function fetchLatestRelease(
  timeoutMs = 10000,
): Promise<{ tag: string; assets: { name: string; url: string }[] }> {
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
            https
              .get(
                location,
                {
                  timeout: timeoutMs,
                  headers: { 'User-Agent': 'trace-mcp', Accept: 'application/vnd.github.v3+json' },
                },
                handleResponse,
              )
              .on('error', reject);
          } else {
            reject(new Error('Redirect without location'));
          }
          return;
        }
        handleResponse(res);

        function handleResponse(response: typeof res) {
          let body = '';
          response.on('data', (chunk: string) => {
            body += chunk;
          });
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
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('GitHub API request timed out'));
    });
  });
}

/** Download a file from URL, following redirects */
function downloadFile(url: string, dest: string, timeoutMs = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const doGet = (targetUrl: string, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const mod = targetUrl.startsWith('https') ? https : (require('node:http') as typeof https);
      mod
        .get(targetUrl, { timeout: timeoutMs, headers: { 'User-Agent': 'trace-mcp' } }, (res) => {
          if ((res.statusCode === 302 || res.statusCode === 301) && res.headers.location) {
            doGet(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        })
        .on('error', (err) => {
          fs.unlink(dest, () => {});
          reject(err);
        });
    };
    doGet(url);
  });
}

/** Pin the app to the macOS Dock (persistent-apps) if not already present. */
function pinToDock(appPath: string): void {
  try {
    // Check if already in Dock
    const dockPlist = execSync('defaults read com.apple.dock persistent-apps', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (dockPlist.includes(appPath)) return;

    // Add to Dock
    const entry = `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${appPath}</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>`;
    execSync(`defaults write com.apple.dock persistent-apps -array-add '${entry}'`, {
      stdio: 'pipe',
    });
    execSync('killall Dock', { stdio: 'pipe' });
  } catch {
    // Non-critical — don't fail the install if Dock pinning doesn't work
  }
}

/** Create a Start Menu shortcut on Windows. */
function createStartMenuShortcut(exePath: string): void {
  try {
    const startMenuDir = path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
    );
    fs.mkdirSync(startMenuDir, { recursive: true });
    const shortcutPath = path.join(startMenuDir, 'trace-mcp.lnk');

    // Use PowerShell to create .lnk shortcut
    const ps = `
      $ws = New-Object -ComObject WScript.Shell;
      $sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}');
      $sc.TargetPath = '${exePath.replace(/'/g, "''")}';
      $sc.WorkingDirectory = '${path.dirname(exePath).replace(/'/g, "''")}';
      $sc.Description = 'trace-mcp';
      $sc.Save();
    `.replace(/\n/g, ' ');
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'pipe' });
  } catch {
    // Non-critical — don't fail the install if shortcut creation doesn't work
  }
}

/**
 * Install the trace-mcp menu bar app.
 * 1. Detect arch (arm64 / x64) and platform
 * 2. Fetch latest release from GitHub
 * 3. Download the matching archive
 * 4. Extract to installation directory
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
  if (!isMac && !isWin) {
    return { installed: false, error: 'App installation is supported on macOS and Windows only' };
  }

  const { retries = 3, retryDelayMs = 15_000, onRetry } = opts;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  const findAsset = (assets: { name: string }[]) => {
    if (isMac) {
      // electron-builder names: trace-mcp-{ver}-arm64-mac.zip / trace-mcp-{ver}-mac.zip (x64)
      const zips = assets.filter((a) => /trace-mcp.*-mac.*\.zip$/i.test(a.name));
      if (arch === 'arm64') {
        return zips.find((a) => /arm64/i.test(a.name));
      }
      return zips.find((a) => !/arm64/i.test(a.name));
    }
    // Windows: trace-mcp Setup *.exe or trace-mcp-*-win.zip
    // Prefer portable zip for silent install
    const winZips = assets.filter((a) => /trace-mcp.*-win.*\.zip$/i.test(a.name));
    if (winZips.length > 0) {
      return (
        winZips.find((a) => (arch === 'arm64' ? /arm64/i.test(a.name) : !/arm64/i.test(a.name))) ??
        winZips[0]
      );
    }
    // Fallback: NSIS exe installer
    const exes = assets.filter((a) => /trace-mcp.*\.exe$/i.test(a.name));
    if (exes.length > 0) {
      return (
        exes.find((a) => (arch === 'arm64' ? /arm64/i.test(a.name) : !/arm64/i.test(a.name))) ??
        exes[0]
      );
    }
    return undefined;
  };

  try {
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
        error: `No ${process.platform}/${arch} archive found in release ${release!.tag} (${release!.assets.length} assets available: ${release!.assets.map((a) => a.name).join(', ') || 'none'}). The build may still be in progress — try again in a few minutes with: trace-mcp install-app`,
      };
    }

    // 2. Download to temp
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-app-'));
    const archivePath = path.join(tmpDir, asset.name);
    await downloadFile(asset.url, archivePath);

    // 3. Ensure install dir exists
    fs.mkdirSync(INSTALL_DIR, { recursive: true });

    if (isMac) {
      // 4. Remove old installation if present
      const appPath = path.join(INSTALL_DIR, APP_NAME);
      if (fs.existsSync(appPath)) {
        fs.rmSync(appPath, { recursive: true, force: true });
      }

      // 5. Unzip
      execSync(`unzip -q -o "${archivePath}" -d "${INSTALL_DIR}"`, { stdio: 'pipe' });

      // 6. Write version marker
      fs.writeFileSync(path.join(INSTALL_DIR, '.trace-mcp-version'), release!.tag, 'utf-8');

      // 7. Clean up temp
      fs.rmSync(tmpDir, { recursive: true, force: true });

      // 8. Pin to Dock
      pinToDock(appPath);

      return { installed: true, path: appPath };
    }

    // ── Windows ──
    const isExeInstaller = /\.exe$/i.test(asset.name);

    if (isExeInstaller) {
      // Run NSIS installer silently
      execSync(`"${archivePath}" /S /D=${INSTALL_DIR}`, { stdio: 'pipe', timeout: 120000 });
    } else {
      // Extract zip using PowerShell (available on all modern Windows)
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${INSTALL_DIR}' -Force"`,
        { stdio: 'pipe', timeout: 120000 },
      );
    }

    // Write version marker
    fs.writeFileSync(path.join(INSTALL_DIR, '.trace-mcp-version'), release!.tag, 'utf-8');

    // Clean up temp
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Find the exe in install dir
    const exePath = path.join(INSTALL_DIR, 'trace-mcp.exe');

    // Create Start Menu shortcut
    if (fs.existsSync(exePath)) {
      createStartMenuShortcut(exePath);
    }

    return { installed: true, path: fs.existsSync(exePath) ? exePath : INSTALL_DIR };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}

/** Check if the app is already installed */
export function isAppInstalled(): boolean {
  if (isMac) {
    return fs.existsSync(path.join(INSTALL_DIR, APP_NAME));
  }
  // Windows: check for exe in install dir
  return fs.existsSync(path.join(INSTALL_DIR, 'trace-mcp.exe'));
}

/** Read the installed app version from the marker file (e.g. "v1.20.0" → "1.20.0") */
export function getInstalledAppVersion(): string | null {
  const markerPath = path.join(INSTALL_DIR, '.trace-mcp-version');
  if (!fs.existsSync(markerPath)) return null;
  return fs.readFileSync(markerPath, 'utf-8').trim().replace(/^v/, '');
}

/** Check if the installed app is older than the current CLI version */
export function isAppOutdated(): boolean {
  const installed = getInstalledAppVersion();
  if (!installed) return true; // no marker → assume outdated
  // Read CLI version from root package.json (bundled at build time)
  const cliVersion = require('../../package.json').version as string;
  if (installed === cliVersion) return false;
  const cur = installed.split('.').map(Number);
  const cli = cliVersion.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((cli[i] || 0) > (cur[i] || 0)) return true;
    if ((cli[i] || 0) < (cur[i] || 0)) return false;
  }
  return false;
}

/** Standalone CLI command: `trace-mcp install-app` */
export const installAppCommand = new Command('install-app')
  .description('Download and install (or update) the trace-mcp menu bar app (macOS / Windows)')
  .option('--retries <n>', 'Number of retries if asset not yet uploaded', '3')
  .option('--retry-delay <ms>', 'Delay between retries in ms', '15000')
  .action(async (opts: { retries: string; retryDelay: string }) => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      console.error('Error: App installation is supported on macOS and Windows only.');
      process.exit(1);
    }

    const retries = parseInt(opts.retries, 10);
    const retryDelayMs = parseInt(opts.retryDelay, 10);

    const already = isAppInstalled();
    console.log(already ? 'Updating trace-mcp app…' : 'Installing trace-mcp app…');

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
