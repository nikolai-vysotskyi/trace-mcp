import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same module-isolation dance as mcp-clients-extra.test.ts: HOME is captured
// at module load via `const HOME = os.homedir()`, so we reset modules between
// tests after stubbing the homedir spy.
let sandbox: string;
let fakeHome: string;
let projectRoot: string;

let getMcpClientStatuses: typeof import('../../src/init/mcp-client.js').getMcpClientStatuses;
let configureMcpClients: typeof import('../../src/init/mcp-client.js').configureMcpClients;

beforeEach(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-status-'));
  fakeHome = path.join(sandbox, 'home');
  projectRoot = path.join(sandbox, 'project');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });

  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  // Cline/KiloCode config paths resolve via `process.env.APPDATA` directly
  // (not HOME/os.homedir()), since that's the real Windows convention. On a
  // real Windows runner APPDATA is always set, so leaving it unstubbed makes
  // those clients read/write the CI machine's actual global VS Code
  // settings — outside the sandbox and leaking state across tests (TRA-73).
  vi.stubEnv('APPDATA', path.join(fakeHome, 'AppData', 'Roaming'));
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  vi.resetModules();
  ({ getMcpClientStatuses, configureMcpClients } = await import('../../src/init/mcp-client.js'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('getMcpClientStatuses', () => {
  it('reports `missing` for every JSON-style client when no config exists', () => {
    const result = getMcpClientStatuses(projectRoot, 'global', [
      'claude-code',
      'cursor',
      'windsurf',
    ]);
    expect(result.map((s) => s.status)).toEqual(['missing', 'missing', 'missing']);
    // configPath is still reported so the UI can offer "create at <path>".
    expect(result.every((s) => typeof s.configPath === 'string')).toBe(true);
  });

  it('reports `unmanageable` for warp and jetbrains-ai (UI-only configs)', () => {
    const result = getMcpClientStatuses(projectRoot, 'global', ['warp', 'jetbrains-ai']);
    expect(result).toEqual([
      { client: 'warp', configPath: null, status: 'unmanageable', level: null },
      { client: 'jetbrains-ai', configPath: null, status: 'unmanageable', level: null },
    ]);
  });

  it('reports `up_to_date` immediately after configureMcpClients writes', () => {
    configureMcpClients(['claude-code'], projectRoot, { scope: 'global' });
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.status).toBe('up_to_date');
    expect(s.staleReason).toBeUndefined();
  });

  // TRA-501: a global registration must not depend on the directory the CLI
  // ran in. Before the fix, writing from one directory and asking for status
  // from another reported `drift: cwd` forever — and a repair run from the
  // wrong directory (the desktop app always is) wrote that directory back.
  it('keeps a global entry directory-independent across writer and status', () => {
    const otherRoot = path.join(sandbox, 'somewhere-else');
    fs.mkdirSync(otherRoot, { recursive: true });

    configureMcpClients(['cursor', 'factory-droid', 'amp'], projectRoot, { scope: 'global' });

    // Written from projectRoot, asked about from an unrelated root.
    const statuses = getMcpClientStatuses(otherRoot, 'global', ['cursor', 'factory-droid', 'amp']);
    expect(statuses.map((s) => s.status)).toEqual(['up_to_date', 'up_to_date', 'up_to_date']);

    const cursorEntry = JSON.parse(
      fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf-8'),
    ).mcpServers['trace-mcp'];
    expect(cursorEntry.cwd).toBeUndefined();
  });

  it('flags an existing global entry that still carries a cwd as stale, and repairs it (TRA-501)', () => {
    configureMcpClients(['cursor'], projectRoot, { scope: 'global' });
    const configPath = path.join(fakeHome, '.cursor', 'mcp.json');
    const c = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    c.mcpServers['trace-mcp'].cwd = '/some/stale/path';
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2));

    const [before] = getMcpClientStatuses(projectRoot, 'global', ['cursor']);
    expect(before.status).toBe('stale');
    expect(before.staleReason).toBe('cwd');

    configureMcpClients(['cursor'], projectRoot, { scope: 'global' });
    const [after] = getMcpClientStatuses(projectRoot, 'global', ['cursor']);
    expect(after.status).toBe('up_to_date');
    expect(
      JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers['trace-mcp'].cwd,
    ).toBeUndefined();
  });

  it('flags `stale` with reason="alwaysLoad" when the on-disk entry carries a stale flag (GH #354)', () => {
    // Simulate an installation done by a pre-#354 `init`, which used to
    // write `alwaysLoad: true`. init no longer writes it, so an entry that
    // still has it should now be flagged stale (not treated as healthy).
    configureMcpClients(['claude-code'], projectRoot, { scope: 'global' });
    const configPath = path.join(fakeHome, '.claude.json');
    const c = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    c.mcpServers['trace-mcp'].alwaysLoad = true;
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2));

    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.status).toBe('stale');
    expect(s.staleReason).toBe('alwaysLoad');
  });

  it('flags `stale` with reason="command" when the launcher path drifts', () => {
    const configPath = path.join(fakeHome, '.claude.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            'trace-mcp': {
              command: '/old/path/that/no/longer/matches',
              args: ['serve'],
              alwaysLoad: true,
            },
          },
        },
        null,
        2,
      ),
    );
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.status).toBe('stale');
    expect(s.staleReason).toBe('command');
  });

  it('flags `stale` reason="args" when args change', () => {
    configureMcpClients(['claude-code'], projectRoot, { scope: 'global' });
    const configPath = path.join(fakeHome, '.claude.json');
    const c = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    c.mcpServers['trace-mcp'].args = ['serve', '--legacy'];
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.status).toBe('stale');
    expect(s.staleReason).toBe('args');
  });

  it('reports `missing` when mcpServers exists but trace-mcp entry is absent', () => {
    const configPath = path.join(fakeHome, '.claude.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { 'other-server': { command: 'x', args: [] } } }, null, 2),
    );
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.status).toBe('missing');
  });

  it('does not set alwaysLoad on cursor, so a cursor entry without it is up_to_date', () => {
    configureMcpClients(['cursor'], projectRoot, { scope: 'global' });
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['cursor']);
    expect(s.status).toBe('up_to_date');
    // Sanity: ensure the entry on disk indeed has no alwaysLoad field.
    const onDisk = JSON.parse(fs.readFileSync(s.configPath as string, 'utf-8'));
    expect(onDisk.mcpServers['trace-mcp'].alwaysLoad).toBeUndefined();
  });

  it('does not set alwaysLoad on claude-code either (GH #354)', () => {
    configureMcpClients(['claude-code'], projectRoot, { scope: 'global' });
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.status).toBe('up_to_date');
    const configPath = path.join(fakeHome, '.claude.json');
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(onDisk.mcpServers['trace-mcp'].alwaysLoad).toBeUndefined();
  });

  it('returns a status for every client when called with no name filter', () => {
    const all = getMcpClientStatuses(projectRoot, 'global');
    // We don't assert exact length to stay forward-compat as new clients
    // get added — just that every well-known client we expect is covered.
    const names = new Set(all.map((s) => s.client));
    for (const expected of [
      'claude-code',
      'claude-desktop',
      'cursor',
      'windsurf',
      'continue',
      'codex',
      'amp',
      'factory-droid',
      'hermes',
      'warp',
      'jetbrains-ai',
      'cline',
      'kilocode',
      'antigravity',
      'kimi',
    ]) {
      expect(names.has(expected as never)).toBe(true);
    }
  });

  it('reports missing → up_to_date round-trip for cline, antigravity, kimi', () => {
    const clients: Array<'cline' | 'antigravity' | 'kimi'> = ['cline', 'antigravity', 'kimi'];
    // Missing before any write.
    for (const c of clients) {
      const [before] = getMcpClientStatuses(projectRoot, 'global', [c]);
      expect(before.status, `${c} should start missing`).toBe('missing');
      expect(typeof before.configPath).toBe('string');
    }
    // up_to_date immediately after write.
    for (const c of clients) {
      configureMcpClients([c], projectRoot, { scope: 'global' });
      const [after] = getMcpClientStatuses(projectRoot, 'global', [c]);
      expect(after.status, `${c} should be up_to_date`).toBe('up_to_date');
      expect(after.staleReason).toBeUndefined();
    }
  });

  it('flags cline `stale` reason="command" when the launcher path drifts', () => {
    configureMcpClients(['cline'], projectRoot, { scope: 'global' });
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['cline']);
    const configPath = s.configPath as string;
    const c = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    c.mcpServers['trace-mcp'].command = '/old/launcher/path';
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
    const [drifted] = getMcpClientStatuses(projectRoot, 'global', ['cline']);
    expect(drifted.status).toBe('stale');
    expect(drifted.staleReason).toBe('command');
  });

  it('reports codex as `unknown` (presence-only) when section exists', () => {
    const configPath = path.join(fakeHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '[mcp_servers.trace-mcp]\ncommand = "x"\nargs = ["serve"]\n');
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['codex']);
    expect(s.status).toBe('unknown');
    expect(s.configPath).toBe(configPath);
  });
});

// TRA-498: the level a client's config is already on, so the app's "Update"
// can refresh a drifted field without re-asking a setup question.
describe('getMcpClientStatuses — enforcement level', () => {
  /** Write the guard-hook entry `init` installs at Standard and above. */
  function installGuardHook(configDir: string): void {
    const settingsPath = path.join(fakeHome, configDir, 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Read|Grep|Glob|Bash|Agent',
              hooks: [
                {
                  type: 'command',
                  command: path.join(fakeHome, configDir, 'hooks', 'trace-mcp-guard.sh'),
                },
              ],
            },
          ],
        },
      }),
    );
  }

  /** Write the tweakcc system prompts `init` installs at Max only. */
  function installTweakccPrompts(): void {
    const dir = path.join(sandbox, 'tweakcc', 'system-prompts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tool-description-readfile.md'), 'x');
    vi.stubEnv('TWEAKCC_CONFIG_DIR', path.join(sandbox, 'tweakcc'));
  }

  it('is null when nothing is configured yet — the level is still a choice', () => {
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.status).toBe('missing');
    expect(s.level).toBeNull();
  });

  it('reports `base` for a configured client with no hooks', () => {
    configureMcpClients(['claude-code'], projectRoot, { scope: 'global' });
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.level).toBe('base');
  });

  it('reports `standard` once the guard hook is installed', () => {
    configureMcpClients(['claude-code'], projectRoot, { scope: 'global' });
    installGuardHook('.claude');
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.level).toBe('standard');
  });

  it('reports `max` once the tweakcc prompts are there too', () => {
    configureMcpClients(['claude-code'], projectRoot, { scope: 'global' });
    installGuardHook('.claude');
    installTweakccPrompts();
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.level).toBe('max');
  });

  it('reads claw-code from its own ~/.claw settings, not Claude Code’s', () => {
    configureMcpClients(['claude-code', 'claw-code'], projectRoot, { scope: 'global' });
    installGuardHook('.claude');
    const [cc, claw] = getMcpClientStatuses(projectRoot, 'global', ['claude-code', 'claw-code']);
    expect(cc.level).toBe('standard');
    expect(claw.level).toBe('base');
  });

  it('is null for non-Claude clients — they have no hooks or tweakcc to grade', () => {
    configureMcpClients(['cursor'], projectRoot, { scope: 'global' });
    installGuardHook('.claude');
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['cursor']);
    expect(s.status).toBe('up_to_date');
    expect(s.level).toBeNull();
  });

  it('survives a malformed settings.json instead of throwing', () => {
    configureMcpClients(['claude-code'], projectRoot, { scope: 'global' });
    const settingsPath = path.join(fakeHome, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ not json');
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.level).toBe('base');
  });
});

describe('configureMcpClients ↔ getMcpClientStatuses round-trip', () => {
  it('writes and immediately reads as up_to_date for every JSON-shape client', () => {
    const clients: Array<'claude-code' | 'cursor' | 'windsurf' | 'continue' | 'junie'> = [
      'claude-code',
      'cursor',
      'windsurf',
      'continue',
      'junie',
    ];
    for (const c of clients) {
      configureMcpClients([c], projectRoot, { scope: 'global' });
    }
    const statuses = getMcpClientStatuses(projectRoot, 'global', clients);
    for (const s of statuses) {
      expect(s.status, `${s.client} should be up_to_date`).toBe('up_to_date');
    }
  });
});
