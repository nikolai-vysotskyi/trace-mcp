import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TRA-993: the sampling frame the response-token benchmark prices `search`,
 * `search_text` and `get_outline` against — 76% of that metric's weight.
 *
 * The frame is frozen and committed before the run that uses it. What this file
 * guards is the part TRA-985 got wrong: it published a basket whose stated
 * provenance ("the fifteen most common subsystem nouns in this repo's own
 * directory names") was false for eleven of fifteen items, and one `ls` would
 * have caught it. So every stratum rule stated in `frame.json` is re-checked
 * here against the repository itself.
 */
const REPO_ROOT = path.resolve(__dirname, '../..');
const FRAME = 'benchmarks/response-tokens/frame.json';

interface Frame {
  query_shape: {
    word: number;
    identifier: number;
    phrase: number;
    sample: number;
  };
  queries: Array<{ q: string; stratum: 'word' | 'identifier' | 'phrase' }>;
  files: Array<{ path: string }>;
}
const frame: Frame = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, FRAME), 'utf8'));

const strata = (name: string): string[] =>
  frame.queries.filter((q) => q.stratum === name).map((q) => q.q);

/** Every directory name under `src/`, which is what the `word` rule claims. */
const dirNames = new Set(
  fs
    .readdirSync(path.join(REPO_ROOT, 'src'), {
      recursive: true,
      withFileTypes: true,
    })
    .filter((e) => e.isDirectory())
    .map((e) => e.name),
);

/**
 * Does this string occur in the indexed corpus? The corpus is the whole
 * repository, not `src/` — that is what the benchmark indexes and therefore what
 * the frame is drawn from.
 */
function occursInCorpus(needle: string): boolean {
  const r = spawnSync('git', ['grep', '-lIiF', '--', needle], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim().length > 0;
}

describe('response-token sampling frame', () => {
  it('holds the recorded query shape, within one item of rounding', () => {
    const n = frame.queries.length;
    for (const stratum of ['word', 'identifier', 'phrase'] as const) {
      const declared = (frame.query_shape[stratum] / 100) * n;
      expect(
        Math.abs(strata(stratum).length - declared),
        `${stratum} stratum should carry its recorded share of ${n} queries`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('word stratum is directory names under src/ — the claim TRA-985 got wrong', () => {
    for (const q of strata('word')) {
      expect(dirNames.has(q), `"${q}" is not a directory name under src/`).toBe(true);
    }
  });

  it('identifier stratum is real symbol names, none of them all-lowercase', () => {
    for (const q of strata('identifier')) {
      expect(/^[A-Za-z_][A-Za-z0-9_]*$/.test(q), `"${q}" is not an identifier`).toBe(true);
      expect(/^[a-z]+$/.test(q), `"${q}" is all-lowercase, so it belongs in the word stratum`).toBe(
        false,
      );
      expect(occursInCorpus(q), `"${q}" does not occur in the repository`).toBe(true);
    }
  });

  it('phrase stratum is multi-word and every word is drawn from a real symbol', () => {
    for (const q of strata('phrase')) {
      const words = q.split(' ');
      expect(words.length, `"${q}" is not multi-word`).toBeGreaterThan(1);
      expect(q, `"${q}" should be lowercase`).toBe(q.toLowerCase());
      for (const w of words) {
        expect(occursInCorpus(w), `"${w}" of "${q}" does not occur in the repository`).toBe(true);
      }
    }
  });

  it('file stratum is non-test TypeScript under src/, and every path exists', () => {
    for (const { path: p } of frame.files) {
      expect(p.startsWith('src/'), `${p} is outside src/`).toBe(true);
      expect(p.endsWith('.ts') && !p.endsWith('.test.ts'), `${p} is not non-test TypeScript`).toBe(
        true,
      );
      expect(fs.existsSync(path.join(REPO_ROOT, p)), `${p} does not exist`).toBe(true);
    }
  });

  it('is the frame the published measurement actually ran on', () => {
    const measured = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'docs/perf/response-tokens.json'), 'utf8'),
    );
    expect(
      measured.frame,
      'response-tokens.json must record the frame it ran, so a reader can tell ' +
        'a re-measurement from a re-framing',
    ).toBeDefined();
    expect(measured.frame.queries).toEqual(frame.queries.map((q) => q.q));
    expect(measured.frame.files).toEqual(frame.files.map((f) => f.path));
  });
});
