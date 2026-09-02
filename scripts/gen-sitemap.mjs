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

/**
 * Author date (`%ad`), not committer date. A GitHub squash-merge keeps the
 * author date and re-stamps the committer date to the merge moment, so `%cd`
 * gives a different answer on the PR branch than on master for the very same
 * change: a page edited on 08-29 and merged on 08-30 passes the guard on the
 * PR (sitemap 08-29 == committer 08-29) and fails it the second it lands
 * (sitemap 08-29 < committer 08-30) — red master for a PR that was green.
 * `%ad` is identical either side of the squash, so the guard's PR-time answer
 * is the one master will get.
 *
 * The date is also rendered in the *commit's own* timezone, so one commit reads
 * 2026-08-29 from a GitHub squash (-07:00) and 2026-08-30 from Dubai (+04:00) —
 * which is what walked ten unrelated pages' dates backwards. Pin the rendering
 * to UTC so the answer is the same on every machine.
 *
 * `cwd` is a seam for the test that pins the squash property; production always
 * uses the repo root.
 */
export function gitDate(file, cwd = join(DOCS, '..')) {
  const out = execFileSync(
    'git',
    ['log', '-1', '--date=format-local:%Y-%m-%d', '--format=%ad', '--', `docs/${file}`],
    { cwd, encoding: 'utf-8', env: { ...process.env, TZ: 'UTC' } },
  ).trim();
  // A page added in the working tree has no commit yet — date it today rather
  // than throwing, so `pnpm docs:sitemap` can be run before the first commit.
  if (!out) return new Date().toISOString().slice(0, 10);
  return out;
}

/**
 * Mirror the same date into the page's `updated:` front matter, which
 * _layouts/default.html renders as a reader-visible "Last updated" line.
 * Same source, one command, so the visible date can't drift from <lastmod>.
 */
export function stampUpdated(file, date) {
  if (!file.endsWith('.md')) return;
  const path = join(DOCS, file);
  const raw = readFileSync(path, 'utf-8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error(`docs/${file} has no front matter to stamp`);
  const current = fm[1].match(/^updated:[ \t]*(\S+)/m)?.[1];
  const next = keepLater(current, date);
  if (next === current) return;
  const body = /^updated:.*$/m.test(fm[1])
    ? fm[1].replace(/^updated:.*$/m, `updated: ${next}`)
    : `${fm[1]}\nupdated: ${next}`;
  writeFileSync(path, `---\n${body}\n---\n${raw.slice(fm[0].length)}`);
}

/**
 * A published date only ever moves forward. Without this, re-running the
 * generator revises already-crawled pages backwards — the exact signal
 * tests/docs/page-dates.test.ts exists to protect.
 */
export function keepLater(committed, fresh) {
  return committed && committed > fresh ? committed : fresh;
}

/** A shallow clone dates every file to the one fetched commit — gitDate is meaningless there. */
export function isShallow() {
  return (
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: join(DOCS, '..'),
      encoding: 'utf-8',
    }).trim() === 'true'
  );
}

export function rewrite(xml) {
  return xml.replace(
    /<loc>https:\/\/trace-mcp\.com([^<]*)<\/loc>(\s*)<lastmod>([^<]*)<\/lastmod>/g,
    (_m, path, gap, current) => {
      const next = keepLater(current.trim(), gitDate(sourceFor(path)));
      return `<loc>https://trace-mcp.com${path}</loc>${gap}<lastmod>${next}</lastmod>`;
    },
  );
}

/** Every source page referenced by the sitemap. */
export function sitemapSources(xml) {
  return [...xml.matchAll(/<loc>https:\/\/trace-mcp\.com([^<]*)<\/loc>/g)].map((m) =>
    sourceFor(m[1]),
  );
}

if (process.argv[1] === import.meta.filename) {
  const xml = readFileSync(SITEMAP, 'utf-8');
  writeFileSync(SITEMAP, rewrite(xml));
  for (const source of sitemapSources(xml)) stampUpdated(source, gitDate(source));
  console.log('docs/sitemap.xml lastmod + page `updated:` front matter refreshed from git');
}
