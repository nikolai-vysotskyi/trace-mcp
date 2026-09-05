import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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

  /**
   * Our own storefront. Every one of these quotes a savings number at a stranger.
   *
   * `package.json` and `plugin.json` are here because they are the loudest of
   * the lot and the easiest to forget: `npm view trace-mcp description` and
   * every plugin listing read them, and the first pass of this sweep missed
   * both while updating `server.json` beside them.
   */
  const STOREFRONT = [
    'README.md',
    'docs/index.html',
    'docs/_config.yml',
    'server.json',
    'package.json',
    'plugin.json',
    'skills/README.md',
    'docs/reduce-claude-code-token-usage.md',
  ];

  /** Small numbers the README spells out — see the literal check below. */
  const WORD: Record<number, string> = { 4: 'four', 10: 'ten', 12: 'twelve', 22: 'twenty-two' };

  /** Liquid stripped, so a tag-rendered figure is never mistaken for a typed one. */
  const typedIn = (src: string) => src.replace(/\{\{[^}]*\}\}/g, '').replace(/\{%[^%]*%\}/g, '');

  const TOKEN_CONTEXT = /token|saving|saved|reduction|fewer|less redundant/i;
  const RANGE = /\d{1,3}(?:\.\d)?\s*(?:–|—|&ndash;|&mdash;|-| to )\s*\d{1,3}(?:\.\d)?\s*%/;
  /**
   * Marked as history ("we used to print X") or as a named kind of estimate.
   *
   * Bare `estimate` is deliberately NOT enough: "Estimated savings of 40–50% on
   * average" would then excuse itself, which is the exact sentence this whole
   * change exists to delete. The phrase has to say *which* estimate.
   */
  const DISCLOSED =
    /used to (print|say|claim)|(this site|the README) claimed|until (that date|\d)|no longer|replaced|superseded|disproved|synthetic (estimate|benchmark)|estimated baseline|baseline (that is )?still (an|a hand-written) estimate|argued, not measured/i;

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
    // The exact shape of the disproved claim: a percentage worn as an average —
    // in either word order, and whether or not the sentence bothers to say
    // "fewer". "On average, agents save 45% of tokens" is the same claim.
    const HEDGE = 'on average|per session|typical|typically|expect';
    const PCT = String.raw`(\d{1,3}(?:\.\d)?)\s*%`;
    const AVERAGE = new RegExp(`${PCT}[^.]{0,80}?(?:${HEDGE})|(?:${HEDGE})[^.]{0,80}?${PCT}`, 'i');
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
        // Group 1 or 2 depending on which word order matched.
        if (DISCLOSED.test(line) || allowed.has(hit[1] ?? hit[2])) continue;
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
      // The denominator is tools_with_baseline, not tools_measured: a tool that
      // replaces no file read cannot cost more than a baseline it does not have
      // (TRA-945), so counting it here would understate the share.
      [
        'README.md',
        `${WORD[response.tools_costing_more] ?? response.tools_costing_more} of the ${WORD[response.tools_with_baseline] ?? response.tools_with_baseline} tools`,
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

  it('bounds the field counter at the day it started measuring', () => {
    // refresh-savings.mjs refuses a window that starts before the corrected
    // counter; ga4-snapshot.mjs is what sets that window. Two constants, one
    // fact — and if they drift the refusal either never clears or never fires.
    const constant = (file: string, name: string) =>
      read(file).match(new RegExp(`${name} = '(\\d{4}-\\d{2}-\\d{2})'`))?.[1];
    const gate = constant('scripts/refresh-savings.mjs', 'CORRECTED_COUNTER_SINCE');
    const window = constant('scripts/ga4-snapshot.mjs', 'SAVINGS_SINCE');
    expect(gate, 'refresh-savings.mjs lost CORRECTED_COUNTER_SINCE').toBeDefined();
    expect(
      window,
      'ga4-snapshot.mjs must bound the savings query at the same day refresh-savings.mjs gates on',
    ).toBe(gate);
  });

  it('regenerates byte-identically from its inputs', async () => {
    // The data file is committed, so the only thing keeping it honest is that
    // re-running the generator reproduces it. If this fails, someone edited
    // docs/_data/response_tokens.json by hand.
    const { execFileSync } = await import('node:child_process');
    const out = path.join(os.tmpdir(), `response-tokens-${process.pid}.json`);
    // `node --import tsx`, not `npx tsx`: npx is a shell script on Windows and
    // execFileSync cannot spawn it, which is how this test failed on
    // windows-latest and nowhere else.
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/gen-response-tokens-data.ts'], {
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

/**
 * Preregistration and version stamps — TRA-920.
 *
 * TRA-904 made an unsourced figure fail CI. Two holes stayed open behind it.
 *
 * Nothing was declared before a measurement ran, so a number produced after the
 * fact can always be read as a number that was shaped until it looked good —
 * and TRA-880 showed that failure mode is not hypothetical here. And no
 * published figure carried the build it was measured at, so a correct number
 * decays silently into a claim about code nobody is running.
 *
 * `docs/_data/measurements.yml` is the registry of every figure on a public
 * surface. For each entry this test demands a build stamp in the generated data,
 * a preregistration with a verdict, and — on the surfaces that print the figure
 * as a headline — the build and date rendered next to it.
 */
describe('preregistration and version stamps (TRA-920)', () => {
  type Entry = {
    title: string;
    data: string;
    prereg: string;
    historical: boolean;
  };
  const REGISTRY = 'docs/_data/measurements.yml';
  const measurements = Object.entries(parseYaml(read(REGISTRY)) as Record<string, Entry>);

  /**
   * How far a measurement may fall behind the shipped release before it stops
   * being a current claim. Six is roughly a month at our cadence. A stale figure
   * is not deleted — it is marked `historical: true` and every surface dates it.
   * Clear that flag by re-measuring, never by raising this number.
   */
  const STALE_AFTER_MINORS = 6;

  /** `---\n...\n---` at the top of a Jekyll page. */
  const frontMatter = (file: string) =>
    parseYaml(read(file).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '') as Record<string, unknown>;

  it('registers at least the two figures on the storefront', () => {
    expect(measurements.map(([key]) => key).sort()).toEqual(['pr_context', 'response_tokens']);
  });

  it.each(measurements)('%s carries the build it was measured at', (_key, entry) => {
    const data = JSON.parse(read(entry.data)) as {
      measured_build?: { version?: string; commit?: string };
      measured_at?: string;
      generated_at?: string;
    };
    const build = data.measured_build;
    expect(
      build,
      `${entry.data} has no measured_build. Benchmark scripts stamp it via ` +
        'scripts/measured-build.ts; a figure without one cannot be told from a stale one.',
    ).toBeDefined();
    expect(build?.version, `${entry.data}: measured_build.version`).toMatch(/^\d+\.\d+\.\d+/);
    expect(build?.commit, `${entry.data}: measured_build.commit`).toMatch(/^[0-9a-f]{7,40}$/);
    expect(data.measured_at ?? data.generated_at, `${entry.data} has no measurement date`).toMatch(
      /^\d{4}-\d{2}-\d{2}/,
    );
  });

  it.each(measurements)('%s has a preregistration with a verdict', (key, entry) => {
    const fm = frontMatter(entry.prereg);
    expect(fm.measurement, `${entry.prereg}: front matter should name its measurement`).toBe(key);
    expect(fm.data_file, `${entry.prereg}: front matter should name its data file`).toBe(
      entry.data,
    );
    // A missed bar is a publishable outcome — that is the whole point. What is
    // not publishable is a result with no bar to miss.
    expect(['MET', 'MISSED', 'NOT-RUN'], `${entry.prereg}: verdict`).toContain(fm.verdict);
    expect(
      ['yes', 'retrospective'],
      `${entry.prereg}: say whether this was preregistered or written afterwards`,
    ).toContain(fm.preregistration);

    const body = read(entry.prereg);
    for (const section of [
      '## Question',
      '## Metric',
      '## Corpus',
      '## Pass bar',
      '## Prediction',
    ]) {
      expect(body, `${entry.prereg} is missing ${section}`).toContain(section);
    }
    expect(body, `${entry.prereg} must state its control condition, or that it has none`).toMatch(
      /## Control/,
    );
    // Retrospective means retrospective on the page too, not only in front matter.
    if (fm.preregistration === 'retrospective') {
      expect(
        body,
        `${entry.prereg} is labelled retrospective in front matter but not on the page`,
      ).toMatch(/retrospective/i);
    }
  });

  it.each(measurements)('%s is dated as historical once it falls behind', (_key, entry) => {
    const release = JSON.parse(read('docs/_data/release.json')) as { version: string };
    const parts = (v: string) => v.split('.').map(Number);
    const [releaseMajor, releaseMinor] = parts(release.version);
    const [measuredMajor, measuredMinor] = parts(
      (JSON.parse(read(entry.data)) as { measured_build: { version: string } }).measured_build
        .version,
    );
    // A major bump resets the minor to 0, so a plain minor subtraction goes
    // negative and silently exempts every 3.x figure the day 4.0.0 ships.
    const behind =
      releaseMajor > measuredMajor ? Number.POSITIVE_INFINITY : releaseMinor - measuredMinor;
    if (behind <= STALE_AFTER_MINORS) return;
    expect(
      entry.historical,
      `${entry.data} was measured ${
        behind === Number.POSITIVE_INFINITY ? 'a major release' : `${behind} minor releases`
      } before ${release.version}. ` +
        `Re-measure, or set \`historical: true\` in ${REGISTRY} so every surface presents it ` +
        'as a dated result rather than a current claim. Do not raise STALE_AFTER_MINORS.',
    ).toBe(true);
  });

  /**
   * The surfaces that print a figure as a headline. Deliberately not every page
   * that mentions a number in passing — a stamp on the FAQ answers would be
   * noise, and the pages here are the ones a stranger reads the figure off.
   */
  const STAMPED: [string, string[]][] = [
    [
      'docs/index.html',
      ['site.data.pr_context_bench.measured_build', 'site.data.response_tokens.measured_build'],
    ],
    ['docs/pr-context-benchmark.md', ['site.data.pr_context_bench.measured_build']],
    ['docs/reduce-claude-code-token-usage.md', ['site.data.response_tokens.measured_build']],
  ];

  it.each(STAMPED)('%s renders the build next to the figure', (file, needles) => {
    const src = read(file);
    for (const needle of needles) {
      expect(
        src.includes(`${needle}.version`) && src.includes(`${needle}.commit`),
        `${file} should render {{ ${needle}.version }} and .commit next to the figure — TRA-920.`,
      ).toBe(true);
      // The `historical` guard has to be on the page before the figure goes
      // stale, not added on the day it does — otherwise flipping the registry
      // flag changes nothing a reader can see.
      const key = needle.split('.')[2].replace(/_bench$/, '');
      expect(
        src.includes(`site.data.measurements.${key}.historical`),
        `${file} renders the ${key} stamp but never checks ` +
          `site.data.measurements.${key}.historical, so marking that figure historical would ` +
          'not change what a reader sees — TRA-920.',
      ).toBe(true);
    }
  });

  it('keeps the README stamps in step with the data files', () => {
    // Same bargain as the literals above: Jekyll never renders README.md.
    const readme = read('README.md');
    for (const [, entry] of measurements) {
      const { measured_build: build } = JSON.parse(read(entry.data)) as {
        measured_build: { version: string; commit: string };
      };
      expect(
        readme.includes(`trace-mcp ${build.version} (\`${build.commit}\`)`),
        `README.md should state "trace-mcp ${build.version} (\`${build.commit}\`)" beside the ` +
          `${entry.title} figure — re-measure or update the literal. TRA-920.`,
      ).toBe(true);
    }
  });
});
