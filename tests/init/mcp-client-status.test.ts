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
      { client: 'warp', configPath: null, status: 'unmanageable' },
      { client: 'jetbrains-ai', configPath: null, status: 'unmanageable' },
    ]);
  });

  it('reports `up_to_date` immediately after configureMcpClients writes', () => {
    configureMcpClients(['claude-code'], projectRoot, { scope: 'global' });
    const [s] = getMcpClientStatuses(projectRoot, 'global', ['claude-code']);
    expect(s.status).toBe('up_to_date');
    expect(s.staleReason).toBeUndefined();
  });

  it('flags `stale` with reason="alwaysLoad" when the on-disk entry lacks the new flag', () => {
    // First let init write a fresh entry, then strip the alwaysLoad field —
    // simulating an installation done before the alwaysLoad fix shipped.
    configureMcpClients(['claude-code'], projectRoot, { scope: 'global' });
    const configPath = path.join(fakeHome, '.claude.json');
    const c = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    delete c.mcpServers['trace-mcp'].alwaysLoad;
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
    ]) {
      expect(names.has(expected as never)).toBe(true);
    }
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
