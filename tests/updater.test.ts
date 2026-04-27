import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mock fs before importing the module under test
vi.mock('node:fs');
vi.mock('node:https');
vi.mock('node:child_process');

// Mock all dynamic-import targets so runPostUpdateMigrations doesn't need real modules
vi.mock('../src/config-jsonc.js', () => ({
  migrateGlobalConfig: vi.fn(() => ({ changed: false, added: [] })),
}));
vi.mock('../src/init/detector.js', () => ({
  detectGuardHook: vi.fn(() => ({ hasGuardHook: true, guardHookVersion: '0.5.0' })),
}));
vi.mock('../src/init/hooks.js', () => ({
  installGuardHook: vi.fn(() => ({ target: 'guard', action: 'updated' })),
  installReindexHook: vi.fn(() => ({ target: 'reindex', action: 'updated' })),
  installPrecompactHook: vi.fn(() => ({ target: 'precompact', action: 'updated' })),
  installWorktreeHook: vi.fn(() => [{ target: 'worktree', action: 'updated' }]),
}));
vi.mock('../src/init/claude-md.js', () => ({
  updateClaudeMd: vi.fn(() => ({ target: 'claude-md', action: 'updated' })),
}));
vi.mock('../src/registry.js', () => ({
  listProjects: vi.fn(() => []),
  updateLastIndexed: vi.fn(),
}));
vi.mock('../src/global.js', () => ({
  TRACE_MCP_HOME: '/tmp/test-trace-mcp',
  ensureGlobalDirs: vi.fn(),
  getDbPath: vi.fn((root: string) => path.join(root, '.trace-mcp.db')),
}));
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockFs = vi.mocked(fs);

const CACHE_PATH = path.join('/tmp/test-trace-mcp', 'update-check.json');

// Helper to write a fake cache that readCache will return
function setupCache(cache: Record<string, unknown> | null) {
  if (cache === null) {
    mockFs.existsSync.mockReturnValue(false);
  } else {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      if (String(p) === CACHE_PATH) return true;
      return false;
    });
    mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p) === CACHE_PATH) return JSON.stringify(cache);
      return '{}';
    });
  }
}

// Track what was written to the cache (returns the LAST write)
function getWrittenCache(): Record<string, unknown> | null {
  let last: Record<string, unknown> | null = null;
  for (const call of mockFs.writeFileSync.mock.calls) {
    if (String(call[0]) === CACHE_PATH) {
      last = JSON.parse(String(call[1])) as Record<string, unknown>;
    }
  }
  return last;
}

describe('runPostUpdateMigrations', () => {
  let runPostUpdateMigrations: typeof import('../src/updater.js').runPostUpdateMigrations;

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    mockFs.writeFileSync.mockImplementation(() => {});

    // Inject a non-dev version so the function doesn't early-return
    (globalThis as Record<string, unknown>).PKG_VERSION_INJECTED = '2.0.0';
    const mod = await import('../src/updater.js');
    runPostUpdateMigrations = mod.runPostUpdateMigrations;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).PKG_VERSION_INJECTED;
    vi.restoreAllMocks();
  });

  it('no-ops when cache file does not exist', async () => {
    setupCache(null);
    await runPostUpdateMigrations();
    // Should not write anything
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('stamps installedVersion on first run (no installedVersion in cache)', async () => {
    setupCache({ lastChecked: Date.now(), latestVersion: '2.0.0' });
    await runPostUpdateMigrations();
    const written = getWrittenCache();
    expect(written).not.toBeNull();
    expect(written!.installedVersion).toBe('2.0.0');
  });

  it('no-ops when installedVersion matches CURRENT_VERSION', async () => {
    setupCache({ lastChecked: Date.now(), latestVersion: '2.0.0', installedVersion: '2.0.0' });
    await runPostUpdateMigrations();
    // Should not import hooks or write cache
    const { migrateGlobalConfig } = await import('../src/config-jsonc.js');
    expect(migrateGlobalConfig).not.toHaveBeenCalled();
  });

  it('runs migrations when version changed', async () => {
    setupCache({ lastChecked: Date.now(), latestVersion: '2.0.0', installedVersion: '1.9.0' });
    await runPostUpdateMigrations();

    // Should have called migrateGlobalConfig
    const { migrateGlobalConfig } = await import('../src/config-jsonc.js');
    expect(migrateGlobalConfig).toHaveBeenCalled();

    // Should have called hook installers
    const { installGuardHook, installReindexHook, installPrecompactHook, installWorktreeHook } =
      await import('../src/init/hooks.js');
    expect(installGuardHook).toHaveBeenCalledWith({ global: true });
    expect(installReindexHook).toHaveBeenCalledWith({ global: true });
    expect(installPrecompactHook).toHaveBeenCalledWith({ global: true });
    expect(installWorktreeHook).toHaveBeenCalledWith({ global: true });

    // Should have called updateClaudeMd
    const { updateClaudeMd } = await import('../src/init/claude-md.js');
    expect(updateClaudeMd).toHaveBeenCalled();

    // Should stamp new version in cache
    const written = getWrittenCache();
    expect(written).not.toBeNull();
    expect(written!.installedVersion).toBe('2.0.0');
  });

  it('skips hooks when no guard hook is installed', async () => {
    setupCache({ lastChecked: Date.now(), latestVersion: '2.0.0', installedVersion: '1.9.0' });

    // Override detectGuardHook to return false
    const detector = await import('../src/init/detector.js');
    vi.mocked(detector.detectGuardHook).mockReturnValue({
      hasGuardHook: false,
      guardHookVersion: null,
    });

    await runPostUpdateMigrations();

    const { installGuardHook } = await import('../src/init/hooks.js');
    expect(installGuardHook).not.toHaveBeenCalled();

    // But CLAUDE.md should still be updated
    const { updateClaudeMd } = await import('../src/init/claude-md.js');
    expect(updateClaudeMd).toHaveBeenCalled();
  });

  it('continues on hook install failure', async () => {
    setupCache({ lastChecked: Date.now(), latestVersion: '2.0.0', installedVersion: '1.9.0' });

    const hooks = await import('../src/init/hooks.js');
    vi.mocked(hooks.installGuardHook).mockImplementation(() => {
      throw new Error('hook fail');
    });

    // Should not throw
    await runPostUpdateMigrations();

    // Should still update CLAUDE.md and stamp version
    const { updateClaudeMd } = await import('../src/init/claude-md.js');
    expect(updateClaudeMd).toHaveBeenCalled();
    const written = getWrittenCache();
    expect(written!.installedVersion).toBe('2.0.0');
  });

  it('continues on CLAUDE.md update failure', async () => {
    setupCache({ lastChecked: Date.now(), latestVersion: '2.0.0', installedVersion: '1.9.0' });

    const claudeMd = await import('../src/init/claude-md.js');
    vi.mocked(claudeMd.updateClaudeMd).mockImplementation(() => {
      throw new Error('claude-md fail');
    });

    await runPostUpdateMigrations();

    // Should still stamp version
    const written = getWrittenCache();
    expect(written!.installedVersion).toBe('2.0.0');
  });
});

describe('checkAndInstallUpdate', () => {
  let checkAndInstallUpdate: typeof import('../src/updater.js').checkAndInstallUpdate;

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    mockFs.writeFileSync.mockImplementation(() => {});

    (globalThis as Record<string, unknown>).PKG_VERSION_INJECTED = '1.0.0';
    const mod = await import('../src/updater.js');
    checkAndInstallUpdate = mod.checkAndInstallUpdate;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).PKG_VERSION_INJECTED;
    vi.restoreAllMocks();
  });

  it('skips install when previous attempt for same version failed recently', async () => {
    const now = Date.now();
    // Cache records a recent failed install for the exact version we'd retry.
    setupCache({
      lastChecked: now,
      latestVersion: '2.0.0',
      lastFailedInstall: now - 60 * 1000, // 1 minute ago
      lastFailedVersion: '2.0.0',
    });

    const { spawnSync } = await import('node:child_process');
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    });

    const result = await checkAndInstallUpdate({ checkIntervalHours: 24 });
    expect(result).toBe(false);
    // Must NOT have attempted npm install (no spawnSync call for `npm install`).
    const installCalls = vi
      .mocked(spawnSync)
      .mock.calls.filter((c) => Array.isArray(c[1]) && c[1].includes('install'));
    expect(installCalls).toHaveLength(0);
  });

  it('records lastFailedInstall when npm install fails', async () => {
    setupCache({ lastChecked: Date.now(), latestVersion: '2.0.0' });

    const { spawnSync } = await import('node:child_process');
    // Every spawnSync call (npm root probe + install attempts) returns failure.
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'npm error something broke',
      pid: 0,
      output: [],
      signal: null,
    });

    const result = await checkAndInstallUpdate({ checkIntervalHours: 24 });
    expect(result).toBe(false);

    const written = getWrittenCache();
    expect(written).not.toBeNull();
    expect(written!.lastFailedVersion).toBe('2.0.0');
    expect(typeof written!.lastFailedInstall).toBe('number');
  });

  it('saves installedVersion in cache after successful update', async () => {
    // Cache says a newer version exists and interval expired
    setupCache({ lastChecked: 0, latestVersion: '2.0.0' });

    // Mock npm install success
    const { spawnSync } = await import('node:child_process');
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    });

    // Mock fetchLatestVersion to return 2.0.0
    const https = await import('node:https');
    vi.mocked(https.get).mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (res: {
        on: (event: string, handler: (data?: string) => void) => void;
      }) => void;
      callback({
        on: (event: string, handler: (data?: string) => void) => {
          if (event === 'data') handler(JSON.stringify({ version: '2.0.0' }));
          if (event === 'end') handler();
        },
      });
      return { on: vi.fn(), destroy: vi.fn() } as unknown as ReturnType<typeof https.get>;
    });

    const result = await checkAndInstallUpdate({ checkIntervalHours: 0 });
    expect(result).toBe(true);

    // The cache should include installedVersion
    const written = getWrittenCache();
    expect(written).not.toBeNull();
    expect(written!.installedVersion).toBe('2.0.0');
  });
});
