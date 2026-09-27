/**
 * SessionJournal byte cap (TRA-2017).
 *
 * Scratch-daemon repro: 1000 outline/bundle-heavy tool calls retained ~40KB
 * per call in the live session journal — the 10k entry-count cap alone lets
 * one long-lived agent session hold ~400MB of compact_result snapshots, and
 * the daemon routinely holds ~10 such sessions. These pin the byte budget:
 * oversized singles are skipped, the oldest snapshots strip first when the
 * 5MB budget blows, and entry metadata (warn-style duplicate detection) is
 * never touched.
 */
import { describe, expect, it } from 'vitest';
import { SessionJournal } from '../journal.js';

const MAX_COMPACT = 5 * 1024 * 1024;
const MAX_SINGLE = 256 * 1024;

function bigCompact(sizeBytes: number): Record<string, unknown> {
  return { blob: 'x'.repeat(sizeBytes) };
}

describe('SessionJournal compact byte cap', () => {
  it('retains small snapshots and tracks bytes', () => {
    const j = new SessionJournal();
    for (let i = 0; i < 10; i++) {
      j.record('get_symbol', { symbol_id: `f.ts::s${i}#function` }, 1, {
        compactResult: { name: `s${i}` },
      });
    }
    expect(j.getTotalEntries()).toBe(10);
    expect(j.getCompactBytes()).toBeGreaterThan(0);
    expect(j.getCompactBytes()).toBeLessThan(MAX_COMPACT);
    // Dedup short-circuit still works while under budget.
    const dup = j.checkDuplicate('get_symbol', { symbol_id: 'f.ts::s0#function' });
    expect(dup?.action).toBe('dedup');
  });

  it('skips a single snapshot over the per-compact limit but keeps the entry', () => {
    const j = new SessionJournal();
    j.record('get_context_bundle', { task: 'huge' }, 500, {
      compactResult: bigCompact(MAX_SINGLE + 1024),
    });
    expect(j.getTotalEntries()).toBe(1);
    expect(j.getCompactBytes()).toBe(0);
    // Degrades gracefully: warn instead of dedup, no crash.
    const dup = j.checkDuplicate('get_context_bundle', { task: 'huge' });
    expect(dup?.action).toBe('warn');
  });

  it('strips oldest snapshots first when the budget blows', () => {
    const j = new SessionJournal();
    const each = 200 * 1024; // 200KB — under the single cap
    const n = Math.ceil(MAX_COMPACT / each) + 3;
    for (let i = 0; i < n; i++) {
      j.record('get_outline', { path: `f${i}.ts` }, 10, { compactResult: bigCompact(each) });
    }
    expect(j.getTotalEntries()).toBe(n); // metadata untouched
    expect(j.getCompactBytes()).toBeLessThanOrEqual(MAX_COMPACT);
    // Newest entry keeps its snapshot (dedup works for fresh calls)...
    const fresh = j.checkDuplicate('get_outline', { path: `f${n - 1}.ts` });
    expect(fresh?.action).toBe('dedup');
    // ...while the oldest degraded to warn.
    const stale = j.checkDuplicate('get_outline', { path: 'f0.ts' });
    expect(stale?.action).toBe('warn');
  });

  it('count-cap eviction keeps the byte counter consistent', () => {
    const j = new SessionJournal();
    for (let i = 0; i < 10_500; i++) {
      j.record('get_symbol', { symbol_id: `f.ts::s${i}#function` }, 1, {
        compactResult: { name: `s${i}`, pad: 'y'.repeat(100) },
      });
    }
    expect(j.getTotalEntries()).toBeLessThanOrEqual(10_000);
    // Recomputed from survivors: every retained byte is accounted, none phantom.
    let recomputed = 0;
    for (const e of j.getEntries()) {
      recomputed += e.compact_result ? JSON.stringify(e.compact_result).length : 0;
    }
    expect(j.getCompactBytes()).toBe(recomputed);
  });

  it('dispose() resets byte accounting', () => {
    const j = new SessionJournal();
    j.record('get_symbol', { symbol_id: 'f.ts::s#function' }, 1, {
      compactResult: { name: 's' },
    });
    expect(j.getCompactBytes()).toBeGreaterThan(0);
    j.dispose();
    expect(j.getCompactBytes()).toBe(0);
    expect(j.getTotalEntries()).toBe(0);
  });
});
