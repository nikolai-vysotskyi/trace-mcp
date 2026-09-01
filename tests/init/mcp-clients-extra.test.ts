import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// detector.ts and mcp-client.ts compute `const HOME = os.homedir()` at module
// load, so we have to reset modules and re-import per test after stubbing HOME.
let sandbox: string;
let fakeHome: string;
let projectRoot: string;

let detectMcpClients: typeof import('../../src/init/detector.js').detectMcpClients;
let configureMcpClients: typeof import('../../src/init/mcp-client.js').configureMcpClients;
let getMcpClientStatuses: typeof import('../../src/init/mcp-client.js').getMcpClientStatuses;

beforeEach(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-clients-'));
  fakeHome = path.join(sandbox, 'home');
  projectRoot = path.join(sandbox, 'project');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });

  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  // Cline/KiloCode config paths resolve via `process.env.APPDATA` directly
  // (real Windows convention), not HOME/os.homedir(). On a real Windows
  // runner APPDATA is always set, so leaving it unstubbed makes those
  // clients read/write the CI machine's actual global VS Code settings —
  // outside the sandbox and leaking state across tests (TRA-73).
  vi.stubEnv('APPDATA', path.join(fakeHome, 'AppData', 'Roaming'));
  // os.homedir() on macOS reads getpwuid_r, not $HOME — env stubs alone are
  // not enough. Spy on os.homedir() so the module-level `const HOME =
  // os.homedir()` captures the sandbox path. Without this, every test that
  // exercises a writer leaks into the real user config.
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  // Force re-evaluation of module-level `const HOME = os.homedir()` against the spy.
  vi.resetModules();
  ({ detectMcpClients } = await import('../../src/init/detector.js'));
  ({ configureMcpClients, getMcpClientStatuses } = await import('../../src/init/mcp-client.js'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('AMP detection', () => {
  it('parses settings.json with amp.mcpServers and reports trace-mcp present', () => {
    const dir = path.join(fakeHome, '.config', 'amp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        'amp.mcpServers': { 'trace-mcp': { command: '/bin/true', args: ['serve'] } },
      }),
    );
    const clients = detectMcpClients(projectRoot);
    const amp = clients.find((c) => c.name === 'amp');
    expect(amp).toBeDefined();
    expect(amp?.hasTraceMcp).toBe(true);
  });

  it('parses settings.jsonc with comments and detects no trace-mcp entry', () => {
    const dir = path.join(fakeHome, '.config', 'amp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.jsonc'),
      [
        '// AMP user settings',
        '{',
        '  /* third-party servers */',
        '  "amp.mcpServers": {',
        '    "linear": { "command": "npx", "args": ["-y", "@linear/mcp"] }',
        '  }',
        '}',
      ].join('\n'),
    );
    const clients = detectMcpClients(projectRoot);
    const amp = clients.find((c) => c.name === 'amp');
    expect(amp).toBeDefined();
    expect(amp?.hasTraceMcp).toBe(false);
    expect(amp?.configPath).toMatch(/settings\.jsonc$/);
  });

  it('falls back to project-level .amp/settings.json when user-level is absent', () => {
    const projDir = path.join(projectRoot, '.amp');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, 'settings.json'),
      JSON.stringify({
        'amp.mcpServers': { 'trace-mcp': { command: 'x' } },
      }),
    );
    const clients = detectMcpClients(projectRoot);
    const amp = clients.find((c) => c.name === 'amp');
    expect(amp?.hasTraceMcp).toBe(true);
    expect(amp?.configPath.startsWith(projectRoot)).toBe(true);
  });
});

describe('Factory Droid detection', () => {
  it('detects user-level ~/.factory/mcp.json with trace-mcp entry', () => {
    const dir = path.join(fakeHome, '.factory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { 'trace-mcp': { type: 'stdio', command: '/bin/true', args: ['serve'] } },
      }),
    );
    const clients = detectMcpClients(projectRoot);
    const droid = clients.find((c) => c.name === 'factory-droid');
    expect(droid).toBeDefined();
    expect(droid?.hasTraceMcp).toBe(true);
  });

  it('detects project-level .factory/mcp.json without trace-mcp', () => {
    const dir = path.join(projectRoot, '.factory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const clients = detectMcpClients(projectRoot);
    const droid = clients.find((c) => c.name === 'factory-droid');
    expect(droid?.hasTraceMcp).toBe(false);
  });
});

describe('AMP writer round-trip', () => {
  it('preserves comments when adding trace-mcp via jsonc-parser', () => {
    const dir = path.join(fakeHome, '.config', 'amp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'settings.jsonc');
    fs.writeFileSync(
      file,
      [
        '// User-managed AMP settings',
        '{',
        '  // existing servers',
        '  "amp.mcpServers": {',
        '    "linear": { "command": "npx", "args": ["@linear/mcp"] }',
        '  }',
        '}',
      ].join('\n'),
    );

    const results = configureMcpClients(['amp'], projectRoot, { scope: 'global' });
    const step = results[0];
    expect(step.action).toBe('updated');

    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toContain('// User-managed AMP settings');
    expect(after).toContain('// existing servers');
    expect(after).toContain('"trace"');
    expect(after).toContain('"linear"');
  });

  it('writes a new settings.json when no AMP config exists', () => {
    const results = configureMcpClients(['amp'], projectRoot, { scope: 'global' });
    const step = results[0];
    expect(step.action).toBe('created');
    const file = path.join(fakeHome, '.config', 'amp', 'settings.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed['amp.mcpServers']?.['trace']?.args).toEqual(['serve']);
  });

  it('reports already_configured when entry matches', () => {
    configureMcpClients(['amp'], projectRoot, { scope: 'global' });
    const second = configureMcpClients(['amp'], projectRoot, { scope: 'global' });
    expect(second[0].action).toBe('already_configured');
  });
});

describe('Factory Droid writer', () => {
  it('writes mcpServers entry with type: stdio', () => {
    const results = configureMcpClients(['factory-droid'], projectRoot, { scope: 'global' });
    const step = results[0];
    expect(step.action).toBe('created');
    const file = path.join(fakeHome, '.factory', 'mcp.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const entry = parsed.mcpServers['trace'];
    expect(entry.type).toBe('stdio');
    expect(entry.args).toEqual(['serve']);
    // Global scope carries no cwd — see TRA-501.
    expect(entry.cwd).toBeUndefined();
  });

  it('writes cwd only for a project-scoped entry', () => {
    configureMcpClients(['factory-droid'], projectRoot, { scope: 'project' });
    const file = path.join(projectRoot, '.factory', 'mcp.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers['trace'].cwd).toBe(projectRoot);
  });

  it('preserves existing servers when adding trace-mcp', () => {
    const file = path.join(fakeHome, '.factory', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
      }),
    );
    configureMcpClients(['factory-droid'], projectRoot, { scope: 'global' });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers.linear).toBeDefined();
    expect(parsed.mcpServers['trace']).toBeDefined();
  });
});

// VS Code globalStorage base for Cline / KiloCode (extensions), per-OS.
function vscodeUserDir(home: string): string {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User');
  }
  return path.join(home, '.config', 'Code', 'User');
}

describe('Cline detection', () => {
  it('detects cline_mcp_settings.json under globalStorage saoudrizwan.claude-dev', () => {
    const dir = path.join(
      vscodeUserDir(fakeHome),
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cline_mcp_settings.json'),
      JSON.stringify({
        mcpServers: { 'trace-mcp': { command: '/bin/true', args: ['serve'] } },
      }),
    );
    const clients = detectMcpClients(projectRoot);
    const cline = clients.find((c) => c.name === 'cline');
    expect(cline).toBeDefined();
    expect(cline?.hasTraceMcp).toBe(true);
  });

  it('does not report cline when the extension settings dir is absent', () => {
    const clients = detectMcpClients(projectRoot);
    expect(clients.find((c) => c.name === 'cline')).toBeUndefined();
  });
});

describe('KiloCode detection', () => {
  it('detects mcp_settings.json under globalStorage kilocode.kilo-code', () => {
    const dir = path.join(
      vscodeUserDir(fakeHome),
      'globalStorage',
      'kilocode.kilo-code',
      'settings',
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mcp_settings.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }),
    );
    const clients = detectMcpClients(projectRoot);
    const kilo = clients.find((c) => c.name === 'kilocode');
    expect(kilo).toBeDefined();
    expect(kilo?.hasTraceMcp).toBe(false);
  });
});

describe('Antigravity detection', () => {
  it('detects ~/.gemini/config/mcp_config.json with trace-mcp entry', () => {
    const dir = path.join(fakeHome, '.gemini', 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: { 'trace-mcp': { command: '/bin/true', args: ['serve'] } },
      }),
    );
    const clients = detectMcpClients(projectRoot);
    const anti = clients.find((c) => c.name === 'antigravity');
    expect(anti?.hasTraceMcp).toBe(true);
  });
});

describe('Kimi detection', () => {
  it('detects ~/.kimi/mcp.json without trace-mcp', () => {
    const dir = path.join(fakeHome, '.kimi');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const clients = detectMcpClients(projectRoot);
    const kimi = clients.find((c) => c.name === 'kimi');
    expect(kimi).toBeDefined();
    expect(kimi?.hasTraceMcp).toBe(false);
  });
});

describe('Cline / KiloCode / Antigravity / Kimi writers (standard mcpServers)', () => {
  it('Cline: creates cline_mcp_settings.json with trace-mcp serve entry', () => {
    const results = configureMcpClients(['cline'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('created');
    const file = path.join(
      vscodeUserDir(fakeHome),
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const entry = parsed.mcpServers['trace'];
    expect(entry.args).toEqual(['serve']);
    // Cline's config is global-only, so it never carries a project cwd (TRA-501).
    expect(entry.cwd).toBeUndefined();
    // Standard shape clients must not carry the Claude-only alwaysLoad flag.
    expect(entry.alwaysLoad).toBeUndefined();
  });

  it('KiloCode: creates mcp_settings.json and preserves existing servers', () => {
    const file = path.join(
      vscodeUserDir(fakeHome),
      'globalStorage',
      'kilocode.kilo-code',
      'settings',
      'mcp_settings.json',
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['@linear/mcp'] } } }),
    );
    configureMcpClients(['kilocode'], projectRoot, { scope: 'global' });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers.linear).toBeDefined();
    expect(parsed.mcpServers['trace'].args).toEqual(['serve']);
  });

  it('Antigravity: writes ~/.gemini/config/mcp_config.json', () => {
    const results = configureMcpClients(['antigravity'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('created');
    const file = path.join(fakeHome, '.gemini', 'config', 'mcp_config.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers['trace'].args).toEqual(['serve']);
  });

  it('Kimi: writes ~/.kimi/mcp.json and reports already_configured on re-run', () => {
    const first = configureMcpClients(['kimi'], projectRoot, { scope: 'global' });
    expect(first[0].action).toBe('created');
    const file = path.join(fakeHome, '.kimi', 'mcp.json');
    expect(fs.existsSync(file)).toBe(true);
    const second = configureMcpClients(['kimi'], projectRoot, { scope: 'global' });
    expect(second[0].action).toBe('already_configured');
  });
});

describe('Warp configuration', () => {
  it('always returns skipped with paste-snippet detail', () => {
    const results = configureMcpClients(['warp'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('skipped');
    expect(results[0].detail).toContain('Settings');
    expect(results[0].detail).toContain('"trace"');
  });

  it('includes claude-code inheritance hint when both selected', () => {
    const results = configureMcpClients(['warp', 'claude-code'], projectRoot, { scope: 'global' });
    const warp = results.find((r) => r.target === 'Warp');
    expect(warp?.detail).toContain('File-based MCP servers');
  });
});

// ---------------------------------------------------------------------------
// TRA-610: `trace-mcp` → `trace`. A config that still carries the old key must
// come out with exactly one entry, under the new key — leaving both behind
// would make the client spawn two copies of the same server, which is the
// opposite of the token saving the rename is for.
// ---------------------------------------------------------------------------

describe('legacy server-key migration (TRA-610)', () => {
  it('JSON: replaces the pre-rename mcpServers key, keeping other servers', () => {
    const file = path.join(fakeHome, '.gemini', 'config', 'mcp_config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          linear: { command: 'linear-mcp' },
          'trace-mcp': { command: '/old/launcher', args: ['serve'] },
        },
      }),
    );

    configureMcpClients(['antigravity'], projectRoot, { scope: 'global' });

    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers['trace-mcp']).toBeUndefined();
    expect(parsed.mcpServers.trace.args).toEqual(['serve']);
    expect(parsed.mcpServers.linear).toBeDefined();
  });

  it('Factory Droid JSON: replaces the pre-rename key', () => {
    const file = path.join(fakeHome, '.factory', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { 'trace-mcp': { type: 'stdio', command: '/old', args: ['serve'] } },
      }),
    );

    configureMcpClients(['factory-droid'], projectRoot, { scope: 'global' });

    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers['trace-mcp']).toBeUndefined();
    expect(parsed.mcpServers.trace.type).toBe('stdio');
  });

  it('AMP JSONC: replaces the pre-rename key and keeps comments', () => {
    const file = path.join(fakeHome, '.config', 'amp', 'settings.jsonc');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        '// User-managed AMP settings',
        '{',
        '  "amp.mcpServers": {',
        '    "trace-mcp": { "command": "/old", "args": ["serve"] }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    configureMcpClients(['amp'], projectRoot, { scope: 'global' });

    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toContain('// User-managed AMP settings');
    expect(after).not.toContain('"trace-mcp"');
    expect(after).toContain('"trace"');
  });

  it('Hermes YAML: replaces the pre-rename key', () => {
    const file = path.join(fakeHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      'mcp_servers:\n  trace-mcp:\n    command: /old\n    args:\n      - serve\n',
    );

    configureMcpClients(['hermes'], projectRoot, { scope: 'global' });

    const after = fs.readFileSync(file, 'utf-8');
    expect(after).not.toMatch(/^\s+trace-mcp:/m);
    expect(after).toMatch(/^\s+trace:/m);
  });

  it('Codex TOML: drops the pre-rename table instead of appending a second one', () => {
    const file = path.join(fakeHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.trace-mcp]',
        'command = "/old"',
        'args = ["serve"]',
        '',
        '[mcp_servers.linear]',
        'command = "linear-mcp"',
        '',
      ].join('\n'),
    );

    configureMcpClients(['codex'], projectRoot, { scope: 'global' });

    const after = fs.readFileSync(file, 'utf-8');
    expect(after).not.toContain('[mcp_servers.trace-mcp]');
    expect(after).toContain('[mcp_servers.trace]');
    expect(after).toContain('[mcp_servers.linear]');
    expect(after).toContain('model = "gpt-5"');
  });
});

// ---------------------------------------------------------------------------
// Review findings on the TRA-610 migration. Each of these shipped green once
// because the original tests asserted on substrings rather than on the parsed
// result, so they assert on structure here.
// ---------------------------------------------------------------------------

describe('legacy server-key migration — review regressions (TRA-610)', () => {
  it('Codex TOML: leaves the rest of the file valid, `args` array intact', () => {
    const file = path.join(fakeHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.trace-mcp]',
        'command = "/old"',
        'args = ["serve"]',
        '',
        '[mcp_servers.trace-mcp.env]',
        'FOO = "1"',
        '',
        '[mcp_servers.linear]',
        'command = "linear-mcp"',
        'args = ["run", "--flag"]',
        '',
      ].join('\n'),
    );

    configureMcpClients(['codex'], projectRoot, { scope: 'global' });

    const after = fs.readFileSync(file, 'utf-8');
    // The bug turned `args = ["serve"]` into an orphan `["serve"]` table header.
    for (const line of after.split('\n')) {
      if (/^\s*\[/.test(line)) {
        expect(line).toMatch(/^\s*\[[A-Za-z_][\w.\-"']*\]\s*$/);
      }
    }
    expect(after).not.toContain('[mcp_servers.trace-mcp]');
    expect(after).not.toContain('[mcp_servers.trace-mcp.env]');
    expect(after).toContain('[mcp_servers.trace]');
    expect(after).toContain('model = "gpt-5"');
    expect(after).toContain('[mcp_servers.linear]');
    expect(after).toContain('args = ["run", "--flag"]');
  });

  it('Codex TOML: a legacy table is rewritten even when a `trace` table exists', () => {
    const file = path.join(fakeHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '[mcp_servers.trace]\ncommand = "/new"\n\n[mcp_servers.trace-mcp]\ncommand = "/old"\n',
    );

    configureMcpClients(['codex'], projectRoot, { scope: 'global' });

    const after = fs.readFileSync(file, 'utf-8');
    expect(after).not.toContain('[mcp_servers.trace-mcp]');
    expect(after.match(/\[mcp_servers\.trace\]/g)).toHaveLength(1);
  });

  it('JSON: a config holding BOTH keys is rewritten, not reported already_configured', () => {
    const file = path.join(projectRoot, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Seed a `trace` entry that matches exactly what we would write, so only
    // the surviving legacy key can force the rewrite.
    configureMcpClients(['cursor'], projectRoot, { scope: 'project' });
    const seeded = JSON.parse(fs.readFileSync(file, 'utf-8'));
    seeded.mcpServers['trace-mcp'] = { command: '/old', args: ['serve'] };
    seeded.mcpServers.linear = { command: 'linear-mcp' };
    fs.writeFileSync(file, JSON.stringify(seeded, null, 2));

    const [status] = getMcpClientStatuses(projectRoot, 'project', ['cursor']);
    expect(status.status).toBe('stale');
    expect(status.staleReason).toBe('server-key');

    const results = configureMcpClients(['cursor'], projectRoot, { scope: 'project' });
    expect(results[0].action).not.toBe('already_configured');

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.mcpServers['trace-mcp']).toBeUndefined();
    expect(after.mcpServers.trace).toBeDefined();
    expect(after.mcpServers.linear).toBeDefined();
  });

  it('Hermes YAML: both keys present is reported stale, and the old one is dropped', () => {
    const file = path.join(fakeHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    configureMcpClients(['hermes'], projectRoot, { scope: 'global' });
    fs.appendFileSync(file, '  trace-mcp:\n    command: /old\n');

    const [status] = getMcpClientStatuses(projectRoot, 'global', ['hermes']);
    expect(status.status).toBe('stale');
    expect(status.staleReason).toBe('server-key');

    configureMcpClients(['hermes'], projectRoot, { scope: 'global' });
    expect(fs.readFileSync(file, 'utf-8')).not.toMatch(/^\s+trace-mcp:/m);
  });
});
