import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  formatErr,
  installProcessSafetyNet,
  isBrokenLogSink,
} from '../process-safety-net.js';

// Reliability hardening: without these handlers, Node 20+ terminates the server
// process on any unhandled rejection / uncaught exception, dropping the whole
// MCP session ("disconnects/crashes for everyone"). These tests pin the
// install behaviour and the error formatter.

describe('formatErr', () => {
  it('extracts message + stack from an Error', () => {
    const out = formatErr(new Error('boom'));
    expect(out).toMatchObject({ message: 'boom' });
    expect('stack' in out && out.stack).toBeTruthy();
  });

  it('stringifies non-Error values', () => {
    expect(formatErr('plain string')).toEqual({ value: 'plain string' });
    expect(formatErr(42)).toEqual({ value: '42' });
    expect(formatErr({ code: 'X' })).toEqual({ value: '[object Object]' });
  });
});

describe('installProcessSafetyNet', () => {
  const events = ['unhandledRejection', 'uncaughtException'] as const;
  let baseline: Record<string, number>;
  let added: Record<string, ((...a: unknown[]) => void)[]>;

  afterEach(() => {
    // Remove exactly the listeners we added so we don't leak into other tests.
    for (const ev of events) {
      for (const after of (process as NodeJS.EventEmitter).listeners(ev).slice(baseline[ev])) {
        process.off(ev, after as (...a: unknown[]) => void);
      }
    }
    __resetForTests();
  });

  it('registers one handler per fatal event', () => {
    baseline = Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
    added = {};
    installProcessSafetyNet('test');
    for (const ev of events) {
      expect(process.listenerCount(ev)).toBe(baseline[ev] + 1);
    }
  });

  it('is idempotent — a second call adds no extra handlers', () => {
    baseline = Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
    installProcessSafetyNet('test');
    installProcessSafetyNet('test');
    for (const ev of events) {
      expect(process.listenerCount(ev)).toBe(baseline[ev] + 1);
    }
  });

  it('keeps the process alive — emitting the event does not throw', () => {
    baseline = Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
    installProcessSafetyNet('test');
    // If no handler were registered (or it rethrew), this would crash the runner.
    expect(() =>
      process.emit('unhandledRejection', new Error('simulated'), Promise.resolve()),
    ).not.toThrow();
    expect(() => process.emit('uncaughtException', new Error('simulated'))).not.toThrow();
  });
});

describe('isBrokenLogSink', () => {
  it('recognises the codes that mean our own log sink is gone', () => {
    for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
      expect(isBrokenLogSink(Object.assign(new Error('write failed'), { code }))).toBe(true);
    }
  });

  it('leaves ordinary errors to the safety net', () => {
    expect(isBrokenLogSink(new Error('boom'))).toBe(false);
    expect(isBrokenLogSink(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe(false);
    expect(isBrokenLogSink(undefined)).toBe(false);
  });
});

describe('a dead log sink ends the process instead of spinning it', () => {
  // Regression guard for TRA-921. When the parent that owned our stdout/stderr
  // pipe exits without killing us, every write throws EPIPE — and logging the
  // EPIPE writes to the same dead pipe, re-entering this handler forever. A
  // leaked `serve-http` was measured burning 356 CPU-minutes over 5h56m with
  // zero clients that way. The only correct move is to leave.
  const events = ['unhandledRejection', 'uncaughtException'] as const;
  let baseline: Record<string, number>;

  afterEach(() => {
    for (const ev of events) {
      for (const after of (process as NodeJS.EventEmitter).listeners(ev).slice(baseline[ev])) {
        process.off(ev, after as (...a: unknown[]) => void);
      }
    }
    __resetForTests();
    vi.restoreAllMocks();
  });

  it('exits on an EPIPE uncaught exception', () => {
    baseline = Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installProcessSafetyNet('test');

    process.emit('uncaughtException', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does not exit on an ordinary uncaught exception', () => {
    baseline = Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installProcessSafetyNet('test');

    process.emit('uncaughtException', new Error('ordinary'));

    expect(exit).not.toHaveBeenCalled();
  });
});
