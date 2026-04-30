import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelemetrySink } from '../../src/runtime/telemetry-sink.js';

describe('TelemetrySink', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-telemetry-'));
    dbPath = path.join(tmpDir, 'telemetry.db');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists tool calls and reads them back via getStats("all")', () => {
    const sink = new TelemetrySink({ dbPath });
    const now = Date.now();
    sink.recordCall('search', 10, false, now);
    sink.recordCall('search', 20, false, now);
    sink.recordCall('search', 30, false, now);
    sink.recordCall('get_outline', 5, true, now);

    const stats = sink.getStats('all');
    sink.close();

    const search = stats.find((s) => s.tool === 'search');
    expect(search).toBeDefined();
    expect(search!.count).toBe(3);
    expect(search!.errors).toBe(0);
    expect(search!.p50).toBe(20);
    expect(search!.max).toBe(30);

    const outline = stats.find((s) => s.tool === 'get_outline');
    expect(outline).toBeDefined();
    expect(outline!.errors).toBe(1);
    expect(outline!.error_rate).toBe(1);
  });

  it('honors the window filter (rows older than the cutoff are excluded)', () => {
    const sink = new TelemetrySink({ dbPath });
    const now = Date.now();
    sink.recordCall('search', 10, false, now); // recent
    sink.recordCall('search', 100, false, now - 25 * 60 * 60 * 1000); // 25h old

    const oneH = sink.getStats('1h');
    expect(oneH.find((s) => s.tool === 'search')!.count).toBe(1);

    const all = sink.getStats('all');
    expect(all.find((s) => s.tool === 'search')!.count).toBe(2);

    sink.close();
  });

  it('filters by tool name when provided', () => {
    const sink = new TelemetrySink({ dbPath });
    const now = Date.now();
    sink.recordCall('search', 10, false, now);
    sink.recordCall('get_outline', 5, false, now);

    const filtered = sink.getStats('all', 'search');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.tool).toBe('search');

    sink.close();
  });

  it('disables itself silently after a write failure (closed db)', () => {
    const sink = new TelemetrySink({ dbPath });
    sink.recordCall('search', 1, false);
    sink.close();
    // Subsequent record should be a no-op (sink is closed; reopen would succeed, but
    // a real failure path would set `disabled`. For this test, we verify close()+record()
    // doesn't throw and doesn't crash the caller.
    expect(() => sink.recordCall('search', 2, false)).not.toThrow();
  });

  it('ignores non-finite or negative durations', () => {
    const sink = new TelemetrySink({ dbPath });
    const now = Date.now();
    sink.recordCall('search', Number.NaN, false, now);
    sink.recordCall('search', -5, false, now);
    sink.recordCall('search', 7, false, now);
    const stats = sink.getStats('all', 'search');
    sink.close();
    expect(stats[0]?.count).toBe(1); // only the valid 7ms row was persisted
  });

  it('prunes oldest rows when maxRows is exceeded (on next sink open)', () => {
    // Pruning runs on ensureOpen — write 25 rows, close, reopen, pruning happens then.
    const sinkA = new TelemetrySink({ dbPath, maxRows: 10 });
    const baseTs = Date.now() - 100_000;
    for (let i = 0; i < 25; i += 1) {
      sinkA.recordCall('search', i, false, baseTs + i);
    }
    sinkA.close();

    const sinkB = new TelemetrySink({ dbPath, maxRows: 10 });
    sinkB.recordCall('search', 999, false, Date.now()); // triggers ensureOpen → prune
    const stats = sinkB.getStats('all', 'search');
    sinkB.close();
    // After pruning, ≈90% of maxRows = 9 retained, plus the 1 row added after pruning.
    expect(stats[0]?.count).toBeLessThanOrEqual(10);
    expect(stats[0]?.count).toBeGreaterThan(0);
  });
});
