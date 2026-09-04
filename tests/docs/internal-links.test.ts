import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * Same-site links a reader can actually click, from a page's own body.
 *
 * Front matter, the TechArticle JSON-LD, fenced blocks and code spans are
 * stripped first: none of them renders as an `<a>`, and a link shown as a code
 * sample connects nothing. Reference-style links (`[x][ref]`) are not
 * recognised — no docs page uses them, and if one starts to, this under-counts
 * and the page goes red rather than silently passing.
 */
function inTextInternalLinks(markdown: string): string[] {
  const body = markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/`[^`\n]*`/g, '');
  return [...body.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)]
    .map(([, href]) => href)
    .filter(
      (href) =>
        // `//host/page.md` is protocol-relative — it leaves the site, so it is
        // external however much it looks like a sibling path.
        !href.startsWith('//') &&
        // Internal = a rooted path or a sibling .md/.html page. A bare fragment
        // is same-page, so it does not connect anything.
        (/^\/[^/]/.test(href) || /^[\w./-]+\.(md|html)(#|$)/.test(href)),
    );
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
    const { sourceFor, gitDate, isShallow, refresh } = await import(
      '../../scripts/gen-sitemap.mjs'
    );
    // A shallow clone dates every file to the single fetched commit, which would
    // flag untouched pages — so skip there. The CI `test` job checks out with
    // fetch-depth: 0 precisely so this guard runs before a docs PR merges.
    if (isShallow()) return;
    const xml = readFileSync(join(DOCS, 'sitemap.xml'), 'utf-8');
    const stale = [
      ...xml.matchAll(/<loc>https:\/\/trace-mcp\.com([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g),
    ]
      .map(([, path, lastmod]) => ({ path, lastmod, git: gitDate(sourceFor(path)) }))
      // Not `lastmod < git`: a squash-merge dates every page in the PR by its
      // LAST commit, so a one-day-old sitemap is the normal, unavoidable state
      // of a freshly merged docs PR. Stale is what the generator would rewrite.
      .filter((e) => refresh(e.lastmod, e.git) !== e.lastmod);
    expect(
      stale,
      `sitemap lastmod older than the page's last commit — run \`pnpm docs:sitemap\`: ${stale
        .map((e) => `${e.path} (${e.lastmod} < ${e.git})`)
        .join(', ')}`,
    ).toEqual([]);
  });

  /**
   * A GitHub squash-merge keeps the author date and re-stamps the committer
   * date to the merge moment. Dating pages by committer date therefore gave a
   * different answer on the PR branch than on master for the same change, so a
   * docs PR authored one day and merged the next passed its own CI and turned
   * master red on landing — with the repo-wide `test` job failing for everyone
   * else's unrelated PRs until someone re-ran the generator (TRA-637).
   */
  it('dates a page the same before and after a squash-merge re-stamps it', async () => {
    const { gitDate } = await import('../../scripts/gen-sitemap.mjs');
    const repo = mkdtempSync(join(tmpdir(), 'sitemap-squash-'));
    // gpgsign off: a contributor with it on globally would fail here, not in git.
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, env });
    // The author committed their own work, so both dates start out 08-29.
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-08-29T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-08-29T12:00:00Z',
    };

    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'page.md'), 'body\n');
    git('add', '-A');
    git('commit', '-qm', 'authored on the PR branch');
    const onBranch = gitDate('page.md', repo);

    // What GitHub does on squash-merge: same author date, new committer date.
    env.GIT_COMMITTER_DATE = '2026-08-30T19:00:00Z';
    git('commit', '-q', '--amend', '--no-edit');
    const afterSquash = gitDate('page.md', repo);

    rmSync(repo, { recursive: true, force: true });
    expect(onBranch).toBe('2026-08-29');
    expect(afterSquash, 'gitDate must not move when a squash re-stamps the committer date').toBe(
      onBranch,
    );
  });

  /**
   * The author date only survives a squash intact when the PR is one commit.
   * GitHub stamps a multi-commit squash with the author date of the LAST
   * commit, so a page edited (and the sitemap regenerated) on 09-03 in a PR
   * whose review fixup lands 09-04 is dated 09-04 on master against a sitemap
   * that says 09-03 — green on the PR, red on master. That is what #841 did to
   * 18 pages at once and what the repo has been regenerating by hand since
   * (TRA-795). The date the guard wants does not exist until merge time, so
   * the tolerance is what closes it, not a stricter generator (TRA-800).
   */
  it('stays quiet when a multi-commit squash dates a page after the sitemap', async () => {
    const { gitDate, refresh } = await import('../../scripts/gen-sitemap.mjs');
    const repo = mkdtempSync(join(tmpdir(), 'sitemap-multisquash-'));
    const env = { ...process.env, GIT_AUTHOR_DATE: '', GIT_COMMITTER_DATE: '' };
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, env });
    const at = (date: string, ...args: string[]) => {
      env.GIT_AUTHOR_DATE = date;
      env.GIT_COMMITTER_DATE = date;
      git(...args);
    };

    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    mkdirSync(join(repo, 'docs'));
    // Master before the PR branched.
    writeFileSync(join(repo, 'README.md'), 'base\n');
    at('2026-09-01T10:00:00Z', 'add', '-A');
    at('2026-09-01T10:00:00Z', 'commit', '-qm', 'base');
    // The docs edit, and the `pnpm docs:sitemap` run that dated it 09-03.
    writeFileSync(join(repo, 'docs', 'page.md'), 'body\n');
    at('2026-09-03T20:33:00Z', 'add', '-A');
    at('2026-09-03T20:33:00Z', 'commit', '-qm', 'docs edit');
    // A review fixup the next day, touching nothing under docs/.
    writeFileSync(join(repo, 'unrelated.ts'), 'export {};\n');
    at('2026-09-04T04:31:00Z', 'add', '-A');
    at('2026-09-04T04:31:00Z', 'commit', '-qm', 'review fixup');
    // What GitHub's "Squash and merge" produces: one commit carrying both
    // trees, authored at the last commit's date.
    git('reset', '-q', '--soft', 'HEAD~2');
    at('2026-09-04T04:31:00Z', 'commit', '-qm', 'docs(seo): squashed (#841)');

    const afterMerge = gitDate('page.md', repo);
    rmSync(repo, { recursive: true, force: true });

    expect(afterMerge, 'the squash carries the last commit date, not the edit date').toBe(
      '2026-09-04',
    );
    expect(refresh('2026-09-03', afterMerge), 'merge-date residue must not read as stale').toBe(
      '2026-09-03',
    );
  });

  /**
   * `%cs` renders each commit's date in *its own* timezone, so a GitHub squash
   * commit (-07:00) and the same commit read from Dubai (+04:00) disagree by a
   * day. Re-running the generator therefore revised ten untouched pages from
   * 2026-08-30 back to 2026-08-29 — a published date moving backwards, which is
   * what page-dates.test.ts exists to catch. A regenerate now has to be a no-op
   * on pages nobody edited.
   */
  it('regenerating never moves a committed date backwards', async () => {
    const { refresh, rewrite, isShallow } = await import('../../scripts/gen-sitemap.mjs');
    expect(refresh('2026-08-30', '2026-08-29')).toBe('2026-08-30');
    expect(refresh(undefined, '2026-08-30')).toBe('2026-08-30');
    // Within the drift window the committed date stands; past it, git wins.
    expect(refresh('2026-08-29', '2026-08-30')).toBe('2026-08-29');
    expect(refresh('2026-08-29', '2026-09-05')).toBe('2026-08-29');
    expect(refresh('2026-08-29', '2026-09-06')).toBe('2026-09-06');
    expect(refresh('2026-04-01', '2026-08-30')).toBe('2026-08-30');

    if (isShallow()) return; // gitDate is meaningless on one fetched commit
    const xml = readFileSync(join(DOCS, 'sitemap.xml'), 'utf-8');
    expect(
      rewrite(xml),
      'run `pnpm docs:sitemap` — the committed sitemap is not a fixed point',
    ).toBe(xml);
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
   * Underscore directories (_layouts, _includes, _data) are Jekyll internals
   * that never get a URL, so they are not pages and are skipped.
   */
  it('every published docs page is in the sitemap or marked noindex', () => {
    const pages = readdirSync(DOCS, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => !f.startsWith('_'));
    const indexed = new Set(
      sitemapPaths().map((p) => p.replace(/^\//, '').replace(/\.html$/, '.md')),
    );
    const orphans = pages.filter((f) => {
      if (indexed.has(f)) return false;
      return !/^---\n[\s\S]*?^noindex:\s*true\s*$[\s\S]*?^---$/m.test(
        readFileSync(join(DOCS, f), 'utf-8'),
      );
    });
    expect(
      orphans,
      `docs pages that are neither in sitemap.xml nor marked \`noindex: true\`: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * GitHub Pages serves a directory's README as its index, so docs/perf/README.md
   * was reachable at /perf/ with no front matter at all. Adding front matter hands
   * the file to Jekyll, which publishes it at /perf/README.html instead — and /perf/
   * then falls through to the "Page not found" body served under a 200, a soft 404
   * on a URL that had been working. Shipped exactly that way in #635 and caught on
   * the live site afterwards, not by CI.
   *
   * `permalink` pins the output URL back to the directory, so the two cannot diverge.
   */
  it('every README under docs/ pins its URL with a permalink', () => {
    const readmes = readdirSync(DOCS, { recursive: true, encoding: 'utf-8' })
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => !f.startsWith('_') && /(^|\/)README\.md$/.test(f));
    const unpinned = readmes.filter((f) => {
      const raw = readFileSync(join(DOCS, f), 'utf-8');
      if (!raw.startsWith('---\n')) return false; // no front matter: Jekyll leaves the URL alone
      const expected = `/${f.replace(/README\.md$/, '')}`;
      return !new RegExp(`^permalink:\\s*${expected}/?\\s*$`, 'm').test(raw);
    });
    expect(
      unpinned,
      `READMEs with front matter but no \`permalink:\` pinning them to their directory URL: ${unpinned.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * Footer coverage made every page reachable, but it made every page equally
   * reachable: one flat 22-link ribbon repeated site-wide carries no topical
   * signal, so no page reads as a hub. In-text links are what group pages into
   * topics — the /vs/ cluster already does this and was the model copied for
   * the token-cost, setup and coverage clusters (TRA-658).
   *
   * Threshold is 1, not the 3-6 the clusters actually carry: this exists to
   * stop a NEW page shipping as a dead end, not to freeze the current density.
   * Links injected by the layout do not count — only what the page's own body
   * says. Pages excluded from the sitemap (`noindex: true`) are internal
   * working documents and are not checked.
   */
  it('every published page links somewhere in its own body, not just the footer', async () => {
    const { sourceFor } = await import('../../scripts/gen-sitemap.mjs');
    const deadEnds = sitemapPaths().filter(
      (path) =>
        inTextInternalLinks(readFileSync(join(DOCS, sourceFor(path)), 'utf-8')).length === 0,
    );
    expect(
      deadEnds,
      `published pages with no in-text internal link — add links in prose where the subject comes up, not a "See also" block: ${deadEnds.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * docs/ is the site root, so a link written for the repo checkout — `../src/config.ts`,
   * `../README.md` — resolves to https://trace-mcp.com/src/config.ts and 404s. Eight of
   * them were live across five pages, each verified 404 on 2026-09-02. Source files get
   * a GitHub blob URL instead; a `../` that stays inside docs/ still resolves and passes.
   */
  it('no docs page links out of the site root with a relative path', () => {
    const escaping = readdirSync(DOCS, { recursive: true, encoding: 'utf-8' })
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
      .flatMap((f) => {
        const dir = f.includes('/') ? f.replace(/\/[^/]*$/, '') : '.';
        const body = readFileSync(join(DOCS, f), 'utf-8').replace(/^```[\s\S]*?^```/gm, '');
        return [...body.matchAll(/\[[^\]]*\]\(\s*(\.\.\/[^)\s]+)/g)]
          .map(([, href]) => href)
          .filter((href) => join(dir, href).startsWith('..'))
          .map((href) => `${f} -> ${href}`);
      });
    expect(
      escaping,
      `docs links that escape docs/ and 404 on the live site — use a https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/ URL: ${escaping.join(', ')}`,
    ).toEqual([]);
  });

  // The matcher above decides whether a page counts as a dead end, so its two
  // failure directions are worth pinning down. A false positive is the costly
  // one — it reports a dead end as linked and the guard goes quiet — so an
  // external URL and a link that only exists inside a code sample must not
  // count. A false negative just turns the page red, which announces itself.
  it.each([
    ['rooted path', '[config](/configuration.html)', true],
    ['sibling page', '[config](configuration.md)', true],
    ['sibling page with anchor', '[storage](architecture.md#storage)', true],
    ['link with a title attribute', '[config](configuration.md "Config reference")', true],
    ['absolute external URL', '[repo](https://github.com/x/y/blob/main/a.md)', false],
    ['protocol-relative external URL', '[outside](//example.com/page.md)', false],
    ['bare fragment (same page)', '[top](#quickstart)', false],
    ['inside a code span', 'use `[config](configuration.md)` in prose', false],
    ['inside a fenced block', '```md\n[config](configuration.md)\n```', false],
  ])('link detection: %s', (_name, markdown, isInternal) => {
    expect(inTextInternalLinks(markdown).length > 0).toBe(isInternal);
  });

  /**
   * The TechArticle JSON-LD is hand-written into each page's body rather than
   * emitted by the layout, so it drifts the same way the footer nav did: 19 of
   * the 22 doc pages carried it and daemon-memory, language-matrix and
   * tools-index shipped with only the layout's WebPage (TRA-677). The layout
   * cannot emit it — headline and datePublished are per-page and are not in
   * front matter — so a guard is what keeps a new page from skipping it.
   */
  it('every indexed docs page carries TechArticle schema', async () => {
    const { sourceFor } = await import('../../scripts/gen-sitemap.mjs');
    const missing = sitemapPaths().filter(
      (path) => !readFileSync(join(DOCS, sourceFor(path)), 'utf-8').includes('"TechArticle"'),
    );
    expect(missing, `indexed pages without TechArticle JSON-LD: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * llms.txt is the file AI search systems read first, and for a product whose
   * users are AI agents a stale one is not a missed opportunity — it is a wrong
   * answer served confidently. It is hand-maintained (the descriptions are
   * better than the front-matter ones) and had drifted past the same four newest
   * pages the footer had (TRA-681), so the list needs the same guard the footer
   * got rather than a generator.
   */
  it('llms.txt links every indexed page', () => {
    const llms = readFileSync(join(DOCS, 'llms.txt'), 'utf-8');
    const missing = sitemapPaths().filter((p) => !llms.includes(`https://trace-mcp.com${p}`));
    expect(missing, `indexed pages absent from llms.txt: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * llms-full.txt was 170 KB of hand-copied page text with no generator, so it
   * drifted in both directions at once: four pages absent, four more serving
   * copies older than the live page. It is generated now, and presence alone is
   * not the property worth checking — currency is. This is a fixed-point test
   * like the sitemap one above: it goes red both when a page is added and when
   * an existing page's text changes.
   */
  it('llms-full.txt is what the generator would produce', async () => {
    const { build } = await import('../../scripts/gen-llms-full.mjs');
    expect(
      readFileSync(join(DOCS, 'llms-full.txt'), 'utf-8'),
      'docs/llms-full.txt is stale — run `pnpm docs:sitemap`',
    ).toBe(build());
  });

  /**
   * Both footers, not just the layout's. This check used to read
   * `_layouts/default.html` alone, so it could not see that `index.html` —
   * which has `layout: null` and its own hand-written footer — still listed
   * 12 of the 22 pages by hand. It had drifted past the whole /vs/ cluster,
   * unlinked from the one page on the site with any external authority.
   */
  it.each([['_layouts/default.html'], ['index.html']])(
    '%s renders the footer nav from the data file, not a hardcoded list',
    (page) => {
      expect(readFileSync(join(DOCS, ...page.split('/')), 'utf-8')).toMatch(/site\.data\.docs_nav/);
    },
  );
});
