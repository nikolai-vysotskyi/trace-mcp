// Rollback semantics for the auto-updater — verifies that a failed `npm
// install` retry can never brick the install by destroying the package dir.
//
// Unlike `tests/updater.test.ts` which mocks `node:fs` wholesale to track
// cache writes, this suite uses REAL `node:fs` against a temp dir so we can
// observe the actual rename/restore filesystem state. `node:child_process` is
// still mocked so we don't shell out to the npm registry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:https', () => ({ get: vi.fn() }));

// Mock dynamic-import targets so post-update migrations never trigger here.
vi.mock('../src/config-jsonc.js', () => ({
  migrateGlobalConfig: vi.fn(() => ({ changed: false, added: [] })),
}));
vi.mock('../src/init/detector.js', () => ({
  detectGuardHook: vi.fn(() => ({ hasGuardHook: false, guardHookVersion: null })),
}));
vi.mock('../src/init/hooks.js', () => ({
  installGuardHook: vi.fn(),
  installReindexHook: vi.fn(),
  installPrecompactHook: vi.fn(),
  installWorktreeHook: vi.fn(),
}));
vi.mock('../src/init/claude-md.js', () => ({
  updateClaudeMd: vi.fn(),
}));
vi.mock('../src/registry.js', () => ({
  listProjects: vi.fn(() => []),
  updateLastIndexed: vi.fn(),
}));

// Capture warn/error log payloads so tests can assert on user-facing messages.
const warnLogs: Array<Record<string, unknown>> = [];
const errorLogs: Array<Record<string, unknown>> = [];
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((obj: unknown) => {
      if (obj && typeof obj === 'object') warnLogs.push(obj as Record<string, unknown>);
      else warnLogs.push({ _msg: String(obj) });
    }),
    error: vi.fn((obj: unknown) => {
      if (obj && typeof obj === 'object') errorLogs.push(obj as Record<string, unknown>);
      else errorLogs.push({ _msg: String(obj) });
    }),
  },
}));

// TRACE_MCP_HOME stub — must be a module-level constant the updater can read.
// Pointed at a per-test subdir via the global override below.
const HOME_REF = { current: '' };
vi.mock('../src/global.js', () => ({
  get TRACE_MCP_HOME() {
    return HOME_REF.current;
  },
  ensureGlobalDirs: vi.fn(),
  getDbPath: vi.fn((root: string) => path.join(root, '.trace-mcp.db')),
}));

// Real-fs atomic write so we can read back what the updater stamped.
vi.mock('../src/utils/atomic-write.js', () => ({
  atomicWriteString: (target: string, payload: string) => fs.writeFileSync(target, payload),
  atomicWriteJson: (target: string, data: unknown) =>
    fs.writeFileSync(target, JSON.stringify(data)),
}));

describe('checkAndInstallUpdate — backup + rollback', () => {
  let checkAndInstallUpdate: typeof import('../src/updater.js').checkAndInstallUpdate;
  let tmpRoot: string;
  let mainDir: string;
  let cachePath: string;
  let installCallCount: number;
  let installResults: Array<{ status: number; stderr: string; sideEffect?: () => void }>;

  beforeEach(async () => {
    vi.resetModules();
    warnLogs.length = 0;
    errorLogs.length = 0;
    installCallCount = 0;
    installResults = [];

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-updater-rollback-'));
    mainDir = path.join(tmpRoot, 'trace-mcp');
    const traceMcpHome = path.join(tmpRoot, '.trace-mcp');
    fs.mkdirSync(traceMcpHome, { recursive: true });
    HOME_REF.current = traceMcpHome;
    cachePath = path.join(traceMcpHome, 'update-check.json');

    // Seed cache so updater skips registry fetch and uses 2.0.0 immediately.
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ lastChecked: Date.now(), latestVersion: '2.0.0' }),
    );

    const { spawnSync } = await import('node:child_process');
    vi.mocked(spawnSync).mockImplementation(((cmd: string, args: readonly string[]) => {
      const argList = Array.isArray(args) ? args : [];
      const isNpmRootProbe =
        (cmd === 'npm' && argList[0] === 'root' && argList[1] === '-g') ||
        argList.some((a) => typeof a === 'string' && a.includes('npm root -g'));
      if (isNpmRootProbe) {
        return {
          status: 0,
          stdout: `${tmpRoot}\n`,
          stderr: '',
          pid: 0,
          output: [],
          signal: null,
        } as unknown as ReturnType<typeof spawnSync>;
      }
      // Install call — pop the next staged result.
      const r =
        installResults[installCallCount] ??
        installResults[installResults.length - 1] ??
        ({ status: 0, stderr: '' } as { status: number; stderr: string });
      installCallCount++;
      r.sideEffect?.();
      return {
        status: r.status,
        stdout: '',
        stderr: r.stderr,
        pid: 0,
        output: [],
        signal: null,
      } as unknown as ReturnType<typeof spawnSync>;
    }) as typeof spawnSync);

    (globalThis as Record<string, unknown>).PKG_VERSION_INJECTED = '1.0.0';
    // Bypass the `.git`-next-to-package-json dev-checkout guard — tests run
    // from the source repo so the guard would short-circuit the install path.
    process.env.TRACE_MCP_FORCE_NOT_DEV_CHECKOUT = '1';
    delete process.env.TRACE_MCP_NO_AUTO_UPDATE;
    // Re-import so updater.ts reads our overridden TRACE_MCP_HOME.
    const mod = await import('../src/updater.js');
    checkAndInstallUpdate = mod.checkAndInstallUpdate;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).PKG_VERSION_INJECTED = undefined;
    delete process.env.TRACE_MCP_FORCE_NOT_DEV_CHECKOUT;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  function seedInstalledPackage(marker = 'v1.0.0-marker') {
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(path.join(mainDir, 'marker.txt'), marker);
  }

  function listBackups(): string[] {
    return fs.readdirSync(tmpRoot).filter((e) => e.startsWith('trace-mcp.tmcp-bak-'));
  }

  it('rolls back from backup when retry install also fails', async () => {
    seedInstalledPackage();
    // First install: ENOTEMPTY (triggers backup). Second install: also fails
    // (e.g. network blip mid-extract). Rollback MUST restore the original.
    installResults = [
      { status: 1, stderr: 'npm ERR! ENOTEMPTY: directory not empty' },
      {
        status: 1,
        stderr: 'npm ERR! ENETUNREACH',
        // Simulate npm partially creating then aborting — leaves a stub dir.
        sideEffect: () => {
          fs.mkdirSync(mainDir, { recursive: true });
          fs.writeFileSync(path.join(mainDir, 'partial.txt'), 'half-extracted');
        },
      },
    ];

    const result = await checkAndInstallUpdate({ checkIntervalHours: 24 });
    expect(result).toBe(false);

    // The original package dir MUST be intact. Production-critical invariant.
    expect(fs.existsSync(mainDir)).toBe(true);
    expect(fs.readFileSync(path.join(mainDir, 'marker.txt'), 'utf-8')).toBe('v1.0.0-marker');
    expect(fs.existsSync(path.join(mainDir, 'partial.txt'))).toBe(false);

    // No leftover backup dir.
    expect(listBackups()).toEqual([]);

    // User-facing warn telling them the install was rolled back.
    const restoredMsg = warnLogs.find(
      (l) => 'version' in l && l.version === '2.0.0' && !('error' in l),
    );
    expect(restoredMsg).toBeDefined();
  });

  it('cleans up backup when retry install succeeds', async () => {
    seedInstalledPackage();
    installResults = [
      { status: 1, stderr: 'npm ERR! ENOTEMPTY: directory not empty' },
      {
        status: 0,
        stderr: '',
        sideEffect: () => {
          // Simulate npm laying down the new package.
          fs.mkdirSync(mainDir, { recursive: true });
          fs.writeFileSync(path.join(mainDir, 'marker.txt'), 'v2.0.0-fresh');
        },
      },
    ];

    const result = await checkAndInstallUpdate({ checkIntervalHours: 24 });
    expect(result).toBe(true);

    expect(fs.existsSync(mainDir)).toBe(true);
    expect(fs.readFileSync(path.join(mainDir, 'marker.txt'), 'utf-8')).toBe('v2.0.0-fresh');
    expect(listBackups()).toEqual([]);
  });

  it('restores stale backup from a dead PID when main dir is missing', async () => {
    // Previous updater crashed mid-rename: main gone, backup from dead PID lingers.
    const deadPid = 999_999_999; // process.kill(pid, 0) → ESRCH
    const backupDir = path.join(tmpRoot, `trace-mcp.tmcp-bak-${deadPid}`);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'marker.txt'), 'recovered-from-backup');
    expect(fs.existsSync(mainDir)).toBe(false);

    installResults = [{ status: 0, stderr: '' }];

    await checkAndInstallUpdate({ checkIntervalHours: 24 });

    // The reconcile pass moved the backup back into place before install ran.
    expect(fs.existsSync(mainDir)).toBe(true);
    expect(fs.readFileSync(path.join(mainDir, 'marker.txt'), 'utf-8')).toBe(
      'recovered-from-backup',
    );
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('removes stale backup garbage when main dir is present', async () => {
    seedInstalledPackage();
    const deadPid = 999_999_999;
    const backupDir = path.join(tmpRoot, `trace-mcp.tmcp-bak-${deadPid}`);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'marker.txt'), 'leftover-garbage');

    installResults = [{ status: 0, stderr: '' }];

    await checkAndInstallUpdate({ checkIntervalHours: 24 });

    // Main dir untouched, garbage backup wiped.
    expect(fs.existsSync(mainDir)).toBe(true);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it('does not crash when original package dir is missing and install fails', async () => {
    expect(fs.existsSync(mainDir)).toBe(false);
    installResults = [
      { status: 1, stderr: 'npm ERR! ENOTEMPTY: directory not empty' },
      { status: 1, stderr: 'npm ERR! ENETUNREACH' },
    ];

    const result = await checkAndInstallUpdate({ checkIntervalHours: 24 });
    expect(result).toBe(false);
    expect(fs.existsSync(mainDir)).toBe(false);
    expect(listBackups()).toEqual([]);
  });

  it('switches to long back-off after 3 consecutive failed installs for same version', async () => {
    // Seed cache showing 2 prior failures for v2.0.0 — this run is the 3rd.
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        lastChecked: Date.now() - 10 * 60 * 60 * 1000, // 10 h ago, well past 1 h window
        latestVersion: '2.0.0',
        lastFailedInstall: Date.now() - 10 * 60 * 60 * 1000,
        lastFailedVersion: '2.0.0',
        consecutiveFailedInstalls: 2,
      }),
    );

    seedInstalledPackage();
    installResults = [{ status: 1, stderr: 'npm ERR! ENETUNREACH' }];

    const result = await checkAndInstallUpdate({ checkIntervalHours: 24 });
    expect(result).toBe(false);

    const written = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(written.consecutiveFailedInstalls).toBe(3);
    expect(written.lastFailedVersion).toBe('2.0.0');

    // The "disabled until manual intervention" warning must have fired.
    const disabledWarn = warnLogs.find(
      (l) => 'consecutiveFailedInstalls' in l && l.consecutiveFailedInstalls === 3,
    );
    expect(disabledWarn).toBeDefined();
  });

  it('honors long back-off window after threshold is reached', async () => {
    // 3 prior failures, last attempt 2 days ago. 1 h window expired but 7 d window holds.
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        lastChecked: Date.now() - 2 * 24 * 60 * 60 * 1000,
        latestVersion: '2.0.0',
        lastFailedInstall: Date.now() - 2 * 24 * 60 * 60 * 1000,
        lastFailedVersion: '2.0.0',
        consecutiveFailedInstalls: 3,
      }),
    );

    seedInstalledPackage();
    installResults = [{ status: 0, stderr: '' }];

    const result = await checkAndInstallUpdate({ checkIntervalHours: 24 });
    expect(result).toBe(false);
    // No install attempt — back-off blocked it.
    expect(installCallCount).toBe(0);
  });
});
