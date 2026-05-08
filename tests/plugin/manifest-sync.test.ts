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
