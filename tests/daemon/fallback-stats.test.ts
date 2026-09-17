import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readSessionFallbacks,
  recordSessionFallback,
  summarizeSessionFallbacks,
} from '../../src/daemon/router/fallback-stats.js';
import { renderSessionFallbacks } from '../../src/cli/daemon-stats.js';

/**
 * Cross-process fallback-rate counter (TRA-1605, PROC-1).
 *
 * Each stdio session appends one JSONL line when it demotes itself to local
 * mode; `daemon stats` aggregates the shared file locally so a storm is
 * visible even while the daemon is down.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-fallbacks-'));
  file = path.join(dir, 'session-fallbacks.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recordSessionFallback / readSessionFallbacks', () => {
  it('round-trips events with reason + pid', () => {
    recordSessionFallback('proxy-initialize-timeout', file);
    recordSessionFallback('daemon-disappeared', file);
    const events = readSessionFallbacks(file);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ reason: 'proxy-initialize-timeout', pid: process.pid });
    expect(events[1]).toMatchObject({ reason: 'daemon-disappeared' });
    expect(typeof events[0].ts).toBe('number');
  });

  it('reads nothing from a missing file (fresh machine)', () => {
    expect(readSessionFallbacks(path.join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('skips malformed lines instead of failing', () => {
    fs.writeFileSync(
      file,
      'not json\n{"ts":"bad","reason":1}\n{"ts":123,"reason":"proxy-send-failed","pid":7}\n',
    );
    const events = readSessionFallbacks(file);
    expect(events).toEqual([{ ts: 123, reason: 'proxy-send-failed', pid: 7 }]);
  });

  it('never throws, even on an unwritable path', () => {
    expect(() =>
      recordSessionFallback('proxy-initialize-timeout', path.join(dir, 'no-such-dir', 'f.jsonl')),
    ).not.toThrow();
  });

  it('prunes oldest lines past the cap', () => {
    for (let i = 0; i < 5_050; i++) {
      recordSessionFallback(`reason-${i % 3}`, file);
    }
    const events = readSessionFallbacks(file);
    expect(events.length).toBeLessThanOrEqual(5_000);
    expect(events.length).toBeGreaterThan(4_900);
    // Newest entries survive the prune.
    expect(events[events.length - 1].reason).toBe(`reason-${5049 % 3}`);
  });
});

describe('summarizeSessionFallbacks', () => {
  it('counts by reason with a per-minute storm gauge', () => {
    const now = Date.now();
    const events = [
      { ts: now - 1_000, reason: 'proxy-initialize-timeout', pid: 1 },
      { ts: now - 2_000, reason: 'proxy-initialize-timeout', pid: 2 },
      { ts: now - 3_000, reason: 'daemon-disappeared', pid: 3 },
    ];
    const s = summarizeSessionFallbacks(events, { sinceMs: 60_000, nowMs: now });
    expect(s.total).toBe(3);
    expect(s.byReason).toEqual({ 'proxy-initialize-timeout': 2, 'daemon-disappeared': 1 });
    expect(s.perMin).toBeCloseTo(3, 5);
  });

  it('filters outside the window', () => {
    const now = Date.now();
    const events = [
      { ts: now - 2 * 3_600_000, reason: 'proxy-initialize-timeout', pid: 1 },
      { ts: now, reason: 'proxy-initialize-timeout', pid: 2 },
    ];
    expect(summarizeSessionFallbacks(events, { sinceMs: 3_600_000, nowMs: now }).total).toBe(1);
    expect(summarizeSessionFallbacks(events, { nowMs: now }).total).toBe(2);
  });
});

describe('renderSessionFallbacks', () => {
  it('renders the storm gauge', () => {
    const text = renderSessionFallbacks(
      {
        total: 8,
        byReason: { 'proxy-initialize-timeout': 8 },
        perMin: 2,
        windowMs: 240_000,
      },
      '24h',
    );
    expect(text).toContain('total: 8 (2.00/min)');
    expect(text).toContain('"proxy-initialize-timeout": 8');
  });

  it('renders the calm state without alarming', () => {
    expect(
      renderSessionFallbacks({ total: 0, byReason: {}, perMin: 0, windowMs: 1 }, '24h'),
    ).toContain('(no local-mode fallbacks recorded in this window)');
    expect(renderSessionFallbacks(null, '24h')).toContain(
      '(no local-mode fallbacks recorded in this window)',
    );
  });
});
