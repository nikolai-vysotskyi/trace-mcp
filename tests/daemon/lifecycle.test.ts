import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the daemon client so we can control health responses without a real HTTP server.
vi.mock('../../src/daemon/client.js', () => {
  return {
    isDaemonRunning: vi.fn(async () => false),
    getDaemonHealth: vi.fn(async () => null),
  };
});

import * as daemonClient from '../../src/daemon/client.js';
import { waitForDaemonUp, tryAutoSpawnDaemon } from '../../src/daemon/lifecycle.js';

const mockIsRunning = vi.mocked(daemonClient.isDaemonRunning);
const mockGetHealth = vi.mocked(daemonClient.getDaemonHealth);

describe('waitForDaemonUp', () => {
  beforeEach(() => {
    mockIsRunning.mockReset();
    mockGetHealth.mockReset();
  });

  it('resolves true as soon as /health responds', async () => {
    let calls = 0;
    mockIsRunning.mockImplementation(async () => {
      calls++;
      return calls >= 2;
    });
    const up = await waitForDaemonUp(1234, 1_000, 10);
    expect(up).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('returns false after timeoutMs if /health never responds', async () => {
    mockIsRunning.mockResolvedValue(false);
    const start = Date.now();
    const up = await waitForDaemonUp(1234, 100, 20);
    const elapsed = Date.now() - start;
    expect(up).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('tolerates isDaemonRunning rejections', async () => {
    mockIsRunning.mockRejectedValue(new Error('network'));
    const up = await waitForDaemonUp(1234, 60, 20);
    expect(up).toBe(false);
  });
});

describe('tryAutoSpawnDaemon', () => {
  beforeEach(() => {
    mockIsRunning.mockReset();
    mockGetHealth.mockReset();
  });

  it('returns alreadyRunning=true when daemon is already up (fast path)', async () => {
    mockIsRunning.mockResolvedValue(true);
    mockGetHealth.mockResolvedValue({ status: 'ok', transport: 'http' });
    const result = await tryAutoSpawnDaemon(1234, 500);
    expect(result.ok).toBe(true);
    expect(result.alreadyRunning).toBe(true);
  });

  // Spawning a real daemon is out of scope — these tests would launch a
  // real child process. Happy-path spawning is covered by the manual
  // integration tests in the plan.
});
