import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_DAYS_FOR_TRIM } from '../../scripts/ga4-savings.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA = 'docs/_data/savings.yml';

const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(REPO_ROOT, p));

/** One scalar out of `docs/_data/savings.yml` — a flat file of flat keys. */
function datum(name: string): string {
  const raw = read(DATA).match(new RegExp(`^${name}:\\s*"?([^"\n]+)"?\\s*$`, 'm'))?.[1];
  if (raw === undefined) throw new Error(`${DATA} has no \`${name}\``);
  return raw.trim();
}

/**
 * The counter is published only when there is something honest to publish.
 *
 * `scripts/refresh-savings.mjs` refuses to write the data file while the GA4
 * window is shorter than `MIN_DAYS_FOR_TRIM`, because below that the sanitizer
 * returns the raw sum of an unauthenticated counter untouched. So an absent
 * file is a valid state — "not publishable yet" — and the surfaces have to
 * degrade to saying nothing rather than to saying zero.
 */
describe('savings counter', () => {
  const readme = read('README.md');
  const index = read('docs/index.html');

  it('renders the homepage figure from site.data, never as a literal', () => {
    for (const key of ['tokens_display', 'usd_display', 'price_model', 'refreshed']) {
      expect(index, `docs/index.html should render site.data.savings.${key}`).toContain(
        `site.data.savings.${key}`,
      );
    }
    // Guarded, so the block disappears instead of rendering blanks when the
    // refresh has refused to produce a file.
    expect(index).toContain('{% if site.data.savings %}');
  });

  it('never claims the number only grows', () => {
    // The sanitizer recomputes one median across the whole window, so a later
    // day can lower it, retroactively cap earlier days, and pull the total
    // down while the raw sum rises. Any monotonic phrasing is a false claim.
    for (const surface of [readme, index]) {
      expect(surface).not.toMatch(/only grows|and counting|never lies|understates rather than/i);
    }
  });

  it('never claims the real saving is higher than the figure shown', () => {
    // We price one rate against a token count; we do not price the observed
    // model mix, and installs may run cheaper, local, or free models.
    for (const surface of [readme, index]) {
      expect(surface).not.toMatch(/real (figure|saving)[^.]*is higher|at least \$/i);
    }
  });

  describe.skipIf(!exists(DATA))('once the data file is published', () => {
    it('covers a window long enough to have been sanitized', () => {
      expect(
        Number(datum('days')),
        'refresh-savings.mjs should have refused to write this file',
      ).toBeGreaterThanOrEqual(MIN_DAYS_FOR_TRIM);
    });

    it('displays figures floored below the snapshot they came from', () => {
      const display = datum('tokens_display');
      expect(display).toMatch(/^\d+(\.\d)?[KMB]\+$/);
      const unit = { K: 1e3, M: 1e6, B: 1e9 }[display.at(-2) as 'K' | 'M' | 'B'];
      expect(Number.parseFloat(display) * unit).toBeLessThanOrEqual(Number(datum('tokens')));
      expect(Number(datum('usd_display').replace(/[$+]/g, ''))).toBeLessThanOrEqual(
        Number(datum('usd')),
      );
    });

    it('derives the dollar figure from the rate it names', () => {
      const perMtok = Number(datum('price_usd_per_mtok'));
      expect(Number(datum('usd'))).toBeCloseTo((Number(datum('tokens')) / 1e6) * perMtok, 1);

      const source = read('src/analytics/real-savings.ts');
      const model = datum('price_model');
      const match = source.match(new RegExp(`'${model}':\\s*([0-9.]+)\\s*/\\s*1_000_000`));
      expect(match, `MODEL_PRICING has no entry for ${model}`).not.toBeNull();
      expect(Number(match?.[1])).toBe(perMtok);
    });

    it('keeps the README literals in step with the data file', () => {
      // The README is plain markdown — Jekyll never renders it, so it cannot
      // read site.data and has to carry the numbers literally. Same drift
      // guard counts.yml exists for. Refresh, then update the README to match.
      expect(readme).toContain(`<strong>${datum('tokens_display')} tokens saved</strong>`);
      expect(readme).toContain(`<code>${datum('price_model')}</code> input rate`);
    });
  });

  it.skipIf(exists(DATA))('makes no savings claim while nothing is publishable', () => {
    expect(readme).not.toMatch(/tokens saved/i);
  });
});

/**
 * The aggregate figure — TRA-904.
 *
 * `~40–50% fewer tokens on average` was printed on the homepage, in the README,
 * in `server.json` and in two FAQ answers for months. It was never measured:
 * TRA-880 traced it to a counter that scored every call before the tool ran
 * (`RAW_COST_ESTIMATES[tool] × 0.15`, a constant). Measured against real
 * responses the same call mix is 29.3%, and four of twelve tools cost more than
 * they replace.
 *
 * TRA-762 was the same defect one layer down — README claimed measured tokens
 * while `benchmark.ts` was synthetic — and it was caught by a human read. This
 * is the test that would have caught both: on our own storefront surfaces, an
 * aggregate token figure has to come from a generated data file, and a
 * hand-typed range has to say what kind of number it is.
 *
 * Deliberately scoped to the storefront. `docs/vs/*` quotes other people's
 * claims by the paragraph and a dragnet there would be all allowlist.
 */
describe('aggregate savings claims (TRA-904)', () => {
  const RESPONSE_DATA = 'docs/_data/response_tokens.json';
  const bench = JSON.parse(read('docs/_data/pr_context_bench.json')) as Record<string, number>;
  const response = JSON.parse(read(RESPONSE_DATA)) as Record<string, number>;

  /** Our own storefront. Every one of these quotes a savings number at a stranger. */
  const STOREFRONT = [
    'README.md',
    'docs/index.html',
    'docs/_config.yml',
    'server.json',
    'skills/README.md',
    'docs/reduce-claude-code-token-usage.md',
  ];

  /** Small numbers the README spells out — see the literal check below. */
  const WORD: Record<number, string> = { 4: 'four', 12: 'twelve' };

  /** Liquid stripped, so a tag-rendered figure is never mistaken for a typed one. */
  const typedIn = (src: string) => src.replace(/\{\{[^}]*\}\}/g, '').replace(/\{%[^%]*%\}/g, '');

  const TOKEN_CONTEXT = /token|saving|saved|reduction|fewer|less redundant/i;
  const RANGE = /\d{1,3}(?:\.\d)?\s*(?:–|—|&ndash;|&mdash;|-| to )\s*\d{1,3}(?:\.\d)?\s*%/;
  /** Marked as history ("we used to print X") or as an estimate. Both are disclosure. */
  const DISCLOSED =
    /used to (print|say|claim)|until \d|no longer|replaced|superseded|disproved|synthetic|estimate|estimated/i;

  it('states no hand-typed savings range without saying what kind of number it is', () => {
    const offenders: string[] = [];
    for (const file of STOREFRONT) {
      for (const line of typedIn(read(file)).split('\n')) {
        if (!RANGE.test(line) || !TOKEN_CONTEXT.test(line)) continue;
        if (DISCLOSED.test(line)) continue;
        offenders.push(`${file}: ${line.trim().slice(0, 160)}`);
      }
    }
    expect(
      offenders,
      'A range like "40–50%" is always a guess dressed as a measurement. Either source it from ' +
        `${RESPONSE_DATA} / docs/_data/pr_context_bench.json, or say on the same line that it is a ` +
        'synthetic estimate (or what it replaced). TRA-904.',
    ).toEqual([]);
  });

  it('quotes no per-session average that is not a generated datum', () => {
    // The exact shape of the disproved claim: a percentage worn as an average.
    const AVERAGE = /(\d{1,3}(?:\.\d)?)\s*%[^.]{0,80}?(on average|per session|typical)/i;
    const allowed = new Set(
      [bench.median_savings_pct, response.reduction_pct, response.credited_reduction_pct].map(
        String,
      ),
    );
    const offenders: string[] = [];
    for (const file of STOREFRONT) {
      for (const line of typedIn(read(file)).split('\n')) {
        const hit = line.match(AVERAGE);
        if (!hit || !TOKEN_CONTEXT.test(line)) continue;
        if (DISCLOSED.test(line) || allowed.has(hit[1])) continue;
        offenders.push(`${file}: ${hit[0]}`);
      }
    }
    expect(
      offenders,
      `An average token figure has to be a value from ${RESPONSE_DATA}, rendered from site.data ` +
        'on Jekyll surfaces and kept in step by this test everywhere else.',
    ).toEqual([]);
  });

  it('renders the aggregate from site.data on the Jekyll surfaces, never as a literal', () => {
    for (const file of ['docs/index.html', 'docs/reduce-claude-code-token-usage.md']) {
      const src = read(file);
      expect(
        src.includes('site.data.response_tokens.'),
        `${file} no longer reads {{ site.data.response_tokens.* }}. The aggregate is generated ` +
          `by scripts/gen-response-tokens-data.ts into ${RESPONSE_DATA}; never type it in.`,
      ).toBe(true);
      const literal = new RegExp(`(?<![\\d.])${response.reduction_pct}\\s*%`);
      const hit = typedIn(src).match(literal);
      expect(hit?.[0] ?? null, `${file} states the aggregate outside a Liquid tag`).toBe(null);
    }
  });

  it('keeps the literals on non-Jekyll surfaces in step with the data files', () => {
    // README.md, skills/README.md and server.json are never rendered by Jekyll,
    // so they carry the numbers literally — same bargain counts.yml struck.
    const cases: [string, string][] = [
      ['README.md', `${response.reduction_pct}%`],
      ['README.md', `${response.calls_weighted.toLocaleString('en-US')} recorded calls`],
      // Spelled out: `4 of the 12 tools` reads as a tool-surface claim to
      // readme-claims.test.ts, which then fails on a number that is not one.
      [
        'README.md',
        `${WORD[response.tools_costing_more] ?? response.tools_costing_more} of the ${WORD[response.tools_measured] ?? response.tools_measured} tools`,
      ],
      ['skills/README.md', `${response.reduction_pct}%`],
      ['skills/README.md', `${response.calls_weighted.toLocaleString('en-US')} real tool calls`],
      // Trimmed to fit the registry's 100-char description limit, so it states
      // the figure and the task rather than a full sentence.
      ['server.json', `${bench.median_savings_pct}% fewer PR-review tokens`],
    ];
    for (const [file, needle] of cases) {
      expect(
        read(file).includes(needle),
        `${file} should state "${needle}" — re-run \`npx tsx scripts/gen-response-tokens-data.ts\` ` +
          'and update the literal to match the data file.',
      ).toBe(true);
    }
  });

  it('never quotes the aggregate without the caveat that its baseline is a guess', () => {
    // The measured half is the response; "what a Read/Grep would have cost
    // instead" is still hand-written in RAW_COST_ESTIMATES. A figure that drops
    // that sentence is back to claiming more than we measured.
    expect(response.baseline_is_estimated).toBe(true);
    for (const file of ['README.md', 'docs/index.html', 'docs/reduce-claude-code-token-usage.md']) {
      expect(
        /(still (a hand-written |an )?estimate|estimated baseline|estimated file-reading baseline|baseline that is still an estimate)/i.test(
          read(file),
        ),
        `${file} quotes the aggregate but no longer says its baseline is an estimate (TRA-904).`,
      ).toBe(true);
    }
  });

  it('regenerates byte-identically from its inputs', async () => {
    // The data file is committed, so the only thing keeping it honest is that
    // re-running the generator reproduces it. If this fails, someone edited
    // docs/_data/response_tokens.json by hand.
    const { execFileSync } = await import('node:child_process');
    const out = path.join(os.tmpdir(), `response-tokens-${process.pid}.json`);
    execFileSync('npx', ['tsx', 'scripts/gen-response-tokens-data.ts'], {
      cwd: REPO_ROOT,
      env: { ...process.env, RESPONSE_TOKENS_OUT: out },
    });
    expect(
      fs.readFileSync(out, 'utf8'),
      `${RESPONSE_DATA} is generated — do not edit it by hand`,
    ).toBe(read(RESPONSE_DATA));
    fs.rmSync(out, { force: true });
  }, 60_000);
});
