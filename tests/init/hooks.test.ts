import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GUARD_HOOK_VERSION } from '../../src/init/types.js';

// Mock fs and os before importing the module under test
vi.mock('node:fs');
vi.mock('node:os');

// `writeSettings` was switched to atomicWriteJson (commits leading up to
// e948a22+), which routes through `fs.openSync(tmp, …)` + `fs.writeFileSync(fd,
// body)` + `fs.renameSync(tmp, target)`. The existing test surface — find a
// `writeFileSync` call whose first arg is a path containing `'settings.json'`
// — therefore breaks: `c[0]` is a file descriptor (number), not the path.
//
// Re-route the production atomic-write helpers back to the simple
// `fs.writeFileSync(path, body)` shape the tests expect. The atomicity
// behaviour itself is covered by atomic-write's own tests; here we only
// care that hook-install logic produces the right settings payload.
vi.mock('../../src/utils/atomic-write.js', async () => {
  const fsMod = await import('node:fs');
  type Opts = { indent?: number; trailingNewline?: boolean };
  const finalize = (payload: string, opts?: Opts) => {
    const trailingNewline = opts?.trailingNewline ?? true;
    return trailingNewline && !payload.endsWith('\n') ? `${payload}\n` : payload;
  };
  return {
    atomicWriteString: (target: string, payload: string, opts?: Opts) => {
      fsMod.default.writeFileSync(target, finalize(payload, opts));
    },
    atomicWriteJson: (target: string, data: unknown, opts?: Opts) => {
      const indent = opts?.indent ?? 2;
      fsMod.default.writeFileSync(target, finalize(JSON.stringify(data, null, indent), opts));
    },
  };
});

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

// We need to dynamically import after mocking
let installGuardHook: typeof import('../../src/init/hooks.js').installGuardHook;
let uninstallGuardHook: typeof import('../../src/init/hooks.js').uninstallGuardHook;
let installReindexHook: typeof import('../../src/init/hooks.js').installReindexHook;
let isHookOutdated: typeof import('../../src/init/hooks.js').isHookOutdated;
let installLifecycleHooks: typeof import('../../src/init/hooks.js').installLifecycleHooks;
let uninstallLifecycleHooks: typeof import('../../src/init/hooks.js').uninstallLifecycleHooks;
let installSessionStartHook: typeof import('../../src/init/hooks.js').installSessionStartHook;

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
  installLifecycleHooks = mod.installLifecycleHooks;
  uninstallLifecycleHooks = mod.uninstallLifecycleHooks;
  installSessionStartHook = mod.installSessionStartHook;
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
      // Normalize path separators so `s.includes('hooks/...')` matchers work
      // on Windows runners (where path.join emits backslashes).
      const s = String(p).replace(/\\/g, '/');
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
      // Normalize path separators so `s.includes('hooks/...')` matchers work
      // on Windows runners (where path.join emits backslashes).
      const s = String(p).replace(/\\/g, '/');
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
      // Normalize path separators so `s.includes('hooks/...')` matchers work
      // on Windows runners (where path.join emits backslashes).
      const s = String(p).replace(/\\/g, '/');
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

  it('copies Windows aux .ps1 helpers alongside .cmd on win32', async () => {
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
        if (
          s.includes('hooks') &&
          s.includes('trace-mcp-guard-md-tour.ps1') &&
          !s.includes('.claude')
        )
          return true;
        if (s.includes('.claw')) return false;
        return false;
      });

      const mod = await import('../../src/init/hooks.js');
      mod.installGuardHook({ global: true });

      const copies = mockFs.copyFileSync.mock.calls.map((c) => String(c[1]));
      expect(copies.some((dest) => dest.endsWith('trace-mcp-guard.cmd'))).toBe(true);
      expect(copies.some((dest) => dest.endsWith('trace-mcp-guard-read.ps1'))).toBe(true);
      expect(copies.some((dest) => dest.endsWith('trace-mcp-guard-md-tour.ps1'))).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does NOT copy Windows aux .ps1 helpers on non-win32 platforms',
    () => {
      // Asserts non-win32 branch behavior; can't run on the windows-latest runner
      // because the production code under test reads process.platform directly.
      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        // Normalize path separators so `s.includes('hooks/...')` matchers work
        // on Windows runners (where path.join emits backslashes).
        const s = String(p).replace(/\\/g, '/');
        if (s.includes('hooks') && s.includes('trace-mcp-guard') && !s.includes('.claude'))
          return true;
        if (s.includes('.claw')) return false;
        return false;
      });

      installGuardHook({ global: true });

      const copies = mockFs.copyFileSync.mock.calls.map((c) => String(c[1]));
      expect(copies.some((dest) => dest.endsWith('trace-mcp-guard-read.ps1'))).toBe(false);
      expect(copies.some((dest) => dest.endsWith('trace-mcp-guard-md-tour.ps1'))).toBe(false);
    },
  );

  it('also installs for Claw Code when .claw exists', () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      // Normalize path separators so `s.includes('hooks/...')` matchers work
      // on Windows runners (where path.join emits backslashes).
      const s = String(p).replace(/\\/g, '/');
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
      // Normalize path separators so `s.includes('hooks/...')` matchers work
      // on Windows runners (where path.join emits backslashes).
      const s = String(p).replace(/\\/g, '/');
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
      // Normalize path separators so `s.includes('hooks/...')` matchers work
      // on Windows runners (where path.join emits backslashes).
      const s = String(p).replace(/\\/g, '/');
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
      // Normalize path separators so `s.includes('hooks/...')` matchers work
      // on Windows runners (where path.join emits backslashes).
      const s = String(p).replace(/\\/g, '/');
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

describe('installLifecycleHooks', () => {
  it('returns one skipped step per hook on dry run', () => {
    const results = installLifecycleHooks({ dryRun: true });
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.action).toBe('skipped');
      expect(r.detail).toMatch(/Would install/);
    }
  });

  it('installs SessionStart / UserPromptSubmit / Stop / SessionEnd entries with correct settings keys', () => {
    // The default fs mocks treat every readSettings → "{}" because existsSync
    // for settings.json starts false. Each install is a separate readSettings
    // → addHookEntry → writeSettings cycle, so we assert PER-WRITE that one
    // of the four lifecycle keys was added (rather than expecting the last
    // write to contain all four — that would require the in-memory store the
    // production code never builds).
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p).replace(/\\/g, '/');
      if (
        s.includes('hooks') &&
        (s.includes('trace-mcp-session-start') ||
          s.includes('trace-mcp-user-prompt-submit') ||
          s.includes('trace-mcp-stop') ||
          s.includes('trace-mcp-session-end')) &&
        !s.includes('.claude') &&
        !s.includes('.claw')
      )
        return true;
      if (s.includes('.claw')) return false;
      return false;
    });

    const results = installLifecycleHooks({ global: true });
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.action === 'created')).toBe(true);

    // Collect the final settings payload PER hook event by inspecting every
    // write's parsed JSON.
    const settingsWrites = mockFs.writeFileSync.mock.calls.filter((c) =>
      String(c[0]).includes('settings.json'),
    );
    expect(settingsWrites.length).toBe(4);

    const seenKeys = new Set<string>();
    for (const w of settingsWrites) {
      const parsed = JSON.parse(String(w[1]).trim());
      const hooks = parsed.hooks ?? {};
      for (const key of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
        if (Array.isArray(hooks[key])) {
          const entries = hooks[key] as Array<{
            matcher?: string;
            hooks: { command: string }[];
          }>;
          expect(entries).toHaveLength(1);
          // Lifecycle hooks are plainCommand=true → no `matcher` key.
          expect(entries[0].matcher).toBeUndefined();
          expect(entries[0].hooks[0].command).toMatch(
            /trace-mcp-(session-start|user-prompt-submit|stop|session-end)/,
          );
          seenKeys.add(key);
        }
      }
    }
    expect(seenKeys).toEqual(new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']));
  });

  it('does not duplicate lifecycle entries on repeat install', () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.includes('hooks/trace-mcp-')) return true;
      if (s.includes('settings.json')) return true;
      if (s.includes('.claw')) return false;
      return false;
    });

    // Pre-existing settings already contain a SessionStart entry pointing at
    // our script — installLifecycleHooks must update in place, not append.
    const initial = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: 'command', command: '/old/path/trace-mcp-session-start.sh' }],
          },
        ],
      },
    });
    mockFs.readFileSync.mockReturnValue(initial);

    installLifecycleHooks({ global: true });

    const writes = mockFs.writeFileSync.mock.calls.filter((c) =>
      String(c[0]).includes('settings.json'),
    );
    const finalSettings = JSON.parse(String(writes[writes.length - 1][1]).trim());
    expect(finalSettings.hooks.SessionStart).toHaveLength(1);
  });
});

describe('uninstallLifecycleHooks', () => {
  it('removes the matching lifecycle hook entry per uninstall and preserves PreToolUse', () => {
    // Each uninstall reads the SAME mocked initial settings, removes one
    // lifecycle key, and writes the result. We assert per-write that the
    // expected key is gone AND PreToolUse remains intact.
    const initial = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: 'trace-mcp-session-start /path' }] }],
        UserPromptSubmit: [{ hooks: [{ command: 'trace-mcp-user-prompt-submit /path' }] }],
        Stop: [{ hooks: [{ command: 'trace-mcp-stop /path' }] }],
        SessionEnd: [{ hooks: [{ command: 'trace-mcp-session-end /path' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'other-hook' }] }],
      },
    });

    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p).replace(/\\/g, '/');
      // Reject ANY .claw path so only the .claude client touches settings.
      if (s.includes('.claw')) return false;
      if (s.includes('settings.json')) return true;
      if (s.includes('trace-mcp-')) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue(initial);

    const results = uninstallLifecycleHooks({ global: true });
    expect(results).toHaveLength(4);

    const writes = mockFs.writeFileSync.mock.calls.filter(
      (c) => String(c[0]).includes('settings.json') && !String(c[0]).includes('.claw'),
    );
    expect(writes.length).toBe(4);

    const removalScripts = ['session-start', 'user-prompt-submit', 'stop', 'session-end'];

    for (let i = 0; i < writes.length; i++) {
      const parsed = JSON.parse(String(writes[i][1]).trim());
      // The key whose script matches `removalScripts[i]` should be gone.
      const expectedKey = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'][i];
      expect(parsed.hooks?.[expectedKey]).toBeUndefined();
      // PreToolUse must always survive.
      expect(parsed.hooks?.PreToolUse).toHaveLength(1);
      expect(parsed.hooks?.PreToolUse[0].hooks[0].command).toBe('other-hook');
    }
    // Sanity: ensure each uninstall actually targeted a lifecycle hook
    expect(removalScripts).toHaveLength(4);
  });
});

describe('installSessionStartHook', () => {
  it('returns skipped on dry run with descriptive label', () => {
    const result = installSessionStartHook({ dryRun: true });
    expect(result.action).toBe('skipped');
    expect(result.detail).toContain('session-start');
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
    expect(isHookOutdated(GUARD_HOOK_VERSION)).toBe(false);
  });
});
