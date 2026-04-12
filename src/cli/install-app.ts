/**
 * Download and install the trace-mcp menu bar app from GitHub Releases.
 * macOS only — called from `trace-mcp init`.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { execSync } from 'node:child_process';

const GITHUB_REPO = 'nikolai-vysotskyi/trace-mcp';
const APP_NAME = 'trace-mcp.app';
const INSTALL_DIR = path.join(os.homedir(), 'Applications');

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
export async function installGuiApp(): Promise<InstallAppResult> {
  if (process.platform !== 'darwin') {
    return { installed: false, error: 'Menu bar app is macOS only' };
  }

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const zipPattern = new RegExp(`trace-mcp.*${arch}\\.zip$`, 'i');

  try {
    // 1. Fetch latest release
    const release = await fetchLatestRelease();

    // 2. Find matching asset
    const asset = release.assets.find((a) => zipPattern.test(a.name));
    if (!asset) {
      return { installed: false, error: `No ${arch} zip found in release ${release.tag}` };
    }

    // 3. Download to temp
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-app-'));
    const zipPath = path.join(tmpDir, asset.name);
    await downloadFile(asset.url, zipPath);

    // 4. Ensure ~/Applications exists
    fs.mkdirSync(INSTALL_DIR, { recursive: true });

    // 5. Remove old installation if present
    const appPath = path.join(INSTALL_DIR, APP_NAME);
    if (fs.existsSync(appPath)) {
      fs.rmSync(appPath, { recursive: true, force: true });
    }

    // 6. Unzip
    execSync(`unzip -q -o "${zipPath}" -d "${INSTALL_DIR}"`, { stdio: 'pipe' });

    // 7. Write version marker (used by postinstall to skip re-download)
    fs.writeFileSync(path.join(INSTALL_DIR, '.trace-mcp-version'), release.tag, 'utf-8');

    // 8. Clean up temp
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
