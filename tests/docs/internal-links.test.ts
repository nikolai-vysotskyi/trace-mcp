import { readFileSync } from 'node:fs';
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
    // ponytail: a shallow clone dates every file to the single fetched commit,
    // so the CI `test` job (fetch-depth 1) would flag untouched pages. The guard
    // runs on any full clone — local `pnpm test` before a docs PR. Give the job
    // fetch-depth: 0 if it ever needs to catch this in CI too.
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

  it('the layout renders the nav from the data file, not a hardcoded list', () => {
    const layout = readFileSync(join(DOCS, '_layouts', 'default.html'), 'utf-8');
    expect(layout).toMatch(/site\.data\.docs_nav/);
  });
});
