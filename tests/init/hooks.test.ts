import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs and os before importing the module under test
vi.mock('node:fs');
vi.mock('node:os');

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

// We need to dynamically import after mocking
let installGuardHook: typeof import('../../src/init/hooks.js').installGuardHook;
let uninstallGuardHook: typeof import('../../src/init/hooks.js').uninstallGuardHook;
let installReindexHook: typeof import('../../src/init/hooks.js').installReindexHook;
let isHookOutdated: typeof import('../../src/init/hooks.js').isHookOutdated;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();

  // Default mocks
  mockOs.homedir.mockReturnValue('/home/user');
  mockFs.existsSync.mockReturnValue(false);
  mockFs.readFileSync.mockReturnValue('{}');
  mockFs.writeFileSync.mockImplementation(() => {});
  mockFs.copyFileSync.mockImplementation(() => {});
  mockFs.chmodSync.mockImplementation(() => {});
  mockFs.mkdirSync.mockImplementation(() => undefined as unknown as string);
  mockFs.unlinkSync.mockImplementation(() => {});

  const mod = await import('../../src/init/hooks.js');
  installGuardHook = mod.installGuardHook;
  uninstallGuardHook = mod.uninstallGuardHook;
  installReindexHook = mod.installReindexHook;
  isHookOutdated = mod.isHookOutdated;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installGuardHook', () => {
  it('returns skipped on dry run', () => {
    const result = installGuardHook({ dryRun: true });
    expect(result.action).toBe('skipped');
    expect(result.detail).toContain('Would install');
  });

  it('copies hook script and creates settings entry (global)', () => {
    // Hook source exists at package path, but not yet installed at dest
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('hooks') && s.includes('hooks/trace-mcp-guard') && !s.includes('.claude'))
        return true;
      if (s.includes('.claw')) return false;
      return false;
    });

    const result = installGuardHook({ global: true });

    expect(result.action).toBe('created');
    expect(mockFs.copyFileSync).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalled();

    // Verify settings content
    const writeCall = mockFs.writeFileSync.mock.calls.find((c) =>
      String(c[0]).includes('settings.json'),
    );
    expect(writeCall).toBeDefined();
    const settings = JSON.parse(String(writeCall![1]).trim());
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Read|Grep|Glob|Bash|Agent');
  });

  it('reports updated when hook already exists at dest', () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      // Source and dest both exist
      if (s.includes('trace-mcp-guard')) return true;
      if (s.includes('.claw')) return false;
      return false;
    });

    const result = installGuardHook({ global: true });
    expect(result.action).toBe('updated');
  });

  it('does not duplicate hook entry if already present', () => {
    const existingSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read|Grep|Glob|Bash',
            hooks: [{ type: 'command', command: 'trace-mcp-guard /path' }],
          },
        ],
      },
    });

    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('hooks/trace-mcp-guard')) return true;
      if (s.includes('settings.json')) return true;
      if (s.includes('.claw')) return false;
      return false;
    });
    mockFs.readFileSync.mockReturnValue(existingSettings);

    installGuardHook({ global: true });

    const writeCall = mockFs.writeFileSync.mock.calls.find((c) =>
      String(c[0]).includes('settings.json'),
    );
    const settings = JSON.parse(String(writeCall![1]).trim());
    expect(settings.hooks.PreToolUse).toHaveLength(1); // not duplicated
  });

  it('copies Windows aux .ps1 helper alongside .cmd on win32', async () => {
    // IS_WINDOWS / HOOK_EXT are module-level constants, so we have to stub the
    // platform BEFORE importing the module under test.
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      vi.resetModules();
      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s.includes('hooks') && s.includes('trace-mcp-guard.cmd') && !s.includes('.claude'))
          return true;
        if (s.includes('hooks') && s.includes('trace-mcp-guard-read.ps1') && !s.includes('.claude'))
          return true;
        if (s.includes('.claw')) return false;
        return false;
      });

      const mod = await import('../../src/init/hooks.js');
      mod.installGuardHook({ global: true });

      const copies = mockFs.copyFileSync.mock.calls.map((c) => String(c[1]));
      expect(copies.some((dest) => dest.endsWith('trace-mcp-guard.cmd'))).toBe(true);
      expect(copies.some((dest) => dest.endsWith('trace-mcp-guard-read.ps1'))).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('does NOT copy Windows aux .ps1 helper on non-win32 platforms', () => {
    // Current platform is non-win32 (darwin/linux in CI); aux file should be skipped.
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('hooks') && s.includes('trace-mcp-guard') && !s.includes('.claude'))
        return true;
      if (s.includes('.claw')) return false;
      return false;
    });

    installGuardHook({ global: true });

    const copies = mockFs.copyFileSync.mock.calls.map((c) => String(c[1]));
    expect(copies.some((dest) => dest.endsWith('trace-mcp-guard-read.ps1'))).toBe(false);
  });

  it('also installs for Claw Code when .claw exists', () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('hooks/trace-mcp-guard')) return true;
      if (s.endsWith('.claw')) return true; // claw dir exists
      return false;
    });

    installGuardHook({ global: true });

    // Should have written both Claude and Claw settings
    const settingsWrites = mockFs.writeFileSync.mock.calls.filter((c) =>
      String(c[0]).includes('settings'),
    );
    expect(settingsWrites.length).toBe(2);
  });
});

describe('uninstallGuardHook', () => {
  it('removes hook entry from settings and deletes script', () => {
    const existingSettings = JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ command: 'trace-mcp-guard /path' }] },
          { hooks: [{ command: 'other-hook' }] },
        ],
      },
    });

    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('settings')) return true;
      if (s.includes('trace-mcp-guard')) return true;
      if (s.includes('.claw')) return false;
      return false;
    });
    mockFs.readFileSync.mockReturnValue(existingSettings);

    const result = uninstallGuardHook({ global: true });
    expect(result.action).toBe('updated');
    expect(result.detail).toBe('Removed');
    expect(mockFs.unlinkSync).toHaveBeenCalled();

    const writeCall = mockFs.writeFileSync.mock.calls.find((c) =>
      String(c[0]).includes('settings'),
    );
    const settings = JSON.parse(String(writeCall![1]).trim());
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('other-hook');
  });

  it('removes hooks key entirely when last entry removed', () => {
    const existingSettings = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ command: 'trace-mcp-guard /path' }] }],
      },
    });

    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('settings')) return true;
      if (s.includes('.claw')) return false;
      return false;
    });
    mockFs.readFileSync.mockReturnValue(existingSettings);

    uninstallGuardHook({ global: true });

    const writeCall = mockFs.writeFileSync.mock.calls.find((c) =>
      String(c[0]).includes('settings'),
    );
    const settings = JSON.parse(String(writeCall![1]).trim());
    expect(settings.hooks).toBeUndefined();
  });
});

describe('installReindexHook', () => {
  it('returns skipped on dry run', () => {
    const result = installReindexHook({ dryRun: true });
    expect(result.action).toBe('skipped');
    expect(result.detail).toContain('Would install');
  });

  it('installs PostToolUse hook with Edit|Write|MultiEdit matcher', () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('trace-mcp-reindex') && !s.includes('.claude')) return true;
      if (s.includes('.claw')) return false;
      return false;
    });

    const result = installReindexHook({ global: true });
    expect(result.action).toBe('created');

    const writeCall = mockFs.writeFileSync.mock.calls.find((c) =>
      String(c[0]).includes('settings.json'),
    );
    const settings = JSON.parse(String(writeCall![1]).trim());
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|Write|MultiEdit');
  });
});

describe('isHookOutdated', () => {
  it('returns true for null version', () => {
    expect(isHookOutdated(null)).toBe(true);
  });

  it('returns true for mismatched version', () => {
    expect(isHookOutdated('0.0.1')).toBe(true);
  });

  it('returns false for matching version', () => {
    // The current version is exported from types
    expect(isHookOutdated('0.6.0')).toBe(false);
  });
});
