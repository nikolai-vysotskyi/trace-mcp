import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

function readJson(...parts: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, ...parts), 'utf8'));
}

describe('Claude Code plugin manifests', () => {
  const pkg = readJson('package.json');
  const plugin = readJson('.claude-plugin', 'plugin.json');
  const marketplace = readJson('.claude-plugin', 'marketplace.json');

  it('plugin.json version matches package.json version', () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it('marketplace.json plugin entry version matches package.json version', () => {
    const plugins = marketplace.plugins as Array<{ name: string; version: string }>;
    const entry = plugins.find((p) => p.name === 'trace-mcp');
    expect(entry).toBeDefined();
    expect(entry?.version).toBe(pkg.version);
  });

  it('plugin.json mcpServers points at the bin name from package.json', () => {
    const bin = pkg.bin as Record<string, string>;
    const servers = plugin.mcpServers as Record<string, { command: string }>;
    const command = servers['trace-mcp']?.command;
    expect(command).toBeDefined();
    // command must be one of the declared bin names so npm install -g exposes it on PATH
    expect(Object.keys(bin)).toContain(command);
  });

  it('plugin manifest is shipped in the npm tarball (files field)', () => {
    const files = pkg.files as string[];
    expect(files).toContain('.claude-plugin');
  });

  it('hooks.json references hook scripts that exist on disk', () => {
    const hooks = readJson('.claude-plugin', 'hooks', 'hooks.json') as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const hookCommands = Object.values(hooks.hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(hookCommands.length).toBeGreaterThan(0);
    // every command should reference a script under hooks/
    for (const cmd of hookCommands) {
      const match = cmd.match(/hooks\/([\w.-]+\.(?:sh|cmd|ps1))/);
      expect(match, `command should reference a hook script: ${cmd}`).not.toBeNull();
      const scriptName = match?.[1];
      expect(() => readFileSync(join(REPO_ROOT, 'hooks', scriptName ?? ''))).not.toThrow();
    }
  });
});

/**
 * The MCP registry manifest is published to registry.modelcontextprotocol.io
 * and was frozen at 1.5.4 while package.json was on 1.51.1 — release-please
 * never bumped it because it wasn't in `extra-files`. It is now; this guards
 * the wiring.
 */
describe('MCP registry manifest (server.json)', () => {
  const pkg = readJson('package.json');
  const server = readJson('server.json');

  it('manifest version matches package.json version', () => {
    expect(server.version).toBe(pkg.version);
  });

  it('npm package entry version matches package.json version', () => {
    const packages = server.packages as Array<{ identifier: string; version: string }>;
    const entry = packages.find((p) => p.identifier === 'trace-mcp');
    expect(entry).toBeDefined();
    expect(entry?.version).toBe(pkg.version);
  });

  it('manifest name matches the mcpName declared in package.json', () => {
    expect(server.name).toBe(pkg.mcpName);
  });

  it('release-please is configured to bump both version fields', () => {
    const config = readJson('release-please-config.json') as {
      packages: Record<string, { 'extra-files': Array<{ path: string; jsonpath: string }> }>;
    };
    const paths = config.packages['.']['extra-files']
      .filter((f) => f.path === 'server.json')
      .map((f) => f.jsonpath);
    expect(paths).toContain('$.version');
    expect(paths).toContain('$.packages[0].version');
  });
});

describe('Codex CLI plugin manifests', () => {
  const pkg = readJson('package.json');
  const plugin = readJson('.codex-plugin', 'plugin.json');
  const marketplace = readJson('.codex-plugin', 'marketplace.json');

  it('plugin.json version matches package.json version', () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it('marketplace.json plugin entry version matches package.json version', () => {
    const plugins = marketplace.plugins as Array<{ name: string; version: string }>;
    const entry = plugins.find((p) => p.name === 'trace-mcp');
    expect(entry).toBeDefined();
    expect(entry?.version).toBe(pkg.version);
  });

  it('plugin.json mcpServers points at .mcp.json, which points at the bin name from package.json', () => {
    expect(plugin.mcpServers).toBe('./.mcp.json');
    const bin = pkg.bin as Record<string, string>;
    const mcpConfig = readJson('.codex-plugin', '.mcp.json') as Record<string, { command: string }>;
    const command = mcpConfig['trace-mcp']?.command;
    expect(command).toBeDefined();
    expect(Object.keys(bin)).toContain(command);
  });

  it('plugin manifest is shipped in the npm tarball (files field)', () => {
    const files = pkg.files as string[];
    expect(files).toContain('.codex-plugin');
  });

  it('hooks.json references hook scripts that exist on disk', () => {
    const hooks = readJson('.codex-plugin', 'hooks', 'hooks.json') as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const hookCommands = Object.values(hooks.hooks)
      .flat()
      .flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(hookCommands.length).toBeGreaterThan(0);
    for (const cmd of hookCommands) {
      const match = cmd.match(/hooks\/([\w.-]+\.(?:sh|cmd|ps1))/);
      expect(match, `command should reference a hook script: ${cmd}`).not.toBeNull();
      const scriptName = match?.[1];
      expect(() => readFileSync(join(REPO_ROOT, 'hooks', scriptName ?? ''))).not.toThrow();
    }
  });
});
