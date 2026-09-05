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
    // TRA-641: the server key is "trace" (post-rename, TRA-611/614) even
    // though the command it invokes is still "trace-mcp" -- a user on an
    // older global install has no `trace` bin yet.
    expect(Object.keys(servers)).toEqual(['trace']);
    const command = servers['trace']?.command;
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

  it('description fits the registry schema limit (100 chars)', () => {
    // TRA-393: the published schema caps ServerDetail.description at 100 —
    // a longer string is rejected at publish time, not at build time, so the
    // failure only shows up as a silently stale registry listing.
    expect((server.description as string).length).toBeLessThanOrEqual(100);
  });

  // TRA-792: measured 2026-09-04, Google knows exactly two external URLs
  // linking trace-mcp.com, and eleven of the site's 24 pages have no index
  // entry at all. Every directory that renders our README rewrites its links
  // to rel="ugc nofollow" (glama) or strips the domain entirely and links only
  // GitHub (mcpservers.org, skillsllm.com). These two fields are the only
  // place in the repo that hands a directory the site URL as data rather than
  // as scraped prose — server.json republishes to the MCP registry on every
  // release, and the registry is what mcp.so, Smithery, PulseMCP and goose
  // ingest. Dropping either one is silent: nothing else fails.
  it('points the registry and npm at trace-mcp.com', () => {
    expect(server.websiteUrl).toBe('https://trace-mcp.com');
    expect(pkg.homepage).toBe('https://trace-mcp.com');
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

/**
 * TRA-393: the install surfaces (npm page, MCP registry, plugin marketplaces)
 * are where people decide whether to try trace-mcp, and they were advertising
 * "up to 99% token reduction" while README and the homepage reserve 99% for
 * *redundant processing* on structured calls. (TRA-904 retired the "40–50% on
 * average" those surfaces used to print — it was never measured — so the
 * aggregate this compares against is now docs/_data/response_tokens.json.)
 * The strongest, least defensible version of the claim was on the surfaces
 * with the least room to qualify it. Keep 99% attached to what it measures.
 */
describe('install-surface token claims stay honest', () => {
  const PR_BENCH = readJson('docs', '_data', 'pr_context_bench.json') as {
    median_savings_pct: number;
  };
  const RESPONSE = readJson('docs', '_data', 'response_tokens.json') as { reduction_pct: number };

  const surfaces = [
    'package.json',
    'plugin.json',
    'server.json',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    '.codex-plugin/plugin.json',
    '.codex-plugin/marketplace.json',
    // TRA-393 follow-up: the same defect class was live on two docs surfaces —
    // tools-reference sold benchmark_project's synthetic ceiling as "92%+ on
    // typical projects", and skills/README claimed "up to 99% on exploration
    // tasks". README.md and docs/index.html are deliberately NOT here: they
    // carry the full framing that makes the peak number honest.
    'docs/tools-reference.md',
    'skills/README.md',
  ];

  for (const path of surfaces) {
    it(`${path} does not claim 9x% fewer tokens`, () => {
      const text = readFileSync(join(REPO_ROOT, ...path.split('/')), 'utf8');
      // Both orders — "99% fewer tokens" and "token usage by 99%" — and decimals.
      // "token" alone is too narrow: "92%+ reduction on typical projects" never
      // says the word, and that was the live defect on docs/tools-reference.md.
      const pct = String.raw`9\d(?:\.\d+)?\s*%`;
      const noun = 'tokens?|reduction|savings|fewer|less';
      const claim = text.match(
        new RegExp(`${pct}\\+?[^"]{0,40}?(?:${noun})|(?:${noun})[^"]{0,40}?${pct}`, 'i'),
      );
      // TRA-904: one 9x% number IS defensible on an install surface — the PR
      // review context benchmark, measured with a tokenizer on 60 merged PRs in
      // repositories we do not own, generated into docs/_data/pr_context_bench.json.
      // It is allowed only when the surface says which task it measures; the ban
      // on selling benchmark_project's synthetic ceiling as a headline stands.
      const measuredPr =
        claim?.[0].includes(`${PR_BENCH.median_savings_pct}%`) && /PR|pull request/i.test(text);
      expect(
        measuredPr ? undefined : claim?.[0],
        `${path} advertises a peak token number as if it were the average. The measured ` +
          `aggregate is ${RESPONSE.reduction_pct}% (docs/_data/response_tokens.json); 99% is ` +
          '"less redundant processing" on structured calls, from a synthetic estimator.',
      ).toBeUndefined();
    });
  }
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
    // TRA-641: same key change as the Claude Code plugin -- "trace" key,
    // "trace-mcp" command (see the analogous assertion above).
    expect(Object.keys(mcpConfig)).toEqual(['trace']);
    const command = mcpConfig['trace']?.command;
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

describe('Agent Plugins specification (root plugin.json & mcp.json)', () => {
  const pkg = readJson('package.json');
  const plugin = readJson('plugin.json');
  const mcp = readJson('mcp.json');

  it('plugin.json version matches package.json version', () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it('plugin.json name matches package.json name', () => {
    expect(plugin.name).toBe(pkg.name);
  });

  it('mcp.json declares stdio transport with bin command', () => {
    const bin = pkg.bin as Record<string, string>;
    const servers = mcp.mcpServers as Record<string, { type: string; command: string }>;
    const server = servers['trace-mcp'];
    expect(server).toBeDefined();
    expect(server?.type).toBe('stdio');
    expect(Object.keys(bin)).toContain(server?.command);
  });

  it('release-please is configured to bump root plugin.json version', () => {
    const config = readJson('release-please-config.json') as {
      packages: Record<string, { 'extra-files': Array<{ path: string; jsonpath: string }> }>;
    };
    const paths = config.packages['.']['extra-files']
      .filter((f) => f.path === 'plugin.json')
      .map((f) => f.jsonpath);
    expect(paths).toContain('$.version');
  });
});
