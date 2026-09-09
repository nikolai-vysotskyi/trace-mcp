/**
 * TRA-1091. `trace savings`, `trace doctor`, `GET /api/savings` and the desktop
 * app all print `buildSavingsReport()`. These are the properties that make that
 * figure showable to a user, and each one is a way the previous figure was
 * wrong: it came from `calls x constant`, it carried a store written before the
 * correction, and it would have shown a confident zero on an install with four
 * calls in it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSavingsReport,
  formatSavingsReport,
  MIN_MEASURED_CALLS,
} from '../../src/savings-report.js';
import { emptyMeasured, type PersistentSavings } from '../../src/savings.js';

function store(over: Partial<PersistentSavings> = {}): PersistentSavings {
  return {
    version: 1,
    total_tokens_saved: 0,
    total_raw_tokens: 0,
    total_calls: 0,
    sessions: 1,
    first_session: '2026-07-01T00:00:00.000Z',
    last_session: '2026-09-07T00:00:00.000Z',
    per_project: {},
    per_tool: {},
    ...over,
  };
}

describe('buildSavingsReport', () => {
  it('reads the measured block, never the totals', () => {
    // A store whose totals are large and whose measured block is small: the
    // pre-TRA-880 shape, where `total_tokens_saved` was calls x constant.
    const r = buildSavingsReport(
      store({
        total_calls: 10_000,
        total_tokens_saved: 25_000_000,
        total_raw_tokens: 30_000_000,
        measured: { calls: 100, tokens_saved: 40_000, raw_tokens: 100_000, actual_tokens: 60_000 },
      }),
    );
    expect(r.enough_data).toBe(true);
    expect(r.tokens_saved).toBe(40_000);
    expect(r.baseline_tokens).toBe(100_000);
    expect(r.response_tokens).toBe(60_000);
    expect(r.reduction_pct).toBe(40);
    expect(r.calls).toBe(100);
    expect(r.unmeasured_calls).toBe(9_900);
  });

  it('states "not enough data" instead of a number below the threshold', () => {
    const r = buildSavingsReport(
      store({
        total_calls: 5,
        measured: { calls: 5, tokens_saved: 4_000, raw_tokens: 10_000, actual_tokens: 6_000 },
      }),
    );
    expect(r.enough_data).toBe(false);
    expect(r.reason).toContain(String(MIN_MEASURED_CALLS));
    expect(formatSavingsReport(r)).not.toContain('4,000');
  });

  it('treats a store with no measured block as unmeasured, not as zero savings', () => {
    // Every store written before TRA-1091 looks like this. Crediting its
    // totals would republish exactly the arithmetic TRA-880 disproved.
    const r = buildSavingsReport(store({ total_calls: 20_000, total_tokens_saved: 50_000_000 }));
    expect(r.enough_data).toBe(false);
    expect(r.tokens_saved).toBe(0);
    expect(r.unmeasured_calls).toBe(20_000);
    expect(r.reason).toContain('20000 earlier calls'); // the sentence names what it excluded
    expect(formatSavingsReport(r)).toContain('not enough data');
  });

  it('handles an empty store', () => {
    const r = buildSavingsReport(null);
    expect(r.enough_data).toBe(false);
    expect(r.calls).toBe(0);
    expect(r.since).toBeNull();
    expect(() => formatSavingsReport(r)).not.toThrow();
  });

  it('prices dollars at the cheapest rate, so the figure understates', () => {
    const r = buildSavingsReport(
      store({
        total_calls: 1_000,
        measured: {
          ...emptyMeasured(),
          calls: 1_000,
          tokens_saved: 2_000_000,
          raw_tokens: 4_000_000,
          actual_tokens: 2_000_000,
        },
      }),
    );
    // 2M tokens at $1/Mtok — Sonnet would be 3x this, Opus 5x.
    expect(r.usd_saved_floor).toBe(2);
    expect(r.price_per_mtok_usd).toBe(1);
  });

  it('prints the method link and the "at least" framing whenever it prints a number', () => {
    const text = formatSavingsReport(
      buildSavingsReport(
        store({
          total_calls: 100,
          measured: {
            ...emptyMeasured(),
            calls: 100,
            tokens_saved: 50_000,
            raw_tokens: 80_000,
            actual_tokens: 30_000,
          },
        }),
      ),
    );
    expect(text).toContain('at least');
    expect(text).toContain('response-tokens');
    expect(text).toContain('estimate');
    expect(text).toContain('chars/4');
    expect(text).toContain('0.220–0.368');
  });
});

/**
 * A daemon session can run for days. Before TRA-1091 `flush()` was one-shot and
 * only ran at shutdown, so the store every one of these surfaces reads ignored
 * everything the user had just done. Flushing repeatedly is now the normal
 * case — which only works if a second flush writes the delta and not the total.
 */
describe('SavingsTracker.flush is a repeatable delta', () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-savings-flush-'));
    prev = process.env.TRACE_MCP_DATA_DIR;
    process.env.TRACE_MCP_DATA_DIR = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.TRACE_MCP_DATA_DIR;
    else process.env.TRACE_MCP_DATA_DIR = prev;
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it('does not double-count what an earlier flush already wrote', async () => {
    const mod = await import('../../src/savings.js');
    const tracker = new mod.SavingsTracker('/test/project');

    tracker.recordCall('search');
    tracker.recordActualTokens('search', 100); // raw 600 -> saved 500
    tracker.flush();

    const first = mod.loadPersistentSavings();
    expect(first?.total_calls).toBe(1);
    expect(first?.measured?.calls).toBe(1);
    expect(first?.measured?.tokens_saved).toBe(500);

    tracker.flush(); // nothing new happened
    expect(mod.loadPersistentSavings()).toEqual(first);

    tracker.recordCall('get_symbol');
    tracker.recordActualTokens('get_symbol', 300); // raw 800 -> saved 500
    tracker.flush();

    const second = mod.loadPersistentSavings();
    expect(second?.total_calls).toBe(2);
    expect(second?.measured?.calls).toBe(2);
    expect(second?.measured?.tokens_saved).toBe(1000);
    expect(second?.per_tool.search?.calls).toBe(1);
    expect(second?.sessions).toBe(1); // one session, three flushes
  });

  /* The early-return guard used to test only calls and saved tokens. For a
     NO_BASELINE tool both are zero by construction, so a correction arriving
     in a later flush window than its recordCall was dropped and never reached
     disk — under-reporting exactly the measured count the report gates on. */
  it('writes a correction whose only effect is on the measured block', async () => {
    const mod = await import('../../src/savings.js');
    const tracker = new mod.SavingsTracker('/test/project');

    tracker.recordCall('register_edit'); // NO_BASELINE: rawCost 0, saved 0
    tracker.flush();
    expect(mod.loadPersistentSavings()?.measured?.calls).toBe(0);

    tracker.recordActualTokens('register_edit', 120);
    tracker.flush();

    const after = mod.loadPersistentSavings();
    expect(after?.measured?.calls).toBe(1);
    expect(after?.measured?.actual_tokens).toBe(120);
    expect(after?.measured?.tokens_saved).toBe(0); // no baseline to save against
    expect(after?.total_calls).toBe(1); // and the call is still counted once
  });

  it('counts only calls whose response was actually measured', async () => {
    const mod = await import('../../src/savings.js');
    const tracker = new mod.SavingsTracker('/test/project');
    tracker.recordCall('search'); // never corrected: the response was never counted
    tracker.recordCall('get_symbol');
    tracker.recordActualTokens('get_symbol', 300);
    tracker.flush();

    const saved = mod.loadPersistentSavings();
    expect(saved?.total_calls).toBe(2);
    expect(saved?.measured?.calls).toBe(1);
    expect(saved?.measured?.tokens_saved).toBe(500);
  });
});
