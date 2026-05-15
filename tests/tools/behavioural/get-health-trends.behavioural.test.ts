/**
 * Behavioural coverage for the `get_health_trends` MCP tool.
 *
 * `getHealthTrends` reads time-series rows from `pi_health_history` populated
 * by `predict_bugs` (see `saveBugPredictionCache`). The MCP tool exposes:
 *   - `{ target, data_points, trend }` envelope on success.
 *   - `file_path` filter narrows the trend to a single file.
 *   - `module` filter narrows by directory prefix and averages across files.
 *   - `limit` caps the number of returned data points (chronologically newest
 *     are kept, then re-reversed to ascending order).
 *   - Missing both filters yields a VALIDATION_ERROR.
 *   - No rows in the table yields `data_points: []` and a `stable` trend.
 *
 * The persisted rows are inserted directly into `pi_health_history` so the
 * test never depends on a real git/index run.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getHealthTrends } from '../../../src/tools/analysis/predictive-intelligence.js';
import { createTestStore } from '../../test-utils.js';

interface HealthRow {
  file_path: string;
  recorded_at: string;
  bug_score: number | null;
  complexity_avg: number | null;
  coupling_ce: number | null;
  churn_per_week: number | null;
  test_coverage: number | null;
}

function insertHealthRow(store: Store, row: HealthRow): void {
  store.db
    .prepare(
      `INSERT INTO pi_health_history
        (file_path, recorded_at, bug_score, complexity_avg, coupling_ce, churn_per_week, test_coverage)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.file_path,
      row.recorded_at,
      row.bug_score,
      row.complexity_avg,
      row.coupling_ce,
      row.churn_per_week,
      row.test_coverage,
    );
}

describe('get_health_trends — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns { target, data_points, trend } envelope when rows exist for a file', () => {
    insertHealthRow(store, {
      file_path: 'src/widget.ts',
      recorded_at: '2026-01-01T00:00:00Z',
      bug_score: 0.4,
      complexity_avg: 5,
      coupling_ce: 0.2,
      churn_per_week: 3,
      test_coverage: 0.6,
    });
    insertHealthRow(store, {
      file_path: 'src/widget.ts',
      recorded_at: '2026-02-01T00:00:00Z',
      bug_score: 0.5,
      complexity_avg: 6,
      coupling_ce: 0.25,
      churn_per_week: 4,
      test_coverage: 0.55,
    });

    const result = getHealthTrends(store, { filePath: 'src/widget.ts' });
    expect(result.isOk()).toBe(true);
    const payload = result._unsafeUnwrap();
    expect(payload.target).toBe('src/widget.ts');
    expect(Array.isArray(payload.data_points)).toBe(true);
    expect(payload.data_points).toHaveLength(2);
    expect(['improving', 'stable', 'degrading']).toContain(payload.trend);
    // Documented per-point shape.
    const point = payload.data_points[0];
    expect(point).toHaveProperty('date');
    expect(point).toHaveProperty('bug_score');
    expect(point).toHaveProperty('complexity_avg');
    expect(point).toHaveProperty('coupling');
    expect(point).toHaveProperty('churn');
    expect(point).toHaveProperty('test_coverage');
  });

  it('file_path filter narrows the result to one file', () => {
    insertHealthRow(store, {
      file_path: 'src/widget.ts',
      recorded_at: '2026-01-01T00:00:00Z',
      bug_score: 0.3,
      complexity_avg: 5,
      coupling_ce: 0.2,
      churn_per_week: 3,
      test_coverage: 0.6,
    });
    insertHealthRow(store, {
      file_path: 'src/helper.ts',
      recorded_at: '2026-01-01T00:00:00Z',
      bug_score: 0.9,
      complexity_avg: 12,
      coupling_ce: 0.7,
      churn_per_week: 10,
      test_coverage: 0.1,
    });

    const widget = getHealthTrends(store, { filePath: 'src/widget.ts' });
    expect(widget.isOk()).toBe(true);
    const widgetPayload = widget._unsafeUnwrap();
    expect(widgetPayload.data_points).toHaveLength(1);
    expect(widgetPayload.data_points[0].bug_score).toBeCloseTo(0.3);
    expect(widgetPayload.target).toBe('src/widget.ts');
  });

  it('module filter aggregates rows under the directory prefix', () => {
    insertHealthRow(store, {
      file_path: 'src/mod/a.ts',
      recorded_at: '2026-01-01T00:00:00Z',
      bug_score: 0.4,
      complexity_avg: 5,
      coupling_ce: 0.2,
      churn_per_week: 3,
      test_coverage: 0.5,
    });
    insertHealthRow(store, {
      file_path: 'src/mod/b.ts',
      recorded_at: '2026-01-01T00:00:00Z',
      bug_score: 0.6,
      complexity_avg: 7,
      coupling_ce: 0.4,
      churn_per_week: 5,
      test_coverage: 0.7,
    });
    insertHealthRow(store, {
      file_path: 'src/other/c.ts',
      recorded_at: '2026-01-01T00:00:00Z',
      bug_score: 0.9,
      complexity_avg: 99,
      coupling_ce: 0.99,
      churn_per_week: 50,
      test_coverage: 0.01,
    });

    const result = getHealthTrends(store, { module: 'src/mod' });
    expect(result.isOk()).toBe(true);
    const payload = result._unsafeUnwrap();
    expect(payload.target).toBe('src/mod');
    // Two src/mod rows share the same recorded_at → aggregated into one row.
    expect(payload.data_points).toHaveLength(1);
    // Averaged bug_score should be (0.4 + 0.6) / 2 = 0.5, not the 0.9 outlier.
    expect(payload.data_points[0].bug_score).toBeCloseTo(0.5);
  });

  it('limit caps the number of data points returned', () => {
    for (let i = 1; i <= 5; i++) {
      insertHealthRow(store, {
        file_path: 'src/widget.ts',
        recorded_at: `2026-0${i}-01T00:00:00Z`,
        bug_score: 0.1 * i,
        complexity_avg: i,
        coupling_ce: 0.1 * i,
        churn_per_week: i,
        test_coverage: 0.1 * i,
      });
    }
    const result = getHealthTrends(store, { filePath: 'src/widget.ts', limit: 2 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data_points).toHaveLength(2);
  });

  it('with neither file_path nor module returns a VALIDATION_ERROR', () => {
    const result = getHealthTrends(store, {});
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('empty pi_health_history returns ok with data_points: [] and stable trend', () => {
    const result = getHealthTrends(store, { filePath: 'src/never-recorded.ts' });
    expect(result.isOk()).toBe(true);
    const payload = result._unsafeUnwrap();
    expect(payload.data_points).toEqual([]);
    expect(payload.trend).toBe('stable');
  });
});
