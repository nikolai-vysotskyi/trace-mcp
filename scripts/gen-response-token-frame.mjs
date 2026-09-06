#!/usr/bin/env node
/**
 * TRA-993: build the sampling frame the response-token benchmark prices its
 * three volume-heavy tools against — `search_text`, `get_outline`, `search`,
 * 76% of the weight in that metric.
 *
 * TRA-985 measured the same build under three hand-picked frames and got 21.0%,
 * 30.7% and 56.0%. Every one of those baskets was assembled by a person after
 * seeing a number, and one of them (fifteen single lowercase subsystem words)
 * turned out to be enriched for the exact defect the same change fixed. So this
 * frame is generated, frozen and committed *before* the run that uses it, and
 * every item carries the rule that produced it so a reader can re-check it
 * mechanically rather than take a sentence's word for it.
 *
 * Composition, and where each part comes from:
 *
 * - Query strata are weighted by the shape of the 1,133 recorded `search`
 *   queries in `~/.trace/analytics.db` — the only recorded arguments that exist
 *   for any of the three tools. Measured here (TRA-993, same n=1,133):
 *   10.3% single all-lowercase word, 60.7% single mixed-case/underscore
 *   identifier, 28.9% multi-word phrase, mean 1.69 words. Those queries target
 *   private repositories this bench does not index, so only the shape crosses
 *   over; no recorded string is committed.
 *   (TRA-985 reported 24.9% single lowercase words from the same 1,133 rows.
 *   That figure does not reproduce under any classifier tried here — 10.3% for
 *   `^[a-z]+$`, 15.2% allowing `_` and digits, 71.1% for any single token.)
 * - Items inside each stratum come from this repo's own corpus by a positional
 *   rule — sort, then take every Nth. No seed, no judgement, no rejection.
 * - `search` and `search_text` share one query basket. There are zero recorded
 *   arguments for `search_text`, so giving it a basket of its own would mean
 *   inventing usage; sharing at least makes the assumption visible and lets the
 *   per-item rows show where a query that suits one tool starves the other.
 *
 *   node scripts/gen-response-token-frame.mjs <index.db> [--out <path>]
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outPath =
  outIdx >= 0 ? args[outIdx + 1] : join(REPO, 'benchmarks/response-tokens/frame.json');
if (!dbPath) {
  console.error('usage: gen-response-token-frame.mjs <index.db> [--out <path>]');
  process.exit(1);
}

/** Recorded shape of `search` arguments; the only usage evidence that exists. */
const SHAPE = {
  word: 10.3,
  identifier: 60.7,
  phrase: 28.9,
  sample: 1133,
  mean_words: 1.69,
};
const QUERY_COUNT = 20;
const FILE_COUNT = 15;

/** Sort, then take every Nth. The only selection rule in this file. */
function everyNth(all, count) {
  const step = Math.floor(all.length / count) || 1;
  const picked = [];
  for (let i = 0; picked.length < count && i * step < all.length; i += 1) {
    const v = all[i * step];
    if (!picked.includes(v)) picked.push(v);
  }
  return picked;
}

const splitWords = (name) =>
  name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

const db = new Database(dbPath, { readonly: true });

// Stratum "word": directory names under src/. Filename-shaped by construction —
// this is the shape that exposes module-body pseudo-symbols, and it stays in the
// frame at its recorded weight rather than being dropped because it flatters or
// hurts. Provenance is checkable with `ls`.
const dirNames = [
  ...new Set(
    readdirSync(join(REPO, 'src'), { recursive: true, withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => /^[a-z][a-z0-9]{3,}$/.test(n)),
  ),
].sort();

// Strata "identifier" and "phrase": real symbol names from the index. Symbols
// are never named after files, so neither stratum can be aimed at a
// `__module__:<filename>` pseudo-symbol.
const symbolNames = [
  ...new Set(
    db
      .prepare(
        `SELECT name FROM symbols
          WHERE name NOT GLOB '__module__*' AND length(name) > 3 AND kind != 'namespace'
            AND name GLOB '[A-Za-z_]*' AND name NOT GLOB '*[^A-Za-z0-9_]*'
          ORDER BY symbol_id`,
      )
      .all()
      .map((r) => r.name),
  ),
];
const identifierPool = symbolNames.filter((n) => !/^[a-z]+$/.test(n));
const phrasePool = [
  ...new Set(
    symbolNames
      .map(splitWords)
      .filter((w) => w.length >= 2)
      .map((w) => w.join(' ')),
  ),
];

// Files for get_outline: every indexed source file, path-sorted, uniform. Not
// stratified by size — outline cost tracks symbol count, not line count, so a
// size stratification would be a choice dressed as a control.
const files = db
  .prepare(`SELECT path FROM files WHERE path GLOB 'src/*' ORDER BY path`)
  .all()
  .map((r) => r.path)
  .filter((p) => /\.ts$/.test(p) && !/\.test\.ts$/.test(p));

const share = (pct) => Math.round((pct / 100) * QUERY_COUNT);
const queries = [
  ...everyNth(dirNames, share(SHAPE.word)).map((q) => ({ q, stratum: 'word' })),
  ...everyNth(identifierPool, share(SHAPE.identifier)).map((q) => ({
    q,
    stratum: 'identifier',
  })),
  ...everyNth(phrasePool, share(SHAPE.phrase)).map((q) => ({
    q,
    stratum: 'phrase',
  })),
];

const frame = {
  issue: 'TRA-993',
  generated_by: 'scripts/gen-response-token-frame.mjs',
  generated_from: {
    repo_commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO,
    })
      .toString()
      .trim(),
    symbols: symbolNames.length,
    source_files: files.length,
    directories: dirNames.length,
  },
  query_shape: {
    source: '1,133 recorded `search` arguments, ~/.trace/analytics.db, one machine',
    ...SHAPE,
    note: 'Strings not committed: they name symbols in private repositories. Only the shape crosses over.',
  },
  rules: {
    word: 'directory basenames under src/ matching ^[a-z][a-z0-9]{3,}$, deduped, sorted, every Nth',
    identifier:
      'symbol names from the index (no pseudo-symbols, >3 chars, [A-Za-z0-9_] only, not all-lowercase), ordered by symbol_id, every Nth',
    phrase:
      'symbol names split on camelCase/snake_case into >=2 lowercase words, deduped, ordered by symbol_id, every Nth',
    file: 'indexed non-test .ts files under src/, path-sorted, every Nth',
  },
  queries,
  files: everyNth(files, FILE_COUNT).map((path) => ({ path, stratum: 'file' })),
};

writeFileSync(outPath, `${JSON.stringify(frame, null, 2)}\n`);
console.log(outPath);
