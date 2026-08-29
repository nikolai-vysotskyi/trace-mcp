import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Reader-visible date guard (TRA-351).
 *
 * Every page that outranks trace-mcp.com for the queries we target shows a
 * publication or update date to the reader. Ours carried one only inside the
 * TechArticle JSON-LD, which nobody sees. The layout now renders `updated:`
 * from front matter, and `pnpm docs:sitemap` stamps it from the same git date
 * it writes into <lastmod> — this test fails if a page loses the key or the
 * two dates drift apart, which is exactly how the hand-maintained <lastmod>
 * values all went stale before TRA-262.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DOCS = join(REPO_ROOT, 'docs');

function sitemapEntries(): Array<{ path: string; lastmod: string }> {
  const xml = readFileSync(join(DOCS, 'sitemap.xml'), 'utf-8');
  return [
    ...xml.matchAll(/<loc>https:\/\/trace-mcp\.com([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g),
  ].map(([, path, lastmod]) => ({ path, lastmod }));
}

function frontMatterUpdated(source: string): string | null {
  const raw = readFileSync(join(DOCS, source), 'utf-8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  return fm?.[1].match(/^updated:\s*(\S+)\s*$/m)?.[1] ?? null;
}

describe('docs pages show a reader-visible date', () => {
  // docs/index.html is a hand-written static file with no front matter, so the
  // layout never runs for it — it carries its own dates in its own <head>.
  const markdownPages = sitemapEntries().filter((e) => e.path.endsWith('.html'));

  it('every markdown page in the sitemap has an `updated:` front-matter key', () => {
    const missing = markdownPages
      .map((e) => e.path.replace(/^\//, '').replace(/\.html$/, '.md'))
      .filter((source) => frontMatterUpdated(source) === null);
    expect(
      missing,
      `pages with no \`updated:\` front matter — run \`pnpm docs:sitemap\`: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it("`updated:` matches the page's <lastmod> in sitemap.xml", () => {
    const drifted = markdownPages
      .map((e) => ({
        source: e.path.replace(/^\//, '').replace(/\.html$/, '.md'),
        lastmod: e.lastmod,
      }))
      .map((e) => ({ ...e, updated: frontMatterUpdated(e.source) }))
      .filter((e) => e.updated !== null && e.updated !== e.lastmod);
    expect(
      drifted,
      `visible date disagrees with sitemap <lastmod> — run \`pnpm docs:sitemap\`: ${drifted
        .map((e) => `${e.source} (${e.updated} vs ${e.lastmod})`)
        .join(', ')}`,
    ).toEqual([]);
  });

  it('the layout renders the date from front matter', () => {
    const layout = readFileSync(join(DOCS, '_layouts', 'default.html'), 'utf-8');
    expect(layout).toMatch(/page\.updated/);
  });
});
