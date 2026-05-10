import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the daemon client so we can control health responses without a real HTTP server.
vi.mock('../../src/daemon/client.js', () => {
  return {
    isDaemonRunning: vi.fn(async () => false),
    getDaemonHealth: vi.fn(async () => null),
  };
});

import * as daemonClient from '../../src/daemon/client.js';
import {
  captureProcessStartToken,
  tryAutoSpawnDaemon,
  verifyPidFileOwnership,
  waitForDaemonUp,
} from '../../src/daemon/lifecycle.js';

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

describe('captureProcessStartToken', () => {
  it('returns a non-empty token for the current process on POSIX', () => {
    if (process.platform === 'win32') return;
    const token = captureProcessStartToken(process.pid);
    expect(token).not.toBeNull();
    expect(typeof token).toBe('string');
    expect((token as string).length).toBeGreaterThan(0);
  });

  it('returns null for a clearly invalid PID', () => {
    expect(captureProcessStartToken(0)).toBeNull();
    expect(captureProcessStartToken(-1)).toBeNull();
    expect(captureProcessStartToken(Number.NaN)).toBeNull();
  });

  it('returns null on Windows (PID-reuse scenario does not apply)', () => {
    if (process.platform !== 'win32') return;
    expect(captureProcessStartToken(process.pid)).toBeNull();
  });

  it('returns null for a PID that does not exist', () => {
    if (process.platform === 'win32') return;
    // Use a high PID that's extremely unlikely to be in use.
    const result = captureProcessStartToken(999_999_999);
    expect(result).toBeNull();
  });

  it('produces stable tokens across two calls for the same PID', () => {
    if (process.platform === 'win32') return;
    const a = captureProcessStartToken(process.pid);
    const b = captureProcessStartToken(process.pid);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
});

describe('verifyPidFileOwnership', () => {
  it('rejects unparseable content', () => {
    expect(verifyPidFileOwnership('not a pid').ok).toBe(false);
    expect(verifyPidFileOwnership('not a pid').reason).toBe('unparseable');
    expect(verifyPidFileOwnership('').ok).toBe(false);
  });

  it('accepts a token-less file when the PID is alive (backwards compat)', () => {
    const v = verifyPidFileOwnership(`${process.pid}`);
    expect(v.ok).toBe(true);
    expect(v.pid).toBe(process.pid);
  });

  it('accepts a tokened file when the token still matches', () => {
    if (process.platform === 'win32') return;
    const token = captureProcessStartToken(process.pid);
    if (token === null) return; // Couldn't capture — skip.
    const v = verifyPidFileOwnership(`${process.pid}\n${token}\n`);
    expect(v.ok).toBe(true);
    expect(v.pid).toBe(process.pid);
  });

  it('rejects a tokened file when the recorded token mismatches (PID-reuse)', () => {
    if (process.platform === 'win32') return;
    const real = captureProcessStartToken(process.pid);
    if (real === null) return;
    const fakeToken = `${real}-stale-suffix`;
    const v = verifyPidFileOwnership(`${process.pid}\n${fakeToken}\n`);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('pid-reused');
    expect(v.pid).toBe(process.pid);
  });

  it('rejects a file whose PID is dead', () => {
    if (process.platform === 'win32') return;
    const v = verifyPidFileOwnership('999999999');
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('dead');
  });

  it('handles trailing whitespace and empty token line gracefully', () => {
    const v = verifyPidFileOwnership(`${process.pid}\n   \n`);
    expect(v.ok).toBe(true);
  });
});

/**
 * Regression: the daemon PID file and the daemon spawn lock are state files
 * shared between concurrent processes. They MUST be written via the atomic
 * helper (open/fsync/rename), not plain fs.writeFileSync — otherwise a crash
 * mid-write leaves a half-written file that defeats the PID-reuse guard, and
 * the spawn-lock stale-recovery branch becomes a TOCTOU race where two
 * processes can both believe they hold the lock.
 */
describe('lifecycle.ts atomic-write invariants', () => {
  const SRC = path.resolve(__dirname, '..', '..', 'src', 'daemon', 'lifecycle.ts');
  const source = fs.readFileSync(SRC, 'utf-8');

  it('writePidFile writes via atomicWriteString', () => {
    const m = source.match(/function writePidFile[\s\S]*?\n}/);
    expect(m, 'writePidFile body not found').not.toBeNull();
    const body = m?.[0] ?? '';
    expect(body).toContain('atomicWriteString');
    expect(body).not.toContain('fs.writeFileSync');
  });

  it('acquireSpawnLock recovery branch never falls back to fs.writeFileSync', () => {
    const m = source.match(/function acquireSpawnLock[\s\S]*?\n}/);
    expect(m, 'acquireSpawnLock body not found').not.toBeNull();
    const body = m?.[0] ?? '';
    // The recovery path must take over the lock by unlinking + atomically
    // recreating with O_EXCL ('wx'), not by overwriting in place.
    expect(body).not.toContain('fs.writeFileSync');
    expect(body).toContain("'wx'");
    expect(body).toContain('unlinkSync');
  });
});
