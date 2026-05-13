import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BenchmarkRunner, formatReportMarkdown } from '../runner.js';
import { loadDataset } from '../datasets/loader.js';
import { findProjectRoot } from '../../project-root.js';
import { getProject } from '../../registry.js';
import type { BenchmarkReport } from '../types.js';

describe('BenchmarkRunner construction', () => {
  it('rejects k < 1', () => {
    const dataset = loadDataset('default');
    expect(() => new BenchmarkRunner(dataset, { dbPath: '/tmp/nope.db', k: 0 })).toThrow(
      /k must be >= 1/,
    );
  });
});

describe('formatReportMarkdown', () => {
  it('renders headers, rollup table, and per-case rows', () => {
    const report: BenchmarkReport = {
      dataset_id: 'tiny',
      dataset_description: 'sample',
      ran_at: '2026-05-13T00:00:00.000Z',
      duration_ms: 42,
      k: 3,
      total_cases: 1,
      cases: [
        {
          case_id: 'c1',
          query: 'foo',
          expected_files: ['src/foo.ts'],
          results: [],
          metrics: [
            { name: 'precision@3', value: 0.3333 },
            { name: 'mrr', value: 1 },
            { name: 'first_hit_rank', value: 1 },
          ],
          latency_ms: 5,
          first_hit_rank: 1,
        },
      ],
      rollup: [
        { metric: 'first_hit_rank', mean: 1, min: 1, max: 1, n: 1 },
        { metric: 'mrr', mean: 1, min: 1, max: 1, n: 1 },
        { metric: 'precision@3', mean: 0.3333, min: 0.3333, max: 0.3333, n: 1 },
      ],
    };
    const md = formatReportMarkdown(report);
    expect(md).toContain('# Eval report — tiny');
    expect(md).toContain('| precision@3 |');
    expect(md).toContain('| c1 |');
    expect(md).toContain('Top-K: 3');
  });
});

describe('BenchmarkRunner.run (integration — needs indexed project)', () => {
  // The slice runs against the host project's index. If the project isn't
  // indexed (e.g. clean checkout in CI), skip the integration test.
  const cwd = process.cwd();
  let projectRoot: string | null = null;
  try {
    projectRoot = findProjectRoot(cwd);
  } catch {
    projectRoot = null;
  }
  const entry = projectRoot ? getProject(projectRoot) : null;
  const haveIndex = entry !== null && fs.existsSync(entry.dbPath);

  it.skipIf(!haveIndex)('produces a report with rollup and per-case rows', async () => {
    if (!entry) throw new Error('unreachable — guarded by skipIf');
    const dataset = loadDataset('default');
    const runner = new BenchmarkRunner(dataset, { dbPath: entry.dbPath, k: 5 });
    const report = await runner.run();
    expect(report.dataset_id).toBe('default');
    expect(report.total_cases).toBe(dataset.cases.length);
    expect(report.cases).toHaveLength(dataset.cases.length);
    // Every case carries the three metrics we register.
    for (const c of report.cases) {
      const names = c.metrics.map((m) => m.name).sort();
      expect(names).toEqual(['first_hit_rank', 'mrr', 'precision@5'].sort());
      // results length is capped at k=5
      expect(c.results.length).toBeLessThanOrEqual(5);
    }
    // Rollup must include all three metric names.
    const rollupNames = report.rollup.map((r) => r.metric).sort();
    expect(rollupNames).toContain('mrr');
    expect(rollupNames).toContain('precision@5');
    expect(rollupNames).toContain('first_hit_rank');
    // The rollup mean values are within [0, max], where max for precision is
    // 1/k = 0.2, for mrr is 1, and first_hit_rank floor is 1 (it filters out
    // zeros).
    const p = report.rollup.find((r) => r.metric === 'precision@5')!;
    expect(p.mean).toBeGreaterThanOrEqual(0);
    expect(p.mean).toBeLessThanOrEqual(1);
  });
});
