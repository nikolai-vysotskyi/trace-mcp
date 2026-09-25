/**
 * Behavioral tests for removeMcpClients() — the per-client disconnect
 * (TRA-1932), mirror of configureMcpClients().
 *
 * Each format gets the same arc: seed a config holding BOTH server keys
 * (`trace` + legacy `trace-mcp`) beside an unrelated entry, remove, assert
 * both keys are gone while everything else (including comments) survives,
 * then remove again and assert `already_absent`. Uses the same HOME-sandbox
 * pattern as mcp-clients-extra.test.ts so no real user config is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

let sandbox: string;
let fakeHome: string;
let projectRoot: string;

let removeMcpClients: typeof import('../../src/init/mcp-client.js').removeMcpClients;
let getMcpClientStatuses: typeof import('../../src/init/mcp-client.js').getMcpClientStatuses;
let getConfigPath: typeof import('../../src/init/mcp-client.js').getConfigPath;

beforeEach(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-disconnect-'));
  fakeHome = path.join(sandbox, 'home');
  projectRoot = path.join(sandbox, 'project');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });

  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  vi.stubEnv('APPDATA', path.join(fakeHome, 'AppData', 'Roaming'));
  vi.stubEnv('XDG_CONFIG_HOME', '');
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  vi.resetModules();
  ({ removeMcpClients, getMcpClientStatuses, getConfigPath } = await import(
    '../../src/init/mcp-client.js'
  ));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): string {
  const full = path.join(fakeHome, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function writeAbs(full: string, content: string): string {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const TRACE_ENTRY = { command: '/x/trace-mcp', args: ['serve'] };

describe('removeMcpClients — standard mcpServers JSON (cursor)', () => {
  const rel = '.cursor/mcp.json';

  it('removes both keys, keeps neighbours, and is idempotent', () => {
    writeFile(
      rel,
      JSON.stringify({
        mcpServers: { trace: TRACE_ENTRY, 'trace-mcp': TRACE_ENTRY, other: { command: 'x' } },
      }),
    );

    const [first] = removeMcpClients(['cursor'], projectRoot, { scope: 'global' });
    expect(first.action).toBe('removed');

    const after = JSON.parse(fs.readFileSync(path.join(fakeHome, rel), 'utf-8'));
    expect(after.mcpServers).toEqual({ other: { command: 'x' } });

    const [second] = removeMcpClients(['cursor'], projectRoot, { scope: 'global' });
    expect(second.action).toBe('already_absent');

    const statuses = getMcpClientStatuses(projectRoot, 'global', ['cursor']);
    expect(statuses[0].status).toBe('missing');
  });

  it('reports already_absent when the file does not exist', () => {
    const [step] = removeMcpClients(['windsurf'], projectRoot, { scope: 'global' });
    expect(step.action).toBe('already_absent');
  });

  it('removes a legacy-only entry too', () => {
    writeFile(rel, JSON.stringify({ mcpServers: { 'trace-mcp': TRACE_ENTRY } }));
    const [step] = removeMcpClients(['cursor'], projectRoot, { scope: 'global' });
    expect(step.action).toBe('removed');
    const after = JSON.parse(fs.readFileSync(path.join(fakeHome, rel), 'utf-8'));
    expect(after.mcpServers).toEqual({});
  });

  it('preserves JSONC comments around the removed keys', () => {
    writeFile(
      rel,
      [
        '{',
        '  // editor MCP servers',
        '  "mcpServers": {',
        '    // trace-mcp integration',
        '    "trace": { "command": "/x/trace-mcp", "args": ["serve"] },',
        '    "trace-mcp": { "command": "/x/trace-mcp", "args": ["serve"] },',
        '    "other": { "command": "x" } // third-party',
        '  }',
        '}',
      ].join('\n'),
    );

    const [step] = removeMcpClients(['cursor'], projectRoot, { scope: 'global' });
    expect(step.action).toBe('removed');

    const after = fs.readFileSync(path.join(fakeHome, rel), 'utf-8');
    expect(after).toContain('// editor MCP servers');
    expect(after).toContain('// third-party');
    // The comment sitting on the removed entry's own line leaves with it —
    // what must survive is everything around the removed keys.
    expect(after).not.toContain('// trace-mcp integration');
    expect(after).not.toContain('"trace"');
    expect(after).not.toContain('"trace-mcp"');
    expect(after).toContain('"other"');
  });

  it('dry-run reports without writing', () => {
    const full = writeFile(
      rel,
      JSON.stringify({ mcpServers: { trace: TRACE_ENTRY, 'trace-mcp': TRACE_ENTRY } }),
    );
    const before = fs.readFileSync(full, 'utf-8');
    const [step] = removeMcpClients(['cursor'], projectRoot, { scope: 'global', dryRun: true });
    expect(step.action).toBe('skipped');
    expect(step.detail).toContain('Would disconnect');
    expect(fs.readFileSync(full, 'utf-8')).toBe(before);
  });
});

describe('removeMcpClients — special formats', () => {
  it('codex TOML: strips both sections with their .env sub-tables', () => {
    const full = writeFile(
      '.codex/config.toml',
      [
        '[other]',
        'foo = "bar"',
        '',
        '[mcp_servers.trace]',
        'command = "/x/trace-mcp"',
        'args = ["serve"]',
        '[mcp_servers.trace.env]',
        'FOO = "1"',
        '',
        '[mcp_servers.trace-mcp]',
        'command = "/old/trace-mcp"',
        'args = ["serve"]',
        '',
        '[mcp_servers.other]',
        'command = "/y/other"',
        'args = []',
        '',
      ].join('\n'),
    );

    const [step] = removeMcpClients(['codex'], projectRoot, { scope: 'global' });
    expect(step.action).toBe('removed');

    const after = fs.readFileSync(full, 'utf-8');
    expect(after).not.toMatch(/\[mcp_servers\.trace[\].]/);
    expect(after).not.toContain('trace-mcp');
    expect(after).not.toContain('FOO');
    expect(after).toContain('[other]');
    expect(after).toContain('[mcp_servers.other]');

    const [again] = removeMcpClients(['codex'], projectRoot, { scope: 'global' });
    expect(again.action).toBe('already_absent');
  });

  it('hermes YAML: deletes both keys, keeps the rest of the document', () => {
    const full = writeFile(
      '.hermes/config.yaml',
      [
        '# hermes config',
        'mcp_servers:',
        '  trace:',
        '    command: /x/trace-mcp',
        '    args: [serve]',
        '  trace-mcp:',
        '    command: /old/trace-mcp',
        '    args: [serve]',
        '  other:',
        '    command: /y/other',
        'other_top: 1',
        '',
      ].join('\n'),
    );

    const [step] = removeMcpClients(['hermes'], projectRoot, { scope: 'global' });
    expect(step.action).toBe('removed');

    const after = fs.readFileSync(full, 'utf-8');
    expect(after).toContain('# hermes config');
    expect(after).toContain('other_top: 1');
    expect(after).toContain('other:');
    expect(after).not.toMatch(/^\s+trace:/m);
    expect(after).not.toContain('trace-mcp');

    const [again] = removeMcpClients(['hermes'], projectRoot, { scope: 'global' });
    expect(again.action).toBe('already_absent');
  });

  it('opencode: removes both keys under `mcp`', () => {
    const full = writeFile(
      '.config/opencode/opencode.json',
      JSON.stringify({
        mcp: {
          trace: { type: 'local', command: ['/x/trace-mcp', 'serve'], enabled: true },
          'trace-mcp': { type: 'local', command: ['/old', 'serve'], enabled: true },
          other: { type: 'local', command: ['y'], enabled: true },
        },
      }),
    );

    const [step] = removeMcpClients(['opencode'], projectRoot, { scope: 'global' });
    expect(step.action).toBe('removed');

    const after = JSON.parse(fs.readFileSync(full, 'utf-8'));
    expect(Object.keys(after.mcp)).toEqual(['other']);
  });

  it('zed: removes both keys under `context_servers`, keeps editor config', () => {
    // Zed's global path is platform-dependent (%APPDATA%\Zed on Windows,
    // ~/.config/zed elsewhere) — seed exactly where the code reads, or the
    // test asserts against a file the remover never opens (TRA-1932 review).
    const full = getConfigPath('zed', projectRoot, 'global');
    expect(full).toBeTruthy();
    writeAbs(
      full as string,
      JSON.stringify({
        theme: 'One Dark',
        context_servers: { trace: { command: '/x' }, 'trace-mcp': { command: '/old' } },
      }),
    );

    const [step] = removeMcpClients(['zed'], projectRoot, { scope: 'global' });
    expect(step.action).toBe('removed');

    const after = JSON.parse(fs.readFileSync(full as string, 'utf-8'));
    expect(after.theme).toBe('One Dark');
    expect(after.context_servers).toEqual({});
  });

  it('amp: removes both keys under the literal `amp.mcpServers` key', () => {
    const full = writeFile(
      '.config/amp/settings.json',
      [
        '{',
        '  // amp settings',
        '  "amp.mcpServers": {',
        '    "trace": { "command": "/x/trace-mcp", "args": ["serve"] },',
        '    "trace-mcp": { "command": "/old", "args": ["serve"] }',
        '  }',
        '}',
      ].join('\n'),
    );

    const [step] = removeMcpClients(['amp'], projectRoot, { scope: 'global' });
    expect(step.action).toBe('removed');

    const after = fs.readFileSync(full, 'utf-8');
    expect(after).toContain('// amp settings');
    expect(after).not.toContain('"trace"');
    expect(after).not.toContain('trace-mcp');
  });

  it('factory-droid: entry shape (type stdio) does not block removal', () => {
    const full = writeFile(
      '.factory/mcp.json',
      JSON.stringify({
        mcpServers: {
          trace: { type: 'stdio', ...TRACE_ENTRY },
          'trace-mcp': { type: 'stdio', ...TRACE_ENTRY },
        },
      }),
    );

    const [step] = removeMcpClients(['factory-droid'], projectRoot, { scope: 'global' });
    expect(step.action).toBe('removed');
    expect(JSON.parse(fs.readFileSync(full, 'utf-8')).mcpServers).toEqual({});
  });
});

describe('removeMcpClients — boundaries', () => {
  it('leaves manual clients alone without an Error marker', () => {
    for (const name of ['jetbrains-ai', 'warp'] as const) {
      const [step] = removeMcpClients([name], projectRoot, { scope: 'global' });
      expect(step.action).toBe('skipped');
      expect(step.detail ?? '').not.toMatch(/^Error:/);
    }
  });

  it('reports an unknown client without an Error marker', () => {
    const [step] = removeMcpClients(
      ['no-such-client'] as unknown as Parameters<typeof removeMcpClients>[0],
      projectRoot,
      { scope: 'global' },
    );
    expect(step.action).toBe('skipped');
    expect(step.detail).toBe('Unknown client');
  });

  it('refuses claude-desktop while Claude.app runs, with the Error marker', async () => {
    const childProcess = await import('node:child_process');
    const execSync = vi.mocked(childProcess.execSync);
    execSync.mockImplementation(((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('ps -A')) {
        return '/Applications/Claude.app/Contents/MacOS/Claude --started-from-launcher\n';
      }
      throw new Error('not found');
    }) as typeof childProcess.execSync);
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const rel = 'Library/Application Support/Claude/claude_desktop_config.json';
      const full = writeFile(rel, JSON.stringify({ mcpServers: { trace: TRACE_ENTRY } }));
      const before = fs.readFileSync(full, 'utf-8');

      const [step] = removeMcpClients(['claude-desktop'], projectRoot, { scope: 'global' });
      expect(step.action).toBe('skipped');
      expect(step.detail ?? '').toMatch(/^Error: Claude\.app is running/);
      expect(fs.readFileSync(full, 'utf-8')).toBe(before);
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });
});
