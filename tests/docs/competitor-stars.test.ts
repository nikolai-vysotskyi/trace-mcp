import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Competitor star counts come from one file (TRA-419).
 *
 * The same metric used to carry three values across the site —
 * codebase-memory-mcp was 41.0K on /vs/codebase-memory-mcp.html and 41.2K in two
 * tables on /comparisons.html — because every table kept its own copy. The
 * tables now render `{{ site.data.competitors.*.stars }}`; these tests keep the
 * data file itself honest and stop new hardcoded cells creeping back in.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DOCS = join(REPO_ROOT, 'docs');

type Competitor = { repo: string; stars: string; stars_exact: number };

const DATA = parseYaml(readFileSync(join(DOCS, '_data', 'competitors.yml'), 'utf-8')) as Record<
  string,
  Competitor | string
>;

const entries = Object.entries(DATA).filter(
  (e): e is [string, Competitor] => typeof e[1] === 'object' && e[1] !== null,
);

/** "28180" -> "28.2K", the shortening the tables display. Under 1000 stays exact. */
function display(exact: number): string {
  if (exact < 1000) return String(exact);
  return `${Math.round(exact / 100) / 10}K`;
}

describe('docs/_data/competitors.yml', () => {
  it('lists at least the competitors the comparison tables render', () => {
    expect(entries.length).toBeGreaterThanOrEqual(6);
  });

  it('every display string matches its exact star count', () => {
    const drifted = entries
      .filter(([, c]) => c.stars !== display(c.stars_exact))
      .map(([key, c]) => `${key}: stars "${c.stars}" but stars_exact ${c.stars_exact}`);
    expect(drifted, 're-derive `stars` from `stars_exact` after a verification pass').toEqual([]);
  });

  it('every entry names the repository the count came from', () => {
    const missing = entries
      .filter(([, c]) => !/^[\w.-]+\/[\w.-]+$/.test(c.repo ?? ''))
      .map(([k]) => k);
    expect(missing, 'each entry needs `repo: owner/name` so the number can be re-checked').toEqual(
      [],
    );
  });

  it('no page hardcodes a tracked competitor’s star count', () => {
    // Projects the data file tracks must render the tag. Projects it does not
    // track (jCodeMunch, claude-mem, engram and the rest of the long tail) keep
    // the figure from the pass that checked them — this test is about one
    // metric carrying three values, not about tracking every project.
    const pages = [
      'comparisons.md',
      'vs/repomix.md',
      'vs/serena.md',
      'vs/codebase-memory-mcp.md',
      'vs/codegraph.md',
      'vs/context-mode.md',
      'vs/repomix-vs-codegraph.md',
    ];
    // Only the shortened "NN.NK" strings: a three-digit count matches too much
    // unrelated prose to search for literally.
    const tracked = new Map(
      entries.filter(([, c]) => c.stars.endsWith('K')).map(([key, c]) => [c.stars, key]),
    );
    const offenders: string[] = [];
    for (const page of pages) {
      const raw = readFileSync(join(DOCS, page), 'utf-8');
      for (const line of raw.split('\n')) {
        // Dated verification prose records what a figure used to be ("41.1K ->
        // 41.2K this pass"). That is history, not a live claim.
        if (line.trimStart().startsWith('- **Star re-check')) continue;
        for (const [stars, key] of tracked) {
          if (line.includes(stars) && !line.includes(`competitors.${key}.stars`)) {
            offenders.push(`${page}: "${stars}" (${key})`);
          }
        }
      }
    }
    expect(offenders, 'use {{ site.data.competitors.<key>.stars }} instead').toEqual([]);
  });
});
