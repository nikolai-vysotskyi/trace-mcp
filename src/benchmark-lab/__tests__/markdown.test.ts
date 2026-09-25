import { describe, expect, it } from 'vitest';
import { renderLabMarkdown } from '../markdown.js';
import type { LabRun } from '../runner.js';

function fakeRun(): LabRun {
  return {
    schema_version: 1,
    run_id: 'lab-20260926-000000-aaaaaa',
    started_at: '2026-09-26T00:05:00.000Z',
    finished_at: '2026-09-26T00:06:00.000Z',
    project_root: '/tmp/proj',
    battery: {
      source: 'tests/recall-harness/fixtures',
      fixtures_dir: '/tmp/fixtures',
      fixtures_sha: 'abc123def456',
      fixture_count: 2,
    },
    measured_build: { version: '3.33.0', commit: 'deadbeef' },
    model: { name: 'claude-sonnet-4-5', input_usd_per_mtok: 3 },
    arms: ['file-reading', 'minimal', 'standard'],
    results: [
      {
        fixture_id: 'fx-one',
        kind: 'symbol',
        query: 'foo',
        k: 5,
        baseline: 1,
        arms: {
          'file-reading': { calls: 1, tokens: 1000, success: true, ms: 3, recall_at_k: null },
          minimal: { calls: 1, tokens: 200, success: true, ms: 12, recall_at_k: 1 },
          standard: { calls: 2, tokens: 350, success: true, ms: 20, recall_at_k: 1 },
        },
      },
    ],
    aggregates: [
      {
        arm: 'file-reading',
        fixtures: 1,
        success_count: 1,
        success_rate: 100,
        total_tokens: 1000,
        total_calls: 1,
        total_ms: 3,
        median_tokens_per_fixture: 1000,
        savings_vs_baseline_pct: null,
        cost_usd: 0.003,
      },
      {
        arm: 'minimal',
        fixtures: 1,
        success_count: 1,
        success_rate: 100,
        total_tokens: 200,
        total_calls: 1,
        total_ms: 12,
        median_tokens_per_fixture: 200,
        savings_vs_baseline_pct: 80,
        cost_usd: 0.0006,
      },
      {
        arm: 'standard',
        fixtures: 1,
        success_count: 1,
        success_rate: 100,
        total_tokens: 350,
        total_calls: 2,
        total_ms: 20,
        median_tokens_per_fixture: 350,
        savings_vs_baseline_pct: 65,
        cost_usd: 0.0011,
      },
    ],
  };
}

describe('lab markdown export', () => {
  it('renders the arm table with provenance, not prose', () => {
    const md = renderLabMarkdown(fakeRun());
    // Aggregate table
    expect(md).toContain('| minimal | 200 | 1 | 1/1 | −80.0% | $0.0006 |');
    expect(md).toContain('| standard | 350 | 2 | 1/1 | −65.0% | $0.0011 |');
    expect(md).toContain('| file-reading | 1,000 | 1 | 1/1 | — (control) | $0.0030 |');
    // Per-fixture rows
    expect(md).toContain('| fx-one | symbol | 1,000/✓ | 200/✓ | 350/✓ |');
    // Provenance: date, build, battery hash — the re-run contract.
    expect(md).toContain('2026-09-26');
    expect(md).toContain('3.33.0@deadbeef');
    expect(md).toContain('abc123def456');
    expect(md).toContain('claude-sonnet-4-5');
  });

  it('marks the control arm instead of printing a self-comparison', () => {
    const md = renderLabMarkdown(fakeRun());
    expect(md).not.toContain('NaN');
    expect(md).not.toContain('undefined');
  });
});
