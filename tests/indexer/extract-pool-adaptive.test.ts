import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExtractPool,
  isLowPowerMachine,
  resolveAdaptivePoolSize,
  resolveKeepAliveIdleMs,
  resolveWorkerThreshold,
} from '../../src/indexer/extract-pool.js';

const STRONG = { totalMemBytes: 16 * 1024 ** 3, cpuCount: 8 };
const WEAK_RAM = { totalMemBytes: 2 * 1024 ** 3, cpuCount: 8 };
const WEAK_CPU = { totalMemBytes: 16 * 1024 ** 3, cpuCount: 2 };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isLowPowerMachine (TRA-1537)', () => {
  it('strong machine is not low-power', () => {
    expect(isLowPowerMachine(STRONG)).toBe(false);
  });

  it('weak RAM (<4GB) is low-power', () => {
    expect(isLowPowerMachine(WEAK_RAM)).toBe(true);
  });

  it('weak CPU (≤2) is low-power', () => {
    expect(isLowPowerMachine(WEAK_CPU)).toBe(true);
  });

  it('TRACE_MCP_LOW_POWER=1 forces low-power on a strong host', () => {
    vi.stubEnv('TRACE_MCP_LOW_POWER', '1');
    expect(isLowPowerMachine(STRONG)).toBe(true);
  });

  it('TRACE_MCP_LOW_POWER=0 clears low-power on a weak host', () => {
    vi.stubEnv('TRACE_MCP_LOW_POWER', '0');
    expect(isLowPowerMachine(WEAK_RAM)).toBe(false);
  });
});

describe('resolveAdaptivePoolSize (TRA-1537)', () => {
  it('strong CLI keeps the static default (≤8)', () => {
    vi.stubEnv('TRACE_MCP_LOW_POWER', '0');
    const n = resolveAdaptivePoolSize(false, STRONG);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(8);
  });

  it('weak profile caps at 2 workers', () => {
    expect(resolveAdaptivePoolSize(false, WEAK_RAM)).toBeLessThanOrEqual(2);
    expect(resolveAdaptivePoolSize(true, WEAK_CPU)).toBeLessThanOrEqual(2);
    expect(resolveAdaptivePoolSize(false, WEAK_RAM)).toBeGreaterThanOrEqual(1);
  });

  it('TRACE_MCP_WORKERS overrides everything', () => {
    vi.stubEnv('TRACE_MCP_WORKERS', '3');
    expect(resolveAdaptivePoolSize(false, WEAK_RAM)).toBe(3);
    expect(resolveAdaptivePoolSize(false, STRONG)).toBe(3);
  });
});

describe('resolveWorkerThreshold (TRA-1537)', () => {
  it('defaults to 100 on strong machines', () => {
    expect(resolveWorkerThreshold(STRONG)).toBe(100);
  });

  it('rises to 200 on weak machines', () => {
    expect(resolveWorkerThreshold(WEAK_RAM)).toBe(200);
    expect(resolveWorkerThreshold(WEAK_CPU)).toBe(200);
  });

  it('TRACE_MCP_WORKER_THRESHOLD overrides', () => {
    vi.stubEnv('TRACE_MCP_WORKER_THRESHOLD', '50');
    expect(resolveWorkerThreshold(WEAK_RAM)).toBe(50);
  });
});

describe('resolveKeepAliveIdleMs (TRA-1537)', () => {
  it('weak daemon profile shortens the idle window', () => {
    expect(resolveKeepAliveIdleMs(true, WEAK_RAM)).toBe(10_000);
  });

  it('strong daemon profile keeps 45s', () => {
    expect(resolveKeepAliveIdleMs(true, STRONG)).toBe(45_000);
  });

  it('TRACE_MCP_KEEPALIVE_IDLE_MS overrides', () => {
    vi.stubEnv('TRACE_MCP_KEEPALIVE_IDLE_MS', '1234');
    expect(resolveKeepAliveIdleMs(true, STRONG)).toBe(1234);
  });
});

describe('ExtractPool honors adaptive sizing', () => {
  it('explicit size still wins', () => {
    const p = new ExtractPool({ size: 7 });
    expect(p.size).toBe(7);
  });

  it('construction spawns nothing (lazy lifecycle intact)', () => {
    const p = new ExtractPool({ keepAlive: true, size: 4 });
    expect((p as unknown as { workers: unknown[] }).workers).toHaveLength(0);
  });

  it('TRACE_MCP_WORKERS flows through the constructor', () => {
    vi.stubEnv('TRACE_MCP_WORKERS', '2');
    const p = new ExtractPool({});
    expect(p.size).toBe(2);
  });
});
