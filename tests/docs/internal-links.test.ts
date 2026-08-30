import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Internal-link coverage guard.
 *
 * A crawl of trace-mcp.com counted inbound internal links per sitemap URL.
 * The shared footer in _layouts/default.html linked only tools-reference,
 * architecture and configuration, so those three had 12 inbound links each
 * while the other eight doc pages had 1-2 — all from the homepage.
 * comparisons.html, the highest commercial-intent page on the site, had
 * exactly one inbound link.
 *
 * The footer now renders from docs/_data/docs_nav.yml. This test fails when
 * a page is added to sitemap.xml but not to that nav, which is how the
 * imbalance crept in.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DOCS = join(REPO_ROOT, 'docs');

function sitemapPaths(): string[] {
  const xml = readFileSync(join(DOCS, 'sitemap.xml'), 'utf-8');
  return (
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      // Anchored with a lookahead on the path separator: without it the pattern
      // also strips the prefix of a lookalike host like trace-mcp.com.example.org.
      .map((m) => m[1].replace(/^https:\/\/trace-mcp\.com(?=\/)/, ''))
      .filter((p) => p !== '/')
  ); // homepage is linked separately in the footer
}

function navPaths(): string[] {
  const yml = readFileSync(join(DOCS, '_data', 'docs_nav.yml'), 'utf-8');
  return [...yml.matchAll(/^\s*url:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

describe('docs footer nav covers every indexed page', () => {
  it('every sitemap URL appears in _data/docs_nav.yml', () => {
    const missing = sitemapPaths().filter((p) => !navPaths().includes(p));
    expect(
      missing,
      `pages in sitemap.xml but not in the footer nav: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every nav entry is a page that is actually indexed', () => {
    const stale = navPaths().filter((p) => !sitemapPaths().includes(p));
    expect(stale, `footer nav links pages absent from sitemap.xml: ${stale.join(', ')}`).toEqual(
      [],
    );
  });

  /**
   * All 13 <lastmod> values were hand-maintained and all 13 had gone stale —
   * tools-reference.html by 4.5 months — so every docs fix was published to
   * Google under an April date. `pnpm docs:sitemap` refreshes them from git.
   */
  it('every lastmod is at least the source page last commit date', async () => {
    const { sourceFor, gitDate, isShallow } = await import('../../scripts/gen-sitemap.mjs');
    // A shallow clone dates every file to the single fetched commit, which would
    // flag untouched pages — so skip there. The CI `test` job checks out with
    // fetch-depth: 0 precisely so this guard runs before a docs PR merges.
    if (isShallow()) return;
    const xml = readFileSync(join(DOCS, 'sitemap.xml'), 'utf-8');
    const stale = [
      ...xml.matchAll(/<loc>https:\/\/trace-mcp\.com([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g),
    ]
      .map(([, path, lastmod]) => ({ path, lastmod, git: gitDate(sourceFor(path)) }))
      .filter((e) => e.lastmod < e.git);
    expect(
      stale,
      `sitemap lastmod older than the page's last commit — run \`pnpm docs:sitemap\`: ${stale
        .map((e) => `${e.path} (${e.lastmod} < ${e.git})`)
        .join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The two checks above only compare sitemap.xml against the nav, so a page
   * absent from *both* was invisible to them. On 2026-08-30 four such pages
   * were live on trace-mcp.com — /language-matrix.html, /daemon-memory.html,
   * /ROADMAP.html and /DESIGN-WEB.html — each a fully rendered 200 with a
   * <title>, each with no inbound link anywhere on the site, and all four
   * reported "URL is unknown to Google" by the Search Console API.
   *
   * Every .md under docs/ becomes a public URL, so the source of truth is the
   * directory, not the sitemap. A page is either indexed (in the sitemap) or
   * deliberately not (`noindex: true` in its front matter) — never neither.
   */
  it('every published docs page is in the sitemap or marked noindex', () => {
    const pages = readdirSync(DOCS, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\\/g, '/'));
    const indexed = new Set(sitemapPaths().map((p) => p.replace(/^\//, '').replace(/\.html$/, '.md')));
    const orphans = pages.filter((f) => {
      if (indexed.has(f)) return false;
      return !/^---\n[\s\S]*?^noindex:\s*true\s*$[\s\S]*?^---$/m.test(readFileSync(join(DOCS, f), 'utf-8'));
    });
    expect(
      orphans,
      `docs pages that are neither in sitemap.xml nor marked \`noindex: true\`: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('the layout renders the nav from the data file, not a hardcoded list', () => {
    const layout = readFileSync(join(DOCS, '_layouts', 'default.html'), 'utf-8');
    expect(layout).toMatch(/site\.data\.docs_nav/);
  });
});
