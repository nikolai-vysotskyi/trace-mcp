import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  formatErr,
  installProcessSafetyNet,
  isBrokenPipe,
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

describe('isBrokenPipe', () => {
  it('recognises the codes that mean the pipe reader is gone', () => {
    for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
      expect(isBrokenPipe(Object.assign(new Error('write failed'), { code }))).toBe(true);
    }
  });

  it('leaves every other write failure to be swallowed', () => {
    expect(isBrokenPipe(new Error('boom'))).toBe(false);
    expect(isBrokenPipe(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))).toBe(false);
    expect(isBrokenPipe(undefined)).toBe(false);
  });
});

describe('a dead log sink ends the process instead of spinning it', () => {
  // Regression guard for TRA-921. When the parent that owned our stdout/stderr
  // pipe exits without killing us, every write fails with EPIPE — emitted as an
  // `error` event on the stream. Unlistened, that becomes an uncaught exception,
  // and the safety net answers an uncaught exception by logging, to the same
  // dead pipe, forever. A leaked `serve-http` was measured burning 356
  // CPU-minutes over 5h56m with zero clients that way.
  //
  // The decision has to stay pinned to the stream that raised the error: the
  // same EPIPE code from an HTTP response or any other socket must NOT take a
  // healthy daemon down. Both branches are asserted below.
  const events = ['unhandledRejection', 'uncaughtException'] as const;
  let baseline: Record<string, number>;
  let stdoutBaseline: number;
  let stderrBaseline: number;

  beforeEach(() => {
    baseline = Object.fromEntries(events.map((e) => [e, process.listenerCount(e)]));
    stdoutBaseline = process.stdout.listenerCount('error');
    stderrBaseline = process.stderr.listenerCount('error');
  });

  afterEach(() => {
    for (const ev of events) {
      for (const after of (process as NodeJS.EventEmitter).listeners(ev).slice(baseline[ev])) {
        process.off(ev, after as (...a: unknown[]) => void);
      }
    }
    for (const stream of [process.stdout, process.stderr] as const) {
      const keep = stream === process.stdout ? stdoutBaseline : stderrBaseline;
      for (const after of stream.listeners('error').slice(keep)) {
        stream.off('error', after as (...a: unknown[]) => void);
      }
    }
    __resetForTests();
    vi.restoreAllMocks();
  });

  const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

  it('exits when stderr itself reports a broken pipe', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installProcessSafetyNet('test');

    process.stderr.emit('error', epipe());

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits when stdout itself reports a broken pipe', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installProcessSafetyNet('test');

    process.stdout.emit('error', epipe());

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does NOT exit on the same code from an unrelated stream', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installProcessSafetyNet('test');

    // An HTTP response, a client socket, any other stream in the process: its
    // EPIPE surfaces as an uncaught exception and must stay survivable.
    process.emit('uncaughtException', epipe());

    expect(exit).not.toHaveBeenCalled();
  });

  it('swallows a non-pipe write failure on stderr without exiting', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installProcessSafetyNet('test');

    expect(() =>
      process.stderr.emit('error', Object.assign(new Error('no space'), { code: 'ENOSPC' })),
    ).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });
});
