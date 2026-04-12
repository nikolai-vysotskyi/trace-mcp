#!/usr/bin/env node
/**
 * postinstall hook for `npm install -g trace-mcp`.
 * If the Electron menu bar app is already installed in ~/Applications/,
 * re-download the latest release zip and replace it — so `npm update -g`
 * automatically keeps the GUI app in sync.
 *
 * Runs silently — never fails the install (all errors are swallowed).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import { execSync } from 'node:child_process';

const APP_NAME = 'trace-mcp.app';
const INSTALL_DIR = path.join(os.homedir(), 'Applications');
const APP_PATH = path.join(INSTALL_DIR, APP_NAME);
const GITHUB_REPO = 'nikolai-vysotskyi/trace-mcp';

// Only run on macOS and only if app is already installed
if (process.platform !== 'darwin' || !fs.existsSync(APP_PATH)) {
  process.exit(0);
}

/** Simple HTTPS GET that follows redirects and returns the body. */
function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const doGet = (target, redirects = 0) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return; }
      const mod = target.startsWith('https') ? https : http;
      mod.get(target, { timeout: timeoutMs, headers: { 'User-Agent': 'trace-mcp', Accept: 'application/vnd.github.v3+json' } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          doGet(res.headers.location, redirects + 1);
          return;
        }
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(body));
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    };
    doGet(url);
  });
}

/** Download a file to disk, following redirects. */
function downloadFile(url, dest, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const doGet = (target, redirects = 0) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return; }
      https.get(target, { timeout: timeoutMs, headers: { 'User-Agent': 'trace-mcp' } }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          doGet(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    };
    doGet(url);
  });
}

async function main() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const zipPattern = new RegExp(`trace-mcp.*${arch}\\.zip$`, 'i');

  // Fetch latest release
  const body = await httpGet(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  const release = JSON.parse(body);
  if (!release.tag_name || !release.assets) return;

  const asset = release.assets.find((a) => zipPattern.test(a.name));
  if (!asset) return;

  // Check if already up to date (compare tag stored in a marker file)
  const markerPath = path.join(INSTALL_DIR, '.trace-mcp-version');
  if (fs.existsSync(markerPath)) {
    const installed = fs.readFileSync(markerPath, 'utf-8').trim();
    if (installed === release.tag_name) return; // already current
  }

  // Download zip to temp
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-update-'));
  const zipPath = path.join(tmpDir, asset.name);
  await downloadFile(asset.browser_download_url, zipPath);

  // Remove old app and unzip new one
  fs.rmSync(APP_PATH, { recursive: true, force: true });
  execSync(`unzip -q -o "${zipPath}" -d "${INSTALL_DIR}"`, { stdio: 'pipe' });

  // Write version marker
  fs.writeFileSync(markerPath, release.tag_name, 'utf-8');

  // Clean up temp
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`  trace-mcp app updated to ${release.tag_name}`);
}

main().catch(() => {
  // Never fail the npm install
});
