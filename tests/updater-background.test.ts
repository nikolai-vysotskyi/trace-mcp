// TRA-703 regression: the auto-update must never sit on the startup path.
//
// Before this, `trace-mcp serve` awaited checkAndInstallUpdate() before wiring
// the stdio transport. On the first session after any release that meant the
// whole startup was spent inside `npm install`, the `initialize` request was
// never answered, and the MCP client marked the server `failed` for the entire
// session. These tests pin the two properties that fix depends on:
//
//   1. scheduleBackgroundUpdate() returns without doing any update work, so
//      everything the caller does next (including answering `initialize`)
//      happens first.
//   2. A successful install does NOT exit the process — the new version takes
//      effect on the next start, never mid-session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:https', () => ({ get: vi.fn() }));

// Post-update migrations reach for these lazily; stub them so nothing reindexes.
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
  installMirrorHook: vi.fn(),
  isMirrorHookInstalled: vi.fn(() => false),
  migrateLegacyToolPrefix: vi.fn(() => []),
}));
vi.mock('../src/init/claude-md.js', () => ({ updateClaudeMd: vi.fn() }));
vi.mock('../src/registry.js', () => ({
  listProjects: vi.fn(() => []),
  updateLastIndexed: vi.fn(),
  markAllProjectsPendingReindex: vi.fn(() => 0),
  clearPendingReindex: vi.fn(),
  getProject: vi.fn(() => null),
}));

const HOME_REF = { current: '' };
vi.mock('../src/global.js', () => ({
  get TRACE_MCP_HOME() {
    return HOME_REF.current;
  },
  ensureGlobalDirs: vi.fn(),
  getDbPath: vi.fn((root: string) => path.join(root, '.trace-mcp.db')),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('scheduleBackgroundUpdate (TRA-703)', () => {
  let tmpHome: string;
  let scheduleBackgroundUpdate: typeof import('../src/updater.js').scheduleBackgroundUpdate;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tra703-'));
    HOME_REF.current = tmpHome;
    // A newer version is already known, so the updater goes straight to install.
    // `installedVersion` differs from the running version so post-update
    // migrations have real work to do as well.
    fs.writeFileSync(
      path.join(tmpHome, 'update-check.json'),
      JSON.stringify({
        lastChecked: Date.now(),
        latestVersion: '2.0.0',
        installedVersion: '0.9.0',
      }),
    );

    (globalThis as Record<string, unknown>).PKG_VERSION_INJECTED = '1.0.0';
    process.env.TRACE_MCP_FORCE_NOT_DEV_CHECKOUT = '1';
    delete process.env.TRACE_MCP_NO_AUTO_UPDATE;

    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, '', '');
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    scheduleBackgroundUpdate = (await import('../src/updater.js')).scheduleBackgroundUpdate;
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as Record<string, unknown>).PKG_VERSION_INJECTED = undefined;
    delete process.env.TRACE_MCP_FORCE_NOT_DEV_CHECKOUT;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  it('does no update work before the caller gets control back', async () => {
    const { execFile } = await import('node:child_process');

    scheduleBackgroundUpdate({ checkIntervalHours: 24 });

    // This is the window in which `serve` wires the stdio transport and answers
    // `initialize`. Nothing may have been spawned yet.
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    const installCalls = vi
      .mocked(execFile)
      .mock.calls.filter((c) => Array.isArray(c[1]) && c[1].includes('install'));
    expect(installCalls.length).toBeGreaterThan(0);
  });

  it('never exits the process when an install succeeds', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    scheduleBackgroundUpdate({ checkIntervalHours: 24 });
    await vi.advanceTimersByTimeAsync(60_000);

    // The install ran…
    const written = JSON.parse(
      fs.readFileSync(path.join(tmpHome, 'update-check.json'), 'utf-8'),
    ) as { installedVersion?: string };
    expect(written.installedVersion).toBe('2.0.0');
    // …and the live session survived it.
    expect(exit).not.toHaveBeenCalled();
  });

  it('skips the registry install but still runs migrations when auto_update is off', async () => {
    const { execFile } = await import('node:child_process');
    const { updateClaudeMd } = await import('../src/init/claude-md.js');

    scheduleBackgroundUpdate({ install: false });
    await vi.advanceTimersByTimeAsync(60_000);

    // Nothing was fetched or installed…
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    // …but the post-update migrations still ran and stamped the new version.
    expect(vi.mocked(updateClaudeMd)).toHaveBeenCalled();
    const written = JSON.parse(
      fs.readFileSync(path.join(tmpHome, 'update-check.json'), 'utf-8'),
    ) as { installedVersion?: string };
    expect(written.installedVersion).toBe('1.0.0');
  });

  it('does not keep the process alive on its own', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    scheduleBackgroundUpdate({});
    const timer = spy.mock.results[0]?.value as { hasRef?: () => boolean };
    expect(timer.hasRef?.()).toBe(false);
  });
});
