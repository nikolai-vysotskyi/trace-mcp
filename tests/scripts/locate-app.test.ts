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

// Locates the installed macOS .app bundle by shelling out to mdfind / mdls /
// PlistBuddy. Even with platform injected as 'darwin', a Windows host can't
// resolve those tools or .app/Info.plist semantics, so the suite only runs on
// macOS/Linux hosts. CLI/server Windows support is unaffected.
describe.skipIf(process.platform === 'win32')('locateInstalledApp', () => {
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

  /* TRA-667: `src/global.ts` renames ~/.trace-mcp to ~/.trace on first import, so
     after the migration the old directory is gone. A resolver hardcoded to it
     reads nothing and silently degrades to an mdfind/fallback guess. */
  it('reads the marker from ~/.trace once the CLI has migrated', () => {
    const markerTarget = createFakeBundle(path.join(home, 'marker-dest'));
    fs.mkdirSync(path.join(home, '.trace'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.trace', 'app-location.json'),
      JSON.stringify({
        appPath: markerTarget,
        bundleId: BUNDLE_ID,
        version: '1.2.3',
        writtenAt: Date.now(),
      }),
    );

    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [],
      mdfindBin: createMdfindStub(home, ['/nowhere/should-not-be-used.app']),
      platform: 'darwin',
    });

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

  // TRA-357: a bundle produced by `electron-builder` inside a checkout is a
  // fully packaged .app with the right bundle id, so plist validation accepts
  // it. Once it reached the marker, every later `npm install -g` "updated" a
  // throwaway directory and the user's real install froze for three majors.
  it('rejects a marker pointing into a build tree and falls back to the real install', () => {
    const buildTree = path.join(home, 'checkout', 'packages', 'app', 'release', 'mac-arm64');
    fs.mkdirSync(buildTree, { recursive: true });
    const builtBundle = createFakeBundle(buildTree);

    const installDir = path.join(home, 'Applications');
    fs.mkdirSync(installDir, { recursive: true });
    const installed = createFakeBundle(installDir);

    // Written by hand: writeAppLocationMarker now refuses such a path outright.
    fs.mkdirSync(path.join(home, '.trace-mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.trace-mcp', 'app-location.json'),
      JSON.stringify({ appPath: builtBundle, bundleId: BUNDLE_ID, version: '1.51.1' }),
    );

    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [installDir],
      // Spotlight indexes build outputs too — the same filter must drop them.
      mdfindBin: createMdfindStub(home, [builtBundle]),
      platform: 'darwin',
    });

    expect(result?.appPath).toBe(installed);
    expect(result?.source).toBe('fallback');
  });

  it('rejects a marker inside a git checkout even without a build-tree segment', () => {
    const checkout = path.join(home, 'scratch-checkout');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    const inCheckout = createFakeBundle(checkout);
    fs.mkdirSync(path.join(home, '.trace-mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.trace-mcp', 'app-location.json'),
      JSON.stringify({ appPath: inCheckout, bundleId: BUNDLE_ID, version: '1.51.1' }),
    );

    const { result } = runLocate({
      homeDir: home,
      fallbackDirs: [],
      mdfindBin: createMdfindStub(home, []),
      platform: 'darwin',
    });

    expect(result).toBeNull();
  });

  it('writeAppLocationMarker refuses to record a locally built bundle', () => {
    const buildTree = path.join(home, 'proj', 'packages', 'app', 'release', 'mac-arm64');
    fs.mkdirSync(buildTree, { recursive: true });
    const builtBundle = createFakeBundle(buildTree);

    runWriteMarker(home, builtBundle, '1.51.1');

    expect(fs.existsSync(path.join(home, '.trace-mcp', 'app-location.json'))).toBe(false);
  });

  it('writeAppLocationMarker writes into ~/.trace once the CLI has migrated', () => {
    fs.mkdirSync(path.join(home, '.trace'), { recursive: true });
    const target = createFakeBundle(path.join(home, 'bundle-here'));

    runWriteMarker(home, target, '1.51.1');

    expect(fs.existsSync(path.join(home, '.trace', 'app-location.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.trace-mcp'))).toBe(false);
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

/**
 * A `pgrep -f` stub printing the pids we hand it, and a `ps -p <pid> -o comm=`
 * stub mapping each pid to an executable path. Together they stand in for a
 * running Electron bundle without launching one.
 */
function createProcStubs(
  home: string,
  procs: Record<string, string>,
): { pgrepBin: string; psBin: string } {
  const pids = Object.keys(procs);
  const pgrepBin = path.join(home, 'pgrep-stub.sh');
  // pgrep exits 1 when nothing matches; the caller must treat that as "none".
  fs.writeFileSync(
    pgrepBin,
    pids.length === 0
      ? '#!/usr/bin/env bash\nexit 1\n'
      : `#!/usr/bin/env bash\ncat <<'EOF'\n${pids.join('\n')}\nEOF\n`,
    { mode: 0o755 },
  );

  const psBin = path.join(home, 'ps-stub.sh');
  const cases = pids.map((pid) => `  ${pid}) echo ${JSON.stringify(procs[pid])} ;;`).join('\n');
  // Args arrive as `-p <pid> -o comm=`, so $2 is the pid.
  fs.writeFileSync(psBin, `#!/usr/bin/env bash\ncase "$2" in\n${cases}\n  *) exit 1 ;;\nesac\n`, {
    mode: 0o755,
  });
  return { pgrepBin, psBin };
}

function runRunningBundlePath(opts: {
  homeDir: string;
  pgrepBin: string;
  psBin: string;
  platform?: NodeJS.Platform;
}): string | null {
  const harness = `
import { runningBundlePath } from ${JSON.stringify(MODULE_PATH)};
const opts = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify(runningBundlePath(opts)));
`;
  const harnessPath = path.join(opts.homeDir, 'running-harness.mjs');
  fs.writeFileSync(harnessPath, harness);
  const stdout = execFileSync(process.execPath, [harnessPath, JSON.stringify(opts)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return JSON.parse(stdout) as string | null;
}

// TRA-506: with a bundle in /Applications and another in ~/Applications, the
// location marker and the running app named different copies. postinstall
// staged the pending zip beside the marker's bundle, the running one never saw
// it, and the machine sat two releases behind while npm reported success — the
// state this was written against had a 112 MB orphan zip to prove it.
describe.skipIf(process.platform === 'win32')('runningBundlePath', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-running-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('resolves the .app of a running process', () => {
    const dragged = createFakeBundle(path.join(home, 'Applications-system'));
    const { pgrepBin, psBin } = createProcStubs(home, {
      '4242': path.join(dragged, 'Contents', 'MacOS', 'trace-mcp'),
    });

    expect(runRunningBundlePath({ homeDir: home, pgrepBin, psBin, platform: 'darwin' })).toBe(
      dragged,
    );
  });

  it('returns null when nothing is running', () => {
    const { pgrepBin, psBin } = createProcStubs(home, {});
    expect(runRunningBundlePath({ homeDir: home, pgrepBin, psBin, platform: 'darwin' })).toBeNull();
  });

  it('ignores a bundle running out of a build tree', () => {
    const built = createFakeBundle(
      (() => {
        const d = path.join(home, 'checkout', 'packages', 'app', 'release', 'mac-arm64');
        fs.mkdirSync(d, { recursive: true });
        return d;
      })(),
    );
    const { pgrepBin, psBin } = createProcStubs(home, {
      '77': path.join(built, 'Contents', 'MacOS', 'trace-mcp'),
    });

    expect(runRunningBundlePath({ homeDir: home, pgrepBin, psBin, platform: 'darwin' })).toBeNull();
  });

  it('skips a process whose bundle id does not match and takes the next one', () => {
    const foreign = createFakeBundle(path.join(home, 'Other'), 'com.someone-else.app');
    const real = createFakeBundle(path.join(home, 'Applications'));
    const { pgrepBin, psBin } = createProcStubs(home, {
      '1': path.join(foreign, 'Contents', 'MacOS', 'trace-mcp'),
      '2': path.join(real, 'Contents', 'MacOS', 'trace-mcp'),
    });

    expect(runRunningBundlePath({ homeDir: home, pgrepBin, psBin, platform: 'darwin' })).toBe(real);
  });

  it('returns null on non-darwin platforms', () => {
    const app = createFakeBundle(path.join(home, 'Applications'));
    const { pgrepBin, psBin } = createProcStubs(home, {
      '9': path.join(app, 'Contents', 'MacOS', 'trace-mcp'),
    });

    expect(runRunningBundlePath({ homeDir: home, pgrepBin, psBin, platform: 'linux' })).toBeNull();
  });
});

// isInstalledApp is pure — no env, no marker, no subprocess of its own — so it
// is imported directly instead of going through the harnesses above.
describe.skipIf(process.platform === 'win32')('isInstalledApp', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-installed-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('accepts a valid bundle in a plausible install directory', async () => {
    const { isInstalledApp } = await import(MODULE_PATH);
    expect(isInstalledApp(createFakeBundle(path.join(home, 'Applications')))).toBe(true);
  });

  it('rejects a valid bundle sitting in a build tree', async () => {
    const { isInstalledApp } = await import(MODULE_PATH);
    const dir = path.join(home, 'checkout', 'packages', 'app', 'release', 'mac-arm64');
    fs.mkdirSync(dir, { recursive: true });
    expect(isInstalledApp(createFakeBundle(dir))).toBe(false);
  });

  it('rejects a plausible path whose bundle id is not ours', async () => {
    const { isInstalledApp } = await import(MODULE_PATH);
    const foreign = createFakeBundle(path.join(home, 'Applications'), 'com.someone-else.app');
    expect(isInstalledApp(foreign)).toBe(false);
  });

  it('rejects a plausible path with no bundle at all', async () => {
    const { isInstalledApp } = await import(MODULE_PATH);
    expect(isInstalledApp(path.join(home, 'Applications', 'trace-mcp.app'))).toBe(false);
  });
});
