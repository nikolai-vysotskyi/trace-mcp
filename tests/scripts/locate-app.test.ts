import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODULE_PATH = path.join(REPO_ROOT, 'scripts', 'locate-app.mjs');

const BUNDLE_ID = 'com.trace-mcp.app';

/**
 * Build a minimal .app bundle with a matching CFBundleIdentifier. We write a
 * real XML Info.plist so the PlistBuddy path and the regex fallback both
 * resolve in CI environments — vitest runs the same suite on macOS and Linux.
 */
function createFakeBundle(parentDir: string, bundleId: string = BUNDLE_ID): string {
  const appPath = path.join(parentDir, 'trace-mcp.app');
  const contents = path.join(appPath, 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleShortVersionString</key>
  <string>9.9.9</string>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist);
  return appPath;
}

/**
 * A `mdfind` stub: a tiny shell script that echoes whatever lines we ask it
 * to. Lets us cover both the "bundle exists" and "Spotlight returns a stale
 * entry" cases without touching the real Launch Services index.
 */
function createMdfindStub(home: string, lines: string[]): string {
  const stub = path.join(home, 'mdfind-stub.sh');
  // We ignore arguments — the helper only cares about stdout content.
  const script = `#!/usr/bin/env bash\ncat <<'EOF'\n${lines.join('\n')}\nEOF\n`;
  fs.writeFileSync(stub, script, { mode: 0o755 });
  return stub;
}

/**
 * Drive locateInstalledApp via a child node process so each test owns a
 * clean process.env / module-resolution context. We pass options as JSON
 * through argv to keep the harness self-contained.
 */
function runLocate(opts: {
  homeDir: string;
  fallbackDirs: string[];
  mdfindBin?: string;
  platform?: NodeJS.Platform;
}): { result: { appPath: string; source: string } | null; stderr: string } {
  const harness = `
import { locateInstalledApp } from ${JSON.stringify(MODULE_PATH)};
const opts = JSON.parse(process.argv[2]);
const r = locateInstalledApp(opts);
process.stdout.write(JSON.stringify(r));
`;
  const harnessPath = path.join(opts.homeDir, 'locate-harness.mjs');
  fs.writeFileSync(harnessPath, harness);
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, [harnessPath, JSON.stringify(opts)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 15_000,
    });
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    stdout = e.stdout?.toString() ?? '';
    stderr = e.stderr?.toString() ?? '';
  }
  let result: { appPath: string; source: string } | null = null;
  if (stdout) {
    try {
      result = JSON.parse(stdout);
    } catch {
      result = null;
    }
  }
  return { result, stderr };
}

function runWriteMarker(home: string, appPath: string, version: string): void {
  const harness = `
import { writeAppLocationMarker } from ${JSON.stringify(MODULE_PATH)};
writeAppLocationMarker(${JSON.stringify(appPath)}, { homeDir: ${JSON.stringify(home)}, version: ${JSON.stringify(version)} });
`;
  const harnessPath = path.join(home, 'write-harness.mjs');
  fs.writeFileSync(harnessPath, harness);
  execFileSync(process.execPath, [harnessPath], { stdio: 'ignore', timeout: 10_000 });
}

describe('locateInstalledApp', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-locate-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns null on non-darwin platforms', () => {
    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [home],
      platform: 'linux',
    });
    expect(result).toBeNull();
  });

  it('prefers the marker file when it points at a valid bundle', () => {
    // Two real bundles: marker target and a fallback. Helper must pick the marker.
    const markerTarget = createFakeBundle(path.join(home, 'marker-dest'));
    const fallbackRoot = path.join(home, 'fallback-apps');
    fs.mkdirSync(fallbackRoot, { recursive: true });
    createFakeBundle(fallbackRoot);

    runWriteMarker(home, markerTarget, '1.2.3');

    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [fallbackRoot],
      // mdfind stub that would return a totally different bundle — must be ignored.
      mdfindBin: createMdfindStub(home, ['/nowhere/should-not-be-used.app']),
      platform: 'darwin',
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('marker');
    expect(result?.appPath).toBe(markerTarget);
  });

  it('rejects a marker whose bundle no longer exists, falls through to mdfind', () => {
    // Marker points at a path that was deleted between launches.
    fs.mkdirSync(path.join(home, '.trace-mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.trace-mcp', 'app-location.json'),
      JSON.stringify({
        appPath: path.join(home, 'gone', 'trace-mcp.app'),
        bundleId: BUNDLE_ID,
        version: '1.0.0',
        writtenAt: Date.now(),
      }),
    );

    const mdfindTarget = createFakeBundle(path.join(home, 'mdfind-dest'));
    const mdfindBin = createMdfindStub(home, [mdfindTarget]);

    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [],
      mdfindBin,
      platform: 'darwin',
    });

    expect(result?.source).toBe('mdfind');
    expect(result?.appPath).toBe(mdfindTarget);
  });

  it('rejects a marker whose Info.plist has the wrong bundle id', () => {
    const wrong = createFakeBundle(path.join(home, 'wrong'), 'com.someoneelse.app');
    runWriteMarker(home, wrong, '1.0.0');

    const mdfindTarget = createFakeBundle(path.join(home, 'real'));
    const mdfindBin = createMdfindStub(home, [mdfindTarget]);

    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [],
      mdfindBin,
      platform: 'darwin',
    });

    expect(result?.source).toBe('mdfind');
    expect(result?.appPath).toBe(mdfindTarget);
  });

  it('uses mdfind when no marker exists', () => {
    const mdfindTarget = createFakeBundle(path.join(home, 'launch-services-dest'));
    const mdfindBin = createMdfindStub(home, [mdfindTarget]);

    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [],
      mdfindBin,
      platform: 'darwin',
    });

    expect(result?.source).toBe('mdfind');
    expect(result?.appPath).toBe(mdfindTarget);
  });

  it('skips stale mdfind hits whose bundle was deleted', () => {
    // First mdfind result is a path that does not exist; second is valid.
    const realTarget = createFakeBundle(path.join(home, 'real'));
    const mdfindBin = createMdfindStub(home, [
      path.join(home, 'deleted', 'trace-mcp.app'),
      realTarget,
    ]);

    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [],
      mdfindBin,
      platform: 'darwin',
    });

    expect(result?.source).toBe('mdfind');
    expect(result?.appPath).toBe(realTarget);
  });

  it('falls back to conventional dirs when marker and mdfind both miss', () => {
    const conventionalDir = path.join(home, 'system-applications');
    fs.mkdirSync(conventionalDir, { recursive: true });
    const target = createFakeBundle(conventionalDir);

    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [conventionalDir],
      // mdfind stub returns nothing.
      mdfindBin: createMdfindStub(home, []),
      platform: 'darwin',
    });

    expect(result?.source).toBe('fallback');
    expect(result?.appPath).toBe(target);
  });

  it('returns null when nothing resolves', () => {
    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [path.join(home, 'nowhere')],
      mdfindBin: createMdfindStub(home, []),
      platform: 'darwin',
    });
    expect(result).toBeNull();
  });

  it('writeAppLocationMarker round-trips through the marker reader', () => {
    const target = createFakeBundle(path.join(home, 'bundle-here'));
    runWriteMarker(home, target, '1.39.5');

    const markerRaw = fs.readFileSync(path.join(home, '.trace-mcp', 'app-location.json'), 'utf-8');
    const parsed = JSON.parse(markerRaw);
    expect(parsed.appPath).toBe(target);
    expect(parsed.bundleId).toBe(BUNDLE_ID);
    expect(parsed.version).toBe('1.39.5');
    expect(typeof parsed.writtenAt).toBe('number');

    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [],
      mdfindBin: createMdfindStub(home, []),
      platform: 'darwin',
    });
    expect(result?.source).toBe('marker');
    expect(result?.appPath).toBe(target);
  });
});
