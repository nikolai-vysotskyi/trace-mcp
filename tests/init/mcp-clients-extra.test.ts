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
  // Zed honors $XDG_CONFIG_HOME on Linux — pin it empty so the user path
  // resolves to the sandbox default no matter what the CI host exports.
  vi.stubEnv('XDG_CONFIG_HOME', '');
  // Force re-evaluation of module-level `const HOME = os.homedir()` against the spy.
  vi.resetModules();
  ({ detectMcpClients } = await import('../../src/init/detector.js'));
  ({ configureMcpClients } = await import('../../src/init/mcp-client.js'));
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

  it('migrates a legacy "trace-mcp" entry to "trace" in place', () => {
    const dir = path.join(fakeHome, '.config', 'amp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        'amp.mcpServers': { 'trace-mcp': { command: '/old/launcher', args: ['serve'] } },
      }),
    );

    configureMcpClients(['amp'], projectRoot, { scope: 'global' });

    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed['amp.mcpServers']['trace-mcp']).toBeUndefined();
    expect(parsed['amp.mcpServers'].trace.args).toEqual(['serve']);
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

  it('preserves existing servers when adding trace', () => {
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

  it('migrates a legacy "trace-mcp" entry to "trace" in place', () => {
    const file = path.join(fakeHome, '.factory', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { 'trace-mcp': { type: 'stdio', command: '/old/launcher', args: ['serve'] } },
      }),
    );
    configureMcpClients(['factory-droid'], projectRoot, { scope: 'global' });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers['trace-mcp']).toBeUndefined();
    expect(parsed.mcpServers.trace.type).toBe('stdio');
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

describe('Gemini CLI detection', () => {
  it('detects ~/.gemini/settings.json with a trace entry', () => {
    const dir = path.join(fakeHome, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        theme: 'Default',
        mcpServers: { trace: { command: '/bin/true', args: ['serve'] } },
      }),
    );
    const clients = detectMcpClients(projectRoot);
    const gemini = clients.find((c) => c.name === 'gemini-cli');
    expect(gemini).toBeDefined();
    expect(gemini?.hasTraceMcp).toBe(true);
  });

  it('detects ~/.gemini/settings.json without trace-mcp', () => {
    const dir = path.join(fakeHome, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mcpServers: {} }));
    const clients = detectMcpClients(projectRoot);
    const gemini = clients.find((c) => c.name === 'gemini-cli');
    expect(gemini).toBeDefined();
    expect(gemini?.hasTraceMcp).toBe(false);
  });
});

describe('Antigravity vs Gemini CLI path separation (TRA-1659)', () => {
  it('does not report antigravity when only ~/.gemini/settings.json (Gemini CLI) exists', () => {
    const dir = path.join(fakeHome, '.gemini');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ mcpServers: { trace: { command: '/bin/true', args: ['serve'] } } }),
    );
    const clients = detectMcpClients(projectRoot);
    expect(clients.find((c) => c.name === 'antigravity')).toBeUndefined();
    expect(clients.find((c) => c.name === 'gemini-cli')?.hasTraceMcp).toBe(true);
  });

  it('does not report gemini-cli when only ~/.gemini/config/mcp_config.json (Antigravity) exists', () => {
    const dir = path.join(fakeHome, '.gemini', 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { trace: { command: '/bin/true', args: ['serve'] } } }),
    );
    const clients = detectMcpClients(projectRoot);
    expect(clients.find((c) => c.name === 'gemini-cli')).toBeUndefined();
    expect(clients.find((c) => c.name === 'antigravity')?.hasTraceMcp).toBe(true);
  });

  it('reports both independently when both files exist', () => {
    const geminiDir = path.join(fakeHome, '.gemini');
    const antiDir = path.join(fakeHome, '.gemini', 'config');
    fs.mkdirSync(antiDir, { recursive: true });
    fs.writeFileSync(
      path.join(geminiDir, 'settings.json'),
      JSON.stringify({ mcpServers: { trace: { command: '/bin/true', args: ['serve'] } } }),
    );
    fs.writeFileSync(path.join(antiDir, 'mcp_config.json'), JSON.stringify({ mcpServers: {} }));
    const clients = detectMcpClients(projectRoot);
    expect(clients.find((c) => c.name === 'gemini-cli')?.hasTraceMcp).toBe(true);
    expect(clients.find((c) => c.name === 'antigravity')?.hasTraceMcp).toBe(false);
  });
});

describe('Cline / KiloCode / Antigravity / Kimi writers (standard mcpServers)', () => {
  it('Cline: creates cline_mcp_settings.json with trace serve entry', () => {
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

  it('Gemini CLI: writes ~/.gemini/settings.json and reports already_configured on re-run', () => {
    const first = configureMcpClients(['gemini-cli'], projectRoot, { scope: 'global' });
    expect(first[0].action).toBe('created');
    const file = path.join(fakeHome, '.gemini', 'settings.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers['trace'].args).toEqual(['serve']);
    const second = configureMcpClients(['gemini-cli'], projectRoot, { scope: 'global' });
    expect(second[0].action).toBe('already_configured');
  });

  it('Gemini CLI: preserves other settings.json keys and existing servers', () => {
    // settings.json carries the whole CLI config (theme, model, …) — the
    // writer must only touch mcpServers (TRA-1659).
    const file = path.join(fakeHome, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: 'Default',
        mcpServers: { linear: { command: 'npx', args: ['@linear/mcp'] } },
      }),
    );
    configureMcpClients(['gemini-cli'], projectRoot, { scope: 'global' });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.theme).toBe('Default');
    expect(parsed.mcpServers.linear).toBeDefined();
    expect(parsed.mcpServers['trace'].args).toEqual(['serve']);
  });

  it('Gemini CLI: migrates a legacy "trace-mcp" entry to "trace" in place', () => {
    const file = path.join(fakeHome, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { 'trace-mcp': { command: '/old/launcher', args: ['serve'] } },
      }),
    );
    configureMcpClients(['gemini-cli'], projectRoot, { scope: 'global' });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers['trace-mcp']).toBeUndefined();
    expect(parsed.mcpServers.trace.args).toEqual(['serve']);
  });

  it('Gemini CLI write does not touch the Antigravity file and vice versa', () => {
    configureMcpClients(['gemini-cli'], projectRoot, { scope: 'global' });
    expect(fs.existsSync(path.join(fakeHome, '.gemini', 'config', 'mcp_config.json'))).toBe(false);
    configureMcpClients(['antigravity'], projectRoot, { scope: 'global' });
    const gemini = JSON.parse(
      fs.readFileSync(path.join(fakeHome, '.gemini', 'settings.json'), 'utf-8'),
    );
    const anti = JSON.parse(
      fs.readFileSync(path.join(fakeHome, '.gemini', 'config', 'mcp_config.json'), 'utf-8'),
    );
    expect(gemini.mcpServers['trace'].args).toEqual(['serve']);
    expect(anti.mcpServers['trace'].args).toEqual(['serve']);
  });
});

describe('MiniMax Code detection (TRA-1670)', () => {
  it('detects ~/.minimax/mcp.json with a trace entry', () => {
    const dir = path.join(fakeHome, '.minimax');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mcp.json'),
      JSON.stringify({ mcpServers: { trace: { command: '/bin/true', args: ['serve'] } } }),
    );
    const clients = detectMcpClients(projectRoot);
    expect(clients.find((c) => c.name === 'minimax-code')?.hasTraceMcp).toBe(true);
  });

  it('detects ~/.minimax/mcp.json without trace-mcp', () => {
    const dir = path.join(fakeHome, '.minimax');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const clients = detectMcpClients(projectRoot);
    const minimax = clients.find((c) => c.name === 'minimax-code');
    expect(minimax).toBeDefined();
    expect(minimax?.hasTraceMcp).toBe(false);
  });

  it('detects the legacy ~/.mavis/mcp/mcp.json location', () => {
    const dir = path.join(fakeHome, '.mavis', 'mcp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mcp.json'),
      JSON.stringify({ mcpServers: { trace: { command: '/bin/true', args: ['serve'] } } }),
    );
    const clients = detectMcpClients(projectRoot);
    const rows = clients.filter((c) => c.name === 'minimax-code');
    expect(rows).toHaveLength(1);
    expect(rows[0].configPath).toBe(path.join(dir, 'mcp.json'));
    expect(rows[0].hasTraceMcp).toBe(true);
  });

  it('prefers the primary file when both primary and legacy exist', () => {
    for (const dir of [path.join(fakeHome, '.minimax'), path.join(fakeHome, '.mavis', 'mcp')]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    }
    const clients = detectMcpClients(projectRoot);
    const rows = clients.filter((c) => c.name === 'minimax-code');
    expect(rows).toHaveLength(1);
    expect(rows[0].configPath).toBe(path.join(fakeHome, '.minimax', 'mcp.json'));
  });
});

describe('MiniMax Code writer (standard mcpServers, TRA-1670)', () => {
  it('creates ~/.minimax/mcp.json and reports already_configured on re-run', () => {
    const first = configureMcpClients(['minimax-code'], projectRoot, { scope: 'global' });
    expect(first[0].action).toBe('created');
    const file = path.join(fakeHome, '.minimax', 'mcp.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers['trace'].args).toEqual(['serve']);
    expect(parsed.mcpServers['trace'].alwaysLoad).toBeUndefined();
    const second = configureMcpClients(['minimax-code'], projectRoot, { scope: 'global' });
    expect(second[0].action).toBe('already_configured');
  });

  it('writes into the legacy file when that is where the user data is', () => {
    const legacy = path.join(fakeHome, '.mavis', 'mcp', 'mcp.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(
      legacy,
      JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['@linear/mcp'] } } }),
    );
    configureMcpClients(['minimax-code'], projectRoot, { scope: 'global' });
    const parsed = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
    expect(parsed.mcpServers.linear).toBeDefined();
    expect(parsed.mcpServers['trace'].args).toEqual(['serve']);
    // No fork into the primary location.
    expect(fs.existsSync(path.join(fakeHome, '.minimax', 'mcp.json'))).toBe(false);
  });

  it('migrates a legacy "trace-mcp" entry to "trace" in place', () => {
    const file = path.join(fakeHome, '.minimax', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { 'trace-mcp': { command: '/old/launcher', args: ['serve'] } },
      }),
    );
    configureMcpClients(['minimax-code'], projectRoot, { scope: 'global' });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.mcpServers['trace-mcp']).toBeUndefined();
    expect(parsed.mcpServers.trace.args).toEqual(['serve']);
  });
});

describe('Zed detection (TRA-1658)', () => {
  // Mirror getConfigPath's platform branch: %APPDATA%\Zed on Windows
  // (APPDATA is stubbed to the sandbox), ~/.config/zed elsewhere.
  function userFile(): string {
    if (process.platform === 'win32') {
      return path.join(fakeHome, 'AppData', 'Roaming', 'Zed', 'settings.json');
    }
    return path.join(fakeHome, '.config', 'zed', 'settings.json');
  }

  it('detects a context_servers trace entry stamped source:custom', () => {
    fs.mkdirSync(path.dirname(userFile()), { recursive: true });
    fs.writeFileSync(
      userFile(),
      JSON.stringify({
        context_servers: { trace: { source: 'custom', command: '/bin/true', args: ['serve'] } },
      }),
    );
    const clients = detectMcpClients(projectRoot);
    expect(clients.find((c) => c.name === 'zed')?.hasTraceMcp).toBe(true);
  });

  it('detects settings.json without trace-mcp', () => {
    fs.mkdirSync(path.dirname(userFile()), { recursive: true });
    fs.writeFileSync(userFile(), JSON.stringify({ context_servers: {} }));
    const clients = detectMcpClients(projectRoot);
    const zed = clients.find((c) => c.name === 'zed');
    expect(zed).toBeDefined();
    expect(zed?.hasTraceMcp).toBe(false);
  });

  it('detects the project .zed/settings.json layer', () => {
    const file = path.join(projectRoot, '.zed', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ context_servers: { trace: { command: '/bin/true', args: [] } } }),
    );
    const clients = detectMcpClients(projectRoot);
    expect(clients.find((c) => c.name === 'zed')?.hasTraceMcp).toBe(true);
  });

  it('does not read mcpServers as a Zed entry', () => {
    fs.mkdirSync(path.dirname(userFile()), { recursive: true });
    fs.writeFileSync(
      userFile(),
      JSON.stringify({ mcpServers: { trace: { command: '/bin/true', args: ['serve'] } } }),
    );
    const clients = detectMcpClients(projectRoot);
    expect(clients.find((c) => c.name === 'zed')?.hasTraceMcp).toBe(false);
  });
});

describe('Zed writer (context_servers + source:custom, TRA-1658)', () => {
  // Same platform branch as detection above.
  function userFile(): string {
    if (process.platform === 'win32') {
      return path.join(fakeHome, 'AppData', 'Roaming', 'Zed', 'settings.json');
    }
    return path.join(fakeHome, '.config', 'zed', 'settings.json');
  }

  it('creates settings.json with a source:custom trace entry', () => {
    const results = configureMcpClients(['zed'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('created');
    const parsed = JSON.parse(fs.readFileSync(userFile(), 'utf-8'));
    expect(parsed.context_servers['trace']).toMatchObject({
      source: 'custom',
      args: ['serve'],
    });
    expect(parsed.context_servers['trace'].alwaysLoad).toBeUndefined();
    const second = configureMcpClients(['zed'], projectRoot, { scope: 'global' });
    expect(second[0].action).toBe('already_configured');
  });

  it('preserves other editor settings, servers and comments', () => {
    fs.mkdirSync(path.dirname(userFile()), { recursive: true });
    fs.writeFileSync(
      userFile(),
      [
        '// editor theme',
        '{"theme": "One Dark",',
        ' "context_servers": {',
        '  "linear": {"command": "npx", "args": ["@linear/mcp"]}',
        ' }}',
      ].join('\n'),
    );
    configureMcpClients(['zed'], projectRoot, { scope: 'global' });
    const text = fs.readFileSync(userFile(), 'utf-8');
    expect(text).toContain('// editor theme');
    expect(text).toContain('"theme": "One Dark"');
    const parsed = JSON.parse(text.replace('// editor theme\n', ''));
    expect(parsed.context_servers.linear).toBeDefined();
    expect(parsed.context_servers['trace'].source).toBe('custom');
  });

  it('keeps a comment inside context_servers next to the edited entry', () => {
    fs.mkdirSync(path.dirname(userFile()), { recursive: true });
    fs.writeFileSync(
      userFile(),
      [
        '{',
        ' "context_servers": {',
        '  // reached over stdio; keep alive',
        '  "linear": {"command": "npx", "args": ["@linear/mcp"]}',
        ' }}',
      ].join('\n'),
    );
    configureMcpClients(['zed'], projectRoot, { scope: 'global' });
    const text = fs.readFileSync(userFile(), 'utf-8');
    expect(text).toContain('// reached over stdio; keep alive');
    expect(text).toContain('"linear"');
    expect(text).toContain('"trace"');
  });

  it('writes project scope to .zed/settings.json with pinned cwd', () => {
    const results = configureMcpClients(['zed'], projectRoot, { scope: 'project' });
    expect(results[0].action).toBe('created');
    const file = path.join(projectRoot, '.zed', 'settings.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.context_servers['trace'].cwd).toBe(projectRoot);
  });

  it('migrates a legacy "trace-mcp" entry to "trace" in place', () => {
    fs.mkdirSync(path.dirname(userFile()), { recursive: true });
    fs.writeFileSync(
      userFile(),
      JSON.stringify({
        context_servers: { 'trace-mcp': { command: '/old/launcher', args: ['serve'] } },
      }),
    );
    configureMcpClients(['zed'], projectRoot, { scope: 'global' });
    const parsed = JSON.parse(fs.readFileSync(userFile(), 'utf-8'));
    expect(parsed.context_servers['trace-mcp']).toBeUndefined();
    expect(parsed.context_servers.trace.args).toEqual(['serve']);
    expect(parsed.context_servers.trace.source).toBe('custom');
  });

  // XDG is only honored on non-Windows (the win32 branch wins first).
  it.skipIf(process.platform === 'win32')(
    'honors $XDG_CONFIG_HOME for the user file when exported',
    () => {
      const xdg = path.join(sandbox, 'xdg');
      vi.stubEnv('XDG_CONFIG_HOME', xdg);
      const results = configureMcpClients(['zed'], projectRoot, { scope: 'global' });
      expect(results[0].action).toBe('created');
      const file = path.join(xdg, 'zed', 'settings.json');
      expect(results[0].target).toBe(file);
      expect(fs.existsSync(file)).toBe(true);
    },
  );
});

describe('Hermes YAML writer', () => {
  function configPath(): string {
    return path.join(fakeHome, '.hermes', 'config.yaml');
  }

  it('writes a new config.yaml with a trace mcp_servers entry', () => {
    const results = configureMcpClients(['hermes'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('created');
    const content = fs.readFileSync(configPath(), 'utf-8');
    expect(content).toMatch(/mcp_servers:\s*\n\s+trace:/);
    expect(content).not.toContain('trace-mcp:');
  });

  it('migrates a legacy "trace-mcp" entry to "trace", preserving comments', () => {
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        '# user comment',
        'mcp_servers:',
        '  trace-mcp:',
        '    command: /old/launcher',
        '    args:',
        '      - serve',
        '',
      ].join('\n'),
    );
    configureMcpClients(['hermes'], projectRoot, { scope: 'global' });
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('# user comment');
    expect(content).not.toContain('trace-mcp:');
    expect(content).toMatch(/mcp_servers:\s*\n\s+trace:/);
  });
});

describe('Codex TOML writer', () => {
  function configPath(): string {
    return path.join(fakeHome, '.codex', 'config.toml');
  }

  it('appends a [mcp_servers.trace] section to a new file', () => {
    const results = configureMcpClients(['codex'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('created');
    const content = fs.readFileSync(configPath(), 'utf-8');
    expect(content).toContain('[mcp_servers.trace]');
    expect(content).not.toContain('[mcp_servers.trace-mcp]');
  });

  it('migrates a legacy [mcp_servers.trace-mcp] section (with .env sub-table) in place', () => {
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        '[some_other_tool]',
        'command = "keep-me"',
        '',
        '[mcp_servers.trace-mcp]',
        'command = "/old/launcher"',
        'args = ["serve"]',
        '[mcp_servers.trace-mcp.env]',
        'FOO = "bar"',
        '',
      ].join('\n'),
    );
    configureMcpClients(['codex'], projectRoot, { scope: 'global' });
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('[some_other_tool]'); // untouched, unrelated section survives
    expect(content).not.toContain('[mcp_servers.trace-mcp]');
    expect(content).toContain('[mcp_servers.trace]');
  });

  it('does not duplicate [mcp_servers.trace] when both the new and legacy sections already exist', () => {
    // An interrupted prior migration, or a hand-edited config, can leave both
    // sections present. Appending a fresh [mcp_servers.trace] block on top of
    // an existing one produces two headers with the same name, which is
    // invalid TOML.
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        '[mcp_servers.trace]',
        'command = "/old/launcher"',
        'args = ["serve"]',
        '',
        '[mcp_servers.trace-mcp]',
        'command = "/old/launcher"',
        'args = ["serve"]',
        '',
      ].join('\n'),
    );
    configureMcpClients(['codex'], projectRoot, { scope: 'global' });
    const content = fs.readFileSync(file, 'utf-8');
    expect(content.match(/\[mcp_servers\.trace\]/g)).toHaveLength(1);
    expect(content).not.toContain('[mcp_servers.trace-mcp]');
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

describe('OpenCode detection', () => {
  it('parses ~/.config/opencode/opencode.json and detects trace-mcp', () => {
    const dir = path.join(fakeHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          'trace-mcp': {
            type: 'local',
            command: ['trace-mcp', 'serve'],
            enabled: true,
          },
        },
      }),
    );
    const clients = detectMcpClients(projectRoot);
    const opencode = clients.find((c) => c.name === 'opencode');
    expect(opencode).toBeDefined();
    expect(opencode?.hasTraceMcp).toBe(true);
  });

  it('parses opencode.jsonc with comments and detects trace', () => {
    const dir = path.join(fakeHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'opencode.jsonc'),
      [
        '// OpenCode user settings',
        '{',
        '  /* MCP servers */',
        '  "mcp": {',
        '    "trace": {',
        '      "type": "local",',
        '      "command": ["/path/to/trace-mcp", "serve"],',
        '      "enabled": true',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    const clients = detectMcpClients(projectRoot);
    const opencode = clients.find((c) => c.name === 'opencode');
    expect(opencode).toBeDefined();
    expect(opencode?.hasTraceMcp).toBe(true);
    expect(opencode?.configPath).toMatch(/opencode\.jsonc$/);
  });

  it('falls back to project-level opencode.json when user-level is absent', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'opencode.json'),
      JSON.stringify({
        mcp: {
          trace: {
            type: 'local',
            command: ['trace-mcp', 'serve'],
            enabled: true,
          },
        },
      }),
    );
    const clients = detectMcpClients(projectRoot);
    const opencode = clients.find((c) => c.name === 'opencode');
    expect(opencode?.hasTraceMcp).toBe(true);
    expect(opencode?.configPath.startsWith(projectRoot)).toBe(true);
  });
});

describe('OpenCode configuration', () => {
  it('creates global opencode.json with local MCP entry', () => {
    const results = configureMcpClients(['opencode'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('created');

    const configPath = path.join(fakeHome, '.config', 'opencode', 'opencode.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(content.mcp).toBeDefined();
    expect(content.mcp.trace).toEqual({
      type: 'local',
      command: [expect.stringContaining('trace-mcp'), 'serve'],
      enabled: true,
    });
  });

  it('creates project-level opencode.json when scope is project', () => {
    const results = configureMcpClients(['opencode'], projectRoot, { scope: 'project' });
    expect(results[0].action).toBe('created');

    const configPath = path.join(projectRoot, 'opencode.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(content.mcp.trace.type).toBe('local');
    expect(content.mcp.trace.enabled).toBe(true);
    expect(content.mcp.trace.command[1]).toBe('serve');
  });

  it('migrates legacy trace-mcp key to trace in place', () => {
    const dir = path.join(fakeHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcp: {
          'trace-mcp': {
            type: 'local',
            command: ['trace-mcp', 'serve'],
            enabled: true,
          },
        },
      }),
    );

    const results = configureMcpClients(['opencode'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('updated');

    const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(content.mcp['trace-mcp']).toBeUndefined();
    expect(content.mcp.trace).toBeDefined();
    expect(content.mcp.trace.type).toBe('local');
    expect(content.mcp.trace.enabled).toBe(true);
  });

  it('reports already_configured when entry matches', () => {
    configureMcpClients(['opencode'], projectRoot, { scope: 'global' });
    const results = configureMcpClients(['opencode'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('already_configured');
  });
});

describe('Codex configuration and drift recovery', () => {
  it('creates codex config with trace section when missing', () => {
    const results = configureMcpClients(['codex'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('created');
    const configPath = path.join(fakeHome, '.codex', 'config.toml');
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('[mcp_servers.trace]');
    expect(content).toContain('args = ["serve"]');
  });

  it('reports already_configured when codex entry matches', () => {
    configureMcpClients(['codex'], projectRoot, { scope: 'global' });
    const results = configureMcpClients(['codex'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('already_configured');
  });

  it('updates codex config when launcher path drifts', () => {
    const configPath = path.join(fakeHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      '[mcp_servers.trace]\ncommand = "/outdated/dead/path/trace"\nargs = ["serve"]\n',
    );

    const results = configureMcpClients(['codex'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('updated');

    const updated = fs.readFileSync(configPath, 'utf-8');
    expect(updated).not.toContain('/outdated/dead/path/trace');
    expect(updated).toContain('[mcp_servers.trace]');
    expect(updated).toContain('args = ["serve"]');
  });

  it('migrates legacy trace-mcp section to trace', () => {
    const configPath = path.join(fakeHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      '[mcp_servers.trace-mcp]\ncommand = "/some/path/trace-mcp"\nargs = ["serve"]\n',
    );

    const results = configureMcpClients(['codex'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('updated');

    const updated = fs.readFileSync(configPath, 'utf-8');
    expect(updated).not.toContain('[mcp_servers.trace-mcp]');
    expect(updated).toContain('[mcp_servers.trace]');
  });

  it('writes a project-scoped .codex/config.toml with cwd pinned to the project', () => {
    const results = configureMcpClients(['codex'], projectRoot, { scope: 'project' });
    expect(results[0].action).toBe('created');

    const configPath = path.join(projectRoot, '.codex', 'config.toml');
    expect(results[0].target).toBe(configPath);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('[mcp_servers.trace]');
    expect(content).toContain(`cwd = "${projectRoot}"`);
    // The global file stays untouched — project scope must not leak there.
    expect(fs.existsSync(path.join(fakeHome, '.codex', 'config.toml'))).toBe(false);
  });

  it('reports already_configured on a repeated project-scoped run', () => {
    configureMcpClients(['codex'], projectRoot, { scope: 'project' });
    const second = configureMcpClients(['codex'], projectRoot, { scope: 'project' });
    expect(second[0].action).toBe('already_configured');
  });

  it('migrates a legacy section in the project-scoped config', () => {
    const configPath = path.join(projectRoot, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      '[mcp_servers.trace-mcp]\ncommand = "/old/launcher"\nargs = ["serve"]\n',
    );

    const results = configureMcpClients(['codex'], projectRoot, { scope: 'project' });
    expect(results[0].action).toBe('updated');

    const updated = fs.readFileSync(configPath, 'utf-8');
    expect(updated).not.toContain('[mcp_servers.trace-mcp]');
    expect(updated).toContain('[mcp_servers.trace]');
    expect(updated).toContain(`cwd = "${projectRoot}"`);
  });

  it('repairs a drifted project-scoped entry back to the pinned cwd', () => {
    configureMcpClients(['codex'], projectRoot, { scope: 'project' });
    const configPath = path.join(projectRoot, '.codex', 'config.toml');
    const content = fs.readFileSync(configPath, 'utf-8');
    fs.writeFileSync(configPath, content.replace(`cwd = "${projectRoot}"`, 'cwd = "/stale/dir"'));

    const results = configureMcpClients(['codex'], projectRoot, { scope: 'project' });
    expect(results[0].action).toBe('updated');
    expect(fs.readFileSync(configPath, 'utf-8')).toContain(`cwd = "${projectRoot}"`);
  });
});
