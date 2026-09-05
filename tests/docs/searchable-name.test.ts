import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The literal string `trace-mcp` is the only thing the site ranks for.
 *
 * GSC Search Analytics for `sc-domain:trace-mcp.com`, 2026-08-06 → 2026-09-04:
 * 53 clicks total, 41 of them (77%) on the exact queries `trace-mcp` and
 * `trace mcp` at average position 1.5. Zero clicks came from any descriptive
 * query. Meanwhile `traceix mcp` (61 impressions) and `mcp tracing` (54)
 * returned no clicks at all — the `-mcp` suffix is what keeps us apart from
 * a same-prefix product and from the observability category.
 *
 * `ops/rename-to-trace.md` therefore decided: the domain, the npm package,
 * the registry identity and the on-page titles keep `trace-mcp`; only the CLI
 * verb and the MCP server key become `trace`. This test is that boundary's
 * guard — a rename sweep that reaches these strings would remove 100% of the
 * site's organic entry points silently, with no test failing. (TRA-879)
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf-8');

describe('the searchable name stays trace-mcp', () => {
  it('site title, url and description carry it', () => {
    const config = read('docs/_config.yml');
    expect(config).toMatch(/^title: trace-mcp$/m);
    expect(config).toMatch(/^url: https:\/\/trace-mcp\.com$/m);
    // jekyll-seo-tag renders `<title>{page.title} | {site.title}</title>`, so
    // site.title above is what puts the string on every page but the home page.
    expect(config).toMatch(/^description:.*\btrace-mcp\b/m);
  });

  it('the home page title and og:title carry it', () => {
    const index = read('docs/index.html');
    expect(index).toMatch(/<title>[^<]*trace-mcp[^<]*<\/title>/);
    expect(index).toMatch(/property="og:title" content="[^"]*trace-mcp[^"]*"/);
  });

  it('the visible home page copy carries it, not only the metadata', () => {
    const index = read('docs/index.html');
    const body = index.slice(index.indexOf('<body'));
    // Tags stripped: a rename sweep that leaves the string only in <meta> would
    // keep the SERP snippet matching while the page a visitor reads no longer does.
    const visible = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
    expect(visible).toMatch(/\btrace-mcp\b/);
  });

  it('the JSON-LD entity anchor names it', () => {
    const layout = read('docs/_layouts/default.html');
    const names = [
      ...layout.matchAll(/"@type": "(Organization|WebSite)",\s*"@id":[^}]*?"name": "([^"]+)"/g),
    ];
    expect(names.map((m) => m[2])).toEqual(['trace-mcp', 'trace-mcp']);
  });

  it('the package and registry identity stay trace-mcp', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.name).toBe('trace-mcp');
    // `trace` is taken on npm and the registry name is what directories key on.
    expect(pkg.mcpName).toBe('io.github.nikolai-vysotskyi/trace-mcp');
    expect(pkg.homepage).toBe('https://trace-mcp.com');
    expect(JSON.parse(read('server.json')).name).toBe('io.github.nikolai-vysotskyi/trace-mcp');
    // The unambiguous bin name stays installed forever (/usr/bin/trace collision).
    expect(Object.keys(pkg.bin)).toContain('trace-mcp');
  });
});
