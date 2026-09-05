#!/usr/bin/env node
/**
 * Rewrites <lastmod> in docs/sitemap.xml from each page's last git commit date.
 *
 * The dates used to be hand-maintained and all 13 went stale — some by five
 * months — so Google was told "unchanged since April" after every docs fix.
 * Run `pnpm docs:sitemap` after touching docs/; tests/docs/internal-links.test.ts
 * fails once the committed sitemap falls more than DRIFT_TOLERANCE_DAYS behind
 * the source (see that constant for why it is not an exact match).
 *
 * ponytail: rewrites lastmod in place instead of generating the whole file, so
 * the hand-tuned <priority>/<changefreq> per URL stay where they are.
 * GitHub Pages can't do this in Liquid — jekyll-last-modified-at is not on its
 * allowed-plugins list.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCS = join(import.meta.dirname, '..', 'docs');
const SITEMAP = join(DOCS, 'sitemap.xml');

/**
 * URL path -> source file under docs/.
 *
 * Most pages are served at their file path, but a page with a `permalink:` in
 * its front matter is served wherever that says (TRA-945 publishes
 * docs/perf/response-tokens.md at /perf/response-tokens/), so the front matter
 * has to be consulted before falling back to the path rewrite.
 */
export function sourceFor(urlPath) {
  if (urlPath === '/') return 'index.html';
  const byPermalink = permalinkIndex().get(urlPath);
  if (byPermalink) return byPermalink;
  return urlPath.replace(/^\//, '').replace(/\.html$/, '.md');
}

let permalinks;
/** permalink -> source file, built once from every .md under docs/. */
function permalinkIndex() {
  if (permalinks) return permalinks;
  permalinks = new Map();
  for (const f of readdirSync(DOCS, { recursive: true, encoding: 'utf-8' })) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    const rel = f.replace(/\\/g, '/');
    const m = /^---\n[\s\S]*?^permalink:\s*(\S+)\s*$[\s\S]*?^---$/m.exec(
      readFileSync(join(DOCS, rel), 'utf-8'),
    );
    if (m) permalinks.set(m[1], rel);
  }
  return permalinks;
}

/**
 * Author date (`%ad`), not committer date. A GitHub squash-merge keeps the
 * author date and re-stamps the committer date to the merge moment, so `%cd`
 * gives a different answer on the PR branch than on master for the very same
 * change: a page edited on 08-29 and merged on 08-30 passes the guard on the
 * PR (sitemap 08-29 == committer 08-29) and fails it the second it lands
 * (sitemap 08-29 < committer 08-30) — red master for a PR that was green.
 * `%ad` is identical either side of the squash for a single-commit PR. It is
 * NOT stable for a multi-commit one: GitHub stamps the squash with the author
 * date of the *last* commit, so a page edited on 09-03 in a PR whose final
 * commit lands 09-04 reads 09-03 on the branch and 09-04 on master. That
 * residue is what DRIFT_TOLERANCE_DAYS absorbs (TRA-800).
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
  // index.html is hand-written HTML, but it carries front matter for the
  // {{ site.data.* }} tags — so it can take the same stamp, which is what lets
  // its JSON-LD dateModified stop being a hardcoded date (TRA-419).
  if (!file.endsWith('.md') && file !== 'index.html') return;
  const path = join(DOCS, file);
  const raw = readFileSync(path, 'utf-8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error(`docs/${file} has no front matter to stamp`);
  const current = fm[1].match(/^updated:[ \t]*(\S+)/m)?.[1];
  const next = refresh(current, date);
  if (next === current) return;
  const body = /^updated:.*$/m.test(fm[1])
    ? fm[1].replace(/^updated:.*$/m, `updated: ${next}`)
    : `${fm[1]}\nupdated: ${next}`;
  writeFileSync(path, `---\n${body}\n---\n${raw.slice(fm[0].length)}`);
}

/**
 * How far `<lastmod>` may sit behind the page's commit date before the
 * generator rewrites it — and before the guard calls it stale.
 *
 * Not slack for sloppy commits: an exact match is *unreachable* here. A
 * GitHub squash stamps the squashed commit with the author date of the PR's
 * LAST commit, not of the commit that edited the page — so a PR whose docs
 * edit (and `pnpm docs:sitemap` run) happened on 09-03 and whose final review
 * fixup landed 09-04 gets every one of its pages dated 09-04 the moment it
 * merges, against a sitemap that can only ever say 09-03. #841 did exactly
 * that to 18 pages at once: green on the PR, red on master seconds later,
 * blocking everyone else's `test` job until someone regenerated by hand
 * (TRA-795, TRA-800). No commit-time mechanism can close that gap — the date
 * the guard wants is chosen at merge time, after the last commit exists.
 *
 * A week absorbs a PR's whole lifetime while still catching what this guard
 * was built for: 13 hand-maintained dates that had gone stale by up to 4.5
 * months.
 *
 * ponytail: one constant instead of teaching the generator to predict the
 * merge date. If a PR ever stays open longer than a week AND touches docs,
 * it lands stale and the next docs commit fixes it — raise the window rather
 * than reintroduce a hook.
 */
export const DRIFT_TOLERANCE_DAYS = 7;

/**
 * The `<lastmod>` a page should carry, given what is committed and what git
 * says. A published date only ever moves forward — without that, re-running
 * the generator revises already-crawled pages backwards, the exact signal
 * tests/docs/page-dates.test.ts exists to protect — and it only moves at all
 * once git has run more than DRIFT_TOLERANCE_DAYS ahead of it.
 */
export function refresh(committed, fresh) {
  if (!committed) return fresh;
  if (fresh <= committed) return committed;
  const drift = (Date.parse(fresh) - Date.parse(committed)) / 86_400_000;
  return drift > DRIFT_TOLERANCE_DAYS ? fresh : committed;
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
      const next = refresh(current.trim(), gitDate(sourceFor(path)));
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
