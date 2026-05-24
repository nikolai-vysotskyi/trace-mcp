import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #168: a registry entry pointing at a folder the user deleted used to
// keep blocking startup and produce confusing "Project not found" 404s at
// runtime. loadAllRegistered() should self-heal by evicting such entries on
// boot — but only when the parent directory still exists, so we don't trash
// registrations for projects on an unmounted volume.

// vi.mock factories are hoisted; closing over top-level consts fails with
// "Cannot access … before initialization". vi.hoisted() lifts the refs too.
const { unregisterMock, listProjectsMock } = vi.hoisted(() => ({
  unregisterMock: vi.fn(),
  listProjectsMock: vi.fn(),
}));

vi.mock('../../src/registry.js', () => ({
  listProjects: listProjectsMock,
  unregisterProject: unregisterMock,
}));

vi.mock('../../src/progress.js', () => ({
  ProgressState: vi.fn(),
  clearServerPid: vi.fn(),
  writeServerPid: vi.fn(),
}));

vi.mock('../../src/project-setup.js', () => ({
  isDangerousProjectRoot: vi.fn(() => null),
  setupProject: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { ProjectManager } from '../../src/daemon/project-manager.js';
import { logger } from '../../src/logger.js';

describe('ProjectManager.loadAllRegistered — stale folder eviction (issue #168)', () => {
  let parentDir: string;

  beforeEach(() => {
    unregisterMock.mockClear();
    listProjectsMock.mockReset();
    vi.mocked(logger.warn).mockClear();
    // Real on-disk parent so existsSync(parent) is true.
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-evict-'));
  });

  afterEach(() => {
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  it('evicts registry rows whose folder was deleted (parent still exists)', async () => {
    const deletedRoot = path.join(parentDir, 'never-created-project');
    expect(fs.existsSync(deletedRoot)).toBe(false);
    expect(fs.existsSync(parentDir)).toBe(true);
    listProjectsMock.mockReturnValue([{ root: deletedRoot }]);

    const pm = new ProjectManager();
    // biome-ignore lint/suspicious/noExplicitAny: stubbing private method
    const addSpy = vi.spyOn(pm as any, 'addProject').mockResolvedValue(undefined);

    await pm.loadAllRegistered();

    expect(unregisterMock).toHaveBeenCalledWith(deletedRoot);
    // Evicted rows must NOT reach addProject — that would re-trigger the
    // same "Project not found" 404 we're trying to fix.
    expect(addSpy).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some((c) => String(c[1]).includes('Removing project with missing folder')),
    ).toBe(true);
  });

  it('keeps registry rows for projects on an unmounted volume (parent missing too)', async () => {
    // Simulate /Volumes/UnmountedUSB/foo where the whole volume is gone.
    const unmountedRoot = path.join(parentDir, 'gone-volume', 'project');
    expect(fs.existsSync(unmountedRoot)).toBe(false);
    expect(fs.existsSync(path.dirname(unmountedRoot))).toBe(false);
    listProjectsMock.mockReturnValue([{ root: unmountedRoot }]);

    const pm = new ProjectManager();
    // addProject will reject because the path is missing — we only care that
    // we did NOT unregister it; the user expects it back when the volume
    // is mounted again.
    // biome-ignore lint/suspicious/noExplicitAny: stubbing private method
    vi.spyOn(pm as any, 'addProject').mockRejectedValue(new Error('boom'));

    await pm.loadAllRegistered();

    expect(unregisterMock).not.toHaveBeenCalled();
  });

  it('still evicts dangerous roots (regression guard for the original behavior)', async () => {
    const { isDangerousProjectRoot } = await import('../../src/project-setup.js');
    vi.mocked(isDangerousProjectRoot).mockReturnValueOnce('home directory');
    listProjectsMock.mockReturnValue([{ root: '/Users/somebody' }]);

    const pm = new ProjectManager();
    // biome-ignore lint/suspicious/noExplicitAny: stubbing private method
    const addSpy = vi.spyOn(pm as any, 'addProject').mockResolvedValue(undefined);

    await pm.loadAllRegistered();

    expect(unregisterMock).toHaveBeenCalledWith('/Users/somebody');
    expect(addSpy).not.toHaveBeenCalled();
  });
});
