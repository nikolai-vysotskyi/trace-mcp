import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _isStdoutGuardArmedForTest,
  armStdoutGuard,
  disarmStdoutGuard,
  forceUtf8Stdio,
  hardenStdio,
} from '../../src/server/transport-hardening.js';

describe('transport-hardening', () => {
  afterEach(() => {
    // Restore real stdout regardless of what the test did.
    disarmStdoutGuard();
    vi.restoreAllMocks();
  });

  it('forceUtf8Stdio does not throw on this platform', () => {
    expect(() => forceUtf8Stdio()).not.toThrow();
  });

  it('armStdoutGuard is idempotent', () => {
    armStdoutGuard();
    expect(_isStdoutGuardArmedForTest()).toBe(true);
    armStdoutGuard(); // second call is a no-op
    expect(_isStdoutGuardArmedForTest()).toBe(true);
    disarmStdoutGuard();
  });

  it('disarmStdoutGuard is safe to call when not armed', () => {
    expect(_isStdoutGuardArmedForTest()).toBe(false);
    expect(() => disarmStdoutGuard()).not.toThrow();
  });

  it('routes stdout.write to stderr while armed', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    armStdoutGuard();
    process.stdout.write('hello stdout\n');
    expect(stderrSpy).toHaveBeenCalled();
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('hello stdout'))).toBe(true);
    disarmStdoutGuard();
  });

  it('restores native stdout.write after disarm', () => {
    const beforeArm = process.stdout.write;
    armStdoutGuard();
    expect(process.stdout.write).not.toBe(beforeArm);
    disarmStdoutGuard();
    expect(process.stdout.write).toBe(beforeArm);
  });

  it('hardenStdio installs UTF-8 + stdout guard in one call', () => {
    expect(_isStdoutGuardArmedForTest()).toBe(false);
    hardenStdio();
    expect(_isStdoutGuardArmedForTest()).toBe(true);
    disarmStdoutGuard();
  });
});
