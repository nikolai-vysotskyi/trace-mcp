import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getLabRun, listLabRuns, saveLabRun } from '../store.js';
import type { LabRun } from '../runner.js';

function fakeRun(run_id: string): LabRun {
  return {
    schema_version: 1,
    run_id,
    started_at: '2026-09-26T00:00:00.000Z',
    finished_at: '2026-09-26T00:01:00.000Z',
    project_root: '/tmp/proj',
    battery: {
      source: 'tests/recall-harness/fixtures',
      fixtures_dir: '/tmp/fixtures',
      fixtures_sha: 'abc123',
      fixture_count: 1,
    },
    measured_build: { version: '3.33.0', commit: 'deadbeef' },
    model: { name: 'claude-sonnet-4-5', input_usd_per_mtok: 3 },
    arms: ['file-reading', 'minimal'],
    results: [],
    aggregates: [
      {
        arm: 'file-reading',
        fixtures: 1,
        success_count: 1,
        success_rate: 100,
        total_tokens: 1000,
        total_calls: 2,
        total_ms: 10,
        median_tokens_per_fixture: 1000,
        savings_vs_baseline_pct: null,
        cost_usd: 0.003,
      },
    ],
  };
}

describe('lab run store', () => {
  it('round-trips save → list → get', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-lab-store-'));
    const file = saveLabRun(fakeRun('lab-20260926-000000-aaaaaa'), home);
    expect(file).toMatch(/\.json$/);

    const listed = listLabRuns(home);
    expect(listed).toHaveLength(1);
    expect(listed[0].run_id).toBe('lab-20260926-000000-aaaaaa');
    expect(listed[0].build).toBe('3.33.0@deadbeef');

    const full = getLabRun('lab-20260926-000000-aaaaaa', home);
    expect(full?.battery.fixtures_sha).toBe('abc123');
  });

  it('lists newest first and skips corrupt files', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-lab-store-'));
    saveLabRun(
      { ...fakeRun('lab-20260926-000000-aaaaaa'), started_at: '2026-09-26T00:00:00.000Z' },
      home,
    );
    saveLabRun(
      { ...fakeRun('lab-20260926-000001-bbbbbb'), started_at: '2026-09-26T00:01:00.000Z' },
      home,
    );
    fs.writeFileSync(path.join(home, 'benchmark-runs', 'half-written.json'), '{"schema_version":');
    fs.writeFileSync(
      path.join(home, 'benchmark-runs', 'foreign.json'),
      JSON.stringify({ nope: true }),
    );

    const listed = listLabRuns(home);
    expect(listed.map((r) => r.run_id)).toEqual([
      'lab-20260926-000001-bbbbbb',
      'lab-20260926-000000-aaaaaa',
    ]);
  });

  it('returns null for a missing run and an empty list for a fresh home', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-lab-store-'));
    expect(listLabRuns(home)).toEqual([]);
    expect(getLabRun('lab-nope', home)).toBeNull();
  });
});
