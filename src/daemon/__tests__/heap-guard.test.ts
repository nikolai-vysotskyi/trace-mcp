/**
 * Heap-pressure guard (TRA-2056).
 *
 * The 2026-09-28 daemon died by V8 OOM with no JS handler running — the only
 * mitigation is acting before the ceiling. These pin the threshold math and
 * the warn-once / restart-once guard behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateHeapPressure,
  resolveHeapThresholds,
  startHeapGuard,
  tryCollectGarbage,
} from '../heap-guard.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import('../../logger.js');

describe('evaluateHeapPressure', () => {
  const thresholds = { warnMb: 3000, restartMb: 3500 };
  it('is ok below warn', () => {
    expect(evaluateHeapPressure(2999, thresholds)).toBe('ok');
  });
  it('warns at warn', () => {
    expect(evaluateHeapPressure(3000, thresholds)).toBe('warn');
    expect(evaluateHeapPressure(3499, thresholds)).toBe('warn');
  });
  it('restarts at restart', () => {
    expect(evaluateHeapPressure(3500, thresholds)).toBe('restart');
    expect(evaluateHeapPressure(3934, thresholds)).toBe('restart');
  });
});

describe('resolveHeapThresholds', () => {
  it('derives fractions of the V8 ceiling by default', () => {
    const { thresholds, enabled } = resolveHeapThresholds({});
    expect(enabled).toBe(true);
    expect(thresholds.restartMb).toBeGreaterThan(thresholds.warnMb);
  });
  it('honours absolute overrides and keeps restart above warn', () => {
    const { thresholds } = resolveHeapThresholds({
      TRACE_MCP_HEAP_WARN_MB: '100',
      TRACE_MCP_HEAP_RESTART_MB: '50',
    });
    expect(thresholds.warnMb).toBe(100);
    expect(thresholds.restartMb).toBeGreaterThan(100);
  });
  it('disables with TRACE_MCP_HEAP_GUARD=0', () => {
    expect(resolveHeapThresholds({ TRACE_MCP_HEAP_GUARD: '0' }).enabled).toBe(false);
  });
});

describe('startHeapGuard', () => {
  it('warns once per episode and restarts once', async () => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    let heap = 100;
    const onRestart = vi.fn();
    const stop = startHeapGuard({
      thresholds: { warnMb: 3000, restartMb: 3500 },
      intervalMs: 5,
      readHeap: () => ({ usedMb: heap, totalMb: heap + 100, limitMb: 4096 }),
      onRestart,
    });
    try {
      heap = 3100;
      await new Promise((r) => setTimeout(r, 25));
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(onRestart).not.toHaveBeenCalled();
      heap = 100;
      await new Promise((r) => setTimeout(r, 15));
      heap = 3100;
      await new Promise((r) => setTimeout(r, 15));
      // New episode after recovery warns again.
      expect(vi.mocked(logger.warn).mock.calls.length).toBeGreaterThanOrEqual(2);
      heap = 3934;
      await new Promise((r) => setTimeout(r, 25));
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(onRestart).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 15));
      // Restart fires once even while pressure persists.
      expect(onRestart).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('tryCollectGarbage successfully triggers GC in Node environment', () => {
    const success = tryCollectGarbage();
    expect(typeof success).toBe('boolean');
    expect(success).toBe(true);
  });

  it('recovers from restart pressure when GC drops heap below restart threshold (TRA-2682)', async () => {
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    let heap = 3600;
    const onRestart = vi.fn();
    const collectGarbage = vi.fn(() => {
      // Simulate GC reclaiming transient AST / walk memory
      heap = 2400;
      return true;
    });

    const stop = startHeapGuard({
      thresholds: { warnMb: 3000, restartMb: 3500 },
      intervalMs: 5,
      readHeap: () => ({ usedMb: heap, totalMb: 3800, limitMb: 4096 }),
      collectGarbage,
      onRestart,
    });

    try {
      await new Promise((r) => setTimeout(r, 25));
      expect(collectGarbage).toHaveBeenCalled();
      expect(onRestart).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('relieved by garbage collection'),
      );
    } finally {
      stop();
    }
  });

  it('proceeds with restart if heap remains above threshold after GC (TRA-2682)', async () => {
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    let heap = 3600;
    const onRestart = vi.fn();
    const collectGarbage = vi.fn(() => {
      // Memory is truly pinned; GC cannot reclaim enough
      heap = 3550;
      return true;
    });

    const stop = startHeapGuard({
      thresholds: { warnMb: 3000, restartMb: 3500 },
      intervalMs: 5,
      readHeap: () => ({ usedMb: heap, totalMb: 3800, limitMb: 4096 }),
      collectGarbage,
      onRestart,
    });

    try {
      await new Promise((r) => setTimeout(r, 25));
      expect(collectGarbage).toHaveBeenCalled();
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('requesting graceful restart'),
      );
    } finally {
      stop();
    }
  });

  it('opportunistically invokes GC on entering warn pressure episode (TRA-2682)', async () => {
    vi.mocked(logger.warn).mockClear();
    let heap = 100;
    const onRestart = vi.fn();
    const collectGarbage = vi.fn(() => true);

    const stop = startHeapGuard({
      thresholds: { warnMb: 3000, restartMb: 3500 },
      intervalMs: 5,
      readHeap: () => ({ usedMb: heap, totalMb: 3800, limitMb: 4096 }),
      collectGarbage,
      onRestart,
    });

    try {
      heap = 3100;
      await new Promise((r) => setTimeout(r, 25));
      expect(collectGarbage).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(onRestart).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
