import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Benchmark Lab figures on docs surfaces (TRA-1951).
 *
 * The Lab exists to replace prose with measured tables. The guard runs the
 * other way: the vs page that quotes a Lab run must render every figure from
 * `docs/_data/benchmark_lab.json` through Liquid, never typed in — otherwise
 * the next re-run moves the data file and the page silently keeps describing
 * the old run. The preregistration page is the verdict record and is allowed
 * its literals; this test scopes itself to the quoting surface.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA = 'docs/_data/benchmark_lab.json';
const PAGE = 'docs/vs/tokensave.md';
const CHART = 'docs/images/benchmark-lab-tokens.svg';

const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const lab = () => JSON.parse(read(DATA)) as Record<string, never>;

describe('benchmark lab claims', () => {
  it('ships the data file with provenance and the documented arm order', () => {
    const data = lab() as {
      measured_build: { version: string; commit: string; dirty?: boolean };
      generated_at: string;
      battery: {
        source: string;
        fixtures_sha: string;
        fixture_count: number;
        fixtures_dir?: string;
      };
      model: { name: string; input_usd_per_mtok: number };
      arms: { arm: string }[];
    };
    expect(data.measured_build.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(data.measured_build.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(data.measured_build.dirty ?? false).toBe(false);
    expect(data.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(data.battery.source).toBe('tests/recall-harness/fixtures');
    expect(data.battery.fixtures_sha).toMatch(/^[0-9a-f]{16}$/);
    expect(data.battery.fixture_count).toBeGreaterThan(0);
    // Machine-local checkout paths must not ship in the data file — the sha
    // is the comparability contract, the path is not.
    expect(data.battery.fixtures_dir ?? null).toBe(null);
    expect(data.model.name.length).toBeGreaterThan(0);
    expect(data.arms.map((a) => a.arm)).toEqual(['file-reading', 'minimal', 'standard']);
  });

  it('quotes no Lab figure on the vs page outside a Liquid tag', () => {
    const src = read(PAGE);
    expect(src.includes('site.data.benchmark_lab.'), `${PAGE} no longer reads the Lab data`).toBe(
      true,
    );
    const data = lab() as {
      arms: {
        total_tokens: number;
        total_calls: number;
        cost_usd: number;
        savings_vs_baseline_pct: number | null;
      }[];
      battery: { fixtures_sha: string; fixture_count: number };
      measured_build: { version: string; commit: string };
      model: { name: string; input_usd_per_mtok: number };
    };
    const literals = new Set<string>();
    for (const a of data.arms) {
      // Token totals, costs and savings are long and distinctive. Call counts
      // and fixture counts are single digits that occur coincidentally all
      // over the page — asserting on them would false-positive.
      literals.add(String(a.total_tokens));
      literals.add(a.total_tokens.toLocaleString('en-US'));
      literals.add(String(a.cost_usd));
      if (a.savings_vs_baseline_pct !== null) literals.add(String(a.savings_vs_baseline_pct));
    }
    literals.add(data.battery.fixtures_sha);
    literals.add(data.measured_build.commit);
    // The build version and model name travel inside Liquid tags too; the
    // typed-out page must not carry them as prose.
    const stripped = src.replace(/\{\{[^}]*\}\}/g, '').replace(/\{%[^%]*%\}/g, '');
    const offenders = [...literals].filter((lit) => lit.length > 0 && stripped.includes(lit));
    expect(
      offenders,
      `${PAGE} states Lab figures outside Liquid tags (${offenders.join(', ')}) — re-run ` +
        '`tsx scripts/bench-lab.ts` and they silently describe the wrong run. TRA-1951.',
    ).toEqual([]);
  });

  it('illustrates the run with the generated chart, captioned and described', () => {
    expect(
      fs.existsSync(path.join(REPO_ROOT, CHART)),
      `${CHART} missing — run node scripts/gen-benchmark-lab-chart.mjs`,
    ).toBe(true);
    const src = read(PAGE);
    expect(src).toContain(CHART.replace(/^docs/, ''));
    expect(src).toMatch(
      /<figure>[\s\S]*<img[^>]*alt="[^"]+"[^>]*>[\s\S]*<figcaption>[\s\S]*<\/figcaption>[\s\S]*<\/figure>/,
    );
  });

  it('regenerates the chart byte-identically from the data file', () => {
    const out = path.join(os.tmpdir(), `benchmark-lab-chart-${process.pid}.svg`);
    execFileSync(process.execPath, ['scripts/gen-benchmark-lab-chart.mjs', DATA, out], {
      cwd: REPO_ROOT,
    });
    expect(fs.readFileSync(out, 'utf8'), `${CHART} is generated — do not edit it by hand`).toBe(
      read(CHART),
    );
    fs.rmSync(out, { force: true });
  });
});
