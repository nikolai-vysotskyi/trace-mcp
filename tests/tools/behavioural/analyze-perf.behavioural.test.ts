/**
 * Behavioural coverage for the `analyze_perf` MCP tool.
 *
 * IMPL NOTE: `analyze_perf` is inline-registered in
 * `src/tools/register/session.ts`. For `window: 'session'` it reads from
 * `SavingsTracker.getLatencyPerTool()` (the in-memory ring). For
 * `window: '1h'|'24h'|'7d'|'all'` it reads from the persistent
 * `TelemetrySink` (better-sqlite3). We assert both underlying contracts
 * (same approach as `get-session-stats.behavioural.test.ts`).
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SavingsTracker } from '../../../src/savings.js';
import { TelemetrySink } from '../../../src/runtime/telemetry-sink.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

const PROJECT = '/projects/analyze-perf-fixture';

describe('analyze_perf — session ring (SavingsTracker.getLatencyPerTool)', () => {
  it('returns per-tool p50/p95/max/count/error_rate after seeded latency samples', () => {
    const s = new SavingsTracker(PROJECT);
    s.recordLatency('search', 10, false);
    s.recordLatency('search', 20, false);
    s.recordLatency('search', 30, false);
    s.recordLatency('search', 40, false);
    s.recordLatency('get_symbol', 5, false);
    s.recordLatency('get_symbol', 100, true); // error

    const all = s.getLatencyPerTool();
    const tools = Object.entries(all).map(([tool, stats]) => ({ tool, ...stats }));
    expect(tools.length).toBe(2);

    const search = tools.find((t) => t.tool === 'search')!;
    expect(search.count).toBe(4);
    expect(search.max).toBe(40);
    expect(search.p50).toBeGreaterThanOrEqual(10);
    expect(search.p50).toBeLessThanOrEqual(40);
    expect(search.p95).toBeGreaterThanOrEqual(search.p50);
    expect(search.errors).toBe(0);
    expect(search.error_rate).toBe(0);

    const sym = tools.find((t) => t.tool === 'get_symbol')!;
    expect(sym.count).toBe(2);
    expect(sym.errors).toBe(1);
    expect(sym.error_rate).toBeCloseTo(0.5, 5);
  });

  it('empty session ring returns an empty record (zero tools)', () => {
    const s = new SavingsTracker(PROJECT);
    const all = s.getLatencyPerTool();
    expect(all).toEqual({});
  });

  it('output shape: every per-tool entry has p50, p95, max, count, errors, error_rate', () => {
    const s = new SavingsTracker(PROJECT);
    s.recordLatency('get_outline', 7, false);
    const all = s.getLatencyPerTool();
    const rec = all['get_outline'];
    expect(rec).toBeDefined();
    expect(typeof rec!.p50).toBe('number');
    expect(typeof rec!.p95).toBe('number');
    expect(typeof rec!.max).toBe('number');
    expect(typeof rec!.count).toBe('number');
    expect(typeof rec!.errors).toBe('number');
    expect(typeof rec!.error_rate).toBe('number');
  });
});

describe('analyze_perf — persistent sink (TelemetrySink.getStats)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir('analyze-perf-');
    dbPath = path.join(tmpDir, 'telemetry.db');
  });
  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('window read returns aggregated tool stats sorted by p95 desc (TelemetrySink shape)', () => {
    const sink = new TelemetrySink({ dbPath });
    const now = Date.now();
    // Slow tool — high p95.
    for (let i = 0; i < 10; i += 1) sink.recordCall('reindex', 100 + i * 10, false, now);
    // Fast tool — low p95.
    for (let i = 0; i < 10; i += 1) sink.recordCall('search', 1 + i, false, now);

    const stats = sink.getStats('all');
    expect(stats.length).toBe(2);
    // Sorted by p95 descending: reindex must come first.
    expect(stats[0].tool).toBe('reindex');
    expect(stats[1].tool).toBe('search');
    for (const s of stats) {
      expect(typeof s.tool).toBe('string');
      expect(typeof s.count).toBe('number');
      expect(typeof s.errors).toBe('number');
      expect(typeof s.error_rate).toBe('number');
      expect(typeof s.p50).toBe('number');
      expect(typeof s.p95).toBe('number');
      expect(typeof s.max).toBe('number');
    }
    sink.close();
  });

  it('tool filter narrows results to the requested name only', () => {
    const sink = new TelemetrySink({ dbPath });
    const now = Date.now();
    sink.recordCall('search', 5, false, now);
    sink.recordCall('get_symbol', 7, false, now);

    const stats = sink.getStats('all', 'search');
    expect(stats.length).toBe(1);
    expect(stats[0].tool).toBe('search');
    sink.close();
  });

  it('empty telemetry DB returns an empty stats array', () => {
    const sink = new TelemetrySink({ dbPath });
    const stats = sink.getStats('all');
    expect(stats).toEqual([]);
    sink.close();
  });
});
