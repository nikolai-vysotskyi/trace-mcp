import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHandshakeWatchdog,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  handshakeDiagnosticLine,
  resolveHandshakeTimeout,
} from '../../src/daemon/router/handshake-watchdog.js';

describe('resolveHandshakeTimeout', () => {
  it('prefers explicit option value over env', () => {
    expect(resolveHandshakeTimeout(1234, '9999')).toBe(1234);
  });

  it('falls back to env when option is undefined', () => {
    expect(resolveHandshakeTimeout(undefined, '7000')).toBe(7000);
  });

  it('falls back to default when neither is provided', () => {
    expect(resolveHandshakeTimeout(undefined, undefined)).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
  });

  it('rejects negative option values', () => {
    // Negative falls through to env / default
    expect(resolveHandshakeTimeout(-1, '3000')).toBe(3000);
  });

  it('accepts 0 to disable explicitly', () => {
    expect(resolveHandshakeTimeout(0, '5000')).toBe(0);
  });

  it('rejects garbage env values', () => {
    expect(resolveHandshakeTimeout(undefined, 'abc')).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
    expect(resolveHandshakeTimeout(undefined, '')).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
    expect(resolveHandshakeTimeout(undefined, '-5')).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
    expect(resolveHandshakeTimeout(undefined, '5.5')).toBe(DEFAULT_HANDSHAKE_TIMEOUT_MS);
  });

  it('floors fractional option values', () => {
    expect(resolveHandshakeTimeout(2500.7, undefined)).toBe(2500);
  });
});

describe('handshakeDiagnosticLine', () => {
  it('includes the elapsed timeout in the message', () => {
    expect(handshakeDiagnosticLine(2500)).toContain('2500ms');
    expect(handshakeDiagnosticLine(15000)).toContain('15000ms');
  });

  it('mentions the escape hatches users actually need', () => {
    const line = handshakeDiagnosticLine(5000);
    expect(line).toContain('UV_NO_PROGRESS');
    expect(line).toContain('NPM_CONFIG_PROGRESS');
    expect(line).toContain('TRACE_MCP_HANDSHAKE_TIMEOUT');
  });

  it('starts with a [trace-mcp] tag for log scraping', () => {
    expect(handshakeDiagnosticLine(5000).startsWith('[trace-mcp]')).toBe(true);
  });
});

describe('createHandshakeWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire when timeoutMs <= 0', () => {
    const writes: string[] = [];
    const wd = createHandshakeWatchdog({
      timeoutMs: 0,
      write: (l) => writes.push(l),
    });
    vi.advanceTimersByTime(60_000);
    expect(writes).toHaveLength(0);
    // observe()/cancel() are no-op safe when disabled
    expect(() => wd.observe()).not.toThrow();
    expect(() => wd.cancel()).not.toThrow();
  });

  it('fires the diagnostic exactly once after the budget elapses', () => {
    const writes: string[] = [];
    createHandshakeWatchdog({ timeoutMs: 1000, write: (l) => writes.push(l) });

    vi.advanceTimersByTime(999);
    expect(writes).toHaveLength(0);

    vi.advanceTimersByTime(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('1000ms');

    // Subsequent ticks must not double-fire
    vi.advanceTimersByTime(60_000);
    expect(writes).toHaveLength(1);
  });

  it('observe() before timeout suppresses the diagnostic', () => {
    const writes: string[] = [];
    const wd = createHandshakeWatchdog({ timeoutMs: 1000, write: (l) => writes.push(l) });

    vi.advanceTimersByTime(500);
    wd.observe();
    vi.advanceTimersByTime(60_000);

    expect(writes).toHaveLength(0);
  });

  it('cancel() before timeout suppresses the diagnostic', () => {
    const writes: string[] = [];
    const wd = createHandshakeWatchdog({ timeoutMs: 1000, write: (l) => writes.push(l) });

    wd.cancel();
    vi.advanceTimersByTime(60_000);

    expect(writes).toHaveLength(0);
  });

  it('multiple observe() calls are idempotent', () => {
    const writes: string[] = [];
    const wd = createHandshakeWatchdog({ timeoutMs: 1000, write: (l) => writes.push(l) });

    wd.observe();
    wd.observe();
    wd.observe();
    vi.advanceTimersByTime(60_000);

    expect(writes).toHaveLength(0);
  });

  it('observe() after fire is harmless (does not re-fire)', () => {
    const writes: string[] = [];
    const wd = createHandshakeWatchdog({ timeoutMs: 100, write: (l) => writes.push(l) });

    vi.advanceTimersByTime(150);
    expect(writes).toHaveLength(1);

    wd.observe(); // late observe — should not crash, should not fire again
    vi.advanceTimersByTime(60_000);

    expect(writes).toHaveLength(1);
  });

  it('swallows errors from the write sink so JSON-RPC stays clean', () => {
    const wd = createHandshakeWatchdog({
      timeoutMs: 100,
      write: () => {
        throw new Error('stderr write failed');
      },
    });

    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    // Cancellation paths still work after a failed fire
    expect(() => wd.cancel()).not.toThrow();
  });
});
