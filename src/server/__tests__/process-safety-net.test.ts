import { afterEach, describe, expect, it } from 'vitest';
import { __resetForTests, formatErr, installProcessSafetyNet } from '../process-safety-net.js';

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
      for (const after of process.listeners(ev).slice(baseline[ev])) {
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
