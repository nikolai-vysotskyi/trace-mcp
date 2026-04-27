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
  // os.homedir() on macOS reads getpwuid_r, not $HOME — env stubs alone are
  // not enough. Spy on os.homedir() so the module-level `const HOME =
  // os.homedir()` captures the sandbox path. Without this, every test that
  // exercises a writer leaks into the real user config.
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
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
    expect(after).toContain('"trace-mcp"');
    expect(after).toContain('"linear"');
  });

  it('writes a new settings.json when no AMP config exists', () => {
    const results = configureMcpClients(['amp'], projectRoot, { scope: 'global' });
    const step = results[0];
    expect(step.action).toBe('created');
    const file = path.join(fakeHome, '.config', 'amp', 'settings.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed['amp.mcpServers']?.['trace-mcp']?.args).toEqual(['serve']);
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
    const entry = parsed.mcpServers['trace-mcp'];
    expect(entry.type).toBe('stdio');
    expect(entry.args).toEqual(['serve']);
    expect(entry.cwd).toBe(projectRoot);
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
    expect(parsed.mcpServers['trace-mcp']).toBeDefined();
  });
});

describe('Warp configuration', () => {
  it('always returns skipped with paste-snippet detail', () => {
    const results = configureMcpClients(['warp'], projectRoot, { scope: 'global' });
    expect(results[0].action).toBe('skipped');
    expect(results[0].detail).toContain('Settings');
    expect(results[0].detail).toContain('"trace-mcp"');
  });

  it('includes claude-code inheritance hint when both selected', () => {
    const results = configureMcpClients(['warp', 'claude-code'], projectRoot, { scope: 'global' });
    const warp = results.find((r) => r.target === 'Warp');
    expect(warp?.detail).toContain('File-based MCP servers');
  });
});
