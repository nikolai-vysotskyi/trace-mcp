#!/usr/bin/env node
/**
 * Rewrites <lastmod> in docs/sitemap.xml from each page's last git commit date.
 *
 * The dates used to be hand-maintained and all 13 went stale — some by five
 * months — so Google was told "unchanged since April" after every docs fix.
 * Run `pnpm docs:sitemap` after touching docs/; tests/docs/internal-links.test.ts
 * fails if the committed sitemap is older than the source.
 *
 * ponytail: rewrites lastmod in place instead of generating the whole file, so
 * the hand-tuned <priority>/<changefreq> per URL stay where they are.
 * GitHub Pages can't do this in Liquid — jekyll-last-modified-at is not on its
 * allowed-plugins list.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCS = join(import.meta.dirname, '..', 'docs');
const SITEMAP = join(DOCS, 'sitemap.xml');

/** URL path -> source file under docs/ */
export function sourceFor(urlPath) {
  return urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '').replace(/\.html$/, '.md');
}

export function gitDate(file) {
  const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', `docs/${file}`], {
    cwd: join(DOCS, '..'),
    encoding: 'utf-8',
  }).trim();
  if (!out) throw new Error(`no git history for docs/${file}`);
  return out;
}

export function rewrite(xml) {
  return xml.replace(
    /<loc>https:\/\/trace-mcp\.com([^<]*)<\/loc>(\s*)<lastmod>[^<]*<\/lastmod>/g,
    (_m, path, gap) => `<loc>https://trace-mcp.com${path}</loc>${gap}<lastmod>${gitDate(sourceFor(path))}</lastmod>`,
  );
}

if (process.argv[1] === import.meta.filename) {
  writeFileSync(SITEMAP, rewrite(readFileSync(SITEMAP, 'utf-8')));
  console.log('docs/sitemap.xml lastmod refreshed from git');
}
