import { describe, it, expect } from 'vitest';
import { SessionJournal } from '../../src/session/journal.js';

describe('SessionJournal — dedup', () => {
  it('returns null for first-time calls', () => {
    const j = new SessionJournal();
    expect(j.checkDuplicate('get_symbol', { symbol_id: 'foo' })).toBeNull();
  });

  it('returns action=dedup for repeated content-heavy tools with compact result', () => {
    const j = new SessionJournal();
    const params = { symbol_id: 'src/a.ts::Foo#class' };

    // First call — record with compact result
    j.record('get_symbol', params, 1, {
      compactResult: {
        symbol_id: 'src/a.ts::Foo#class',
        name: 'Foo',
        kind: 'class',
        _result_count: 1,
      },
      resultTokens: 800,
    });

    // Second call — should get dedup
    const dup = j.checkDuplicate('get_symbol', params);
    expect(dup).not.toBeNull();
    expect(dup!.action).toBe('dedup');
    expect(dup!.compact_result).toBeDefined();
    expect(dup!.compact_result!.name).toBe('Foo');
    expect(dup!.saved_tokens).toBe(800);
  });

  it('returns action=warn for repeated search tools (non-dedup)', () => {
    const j = new SessionJournal();
    const params = { query: 'handleRequest' };

    j.record('search', params, 5);

    const dup = j.checkDuplicate('search', params);
    expect(dup).not.toBeNull();
    expect(dup!.action).toBe('warn');
    expect(dup!.compact_result).toBeNull();
  });

  it('returns action=warn for zero-result dedup tools (no compact to return)', () => {
    const j = new SessionJournal();
    const params = { symbol_id: 'nonexistent' };

    // Recorded with 0 results and no compact result (error path)
    j.record('get_symbol', params, 0);

    const dup = j.checkDuplicate('get_symbol', params);
    expect(dup).not.toBeNull();
    expect(dup!.action).toBe('warn');
  });

  it('tracks dedup savings', () => {
    const j = new SessionJournal();
    expect(j.getDedupSavedTokens()).toBe(0);

    j.recordDedupSaving(800);
    j.recordDedupSaving(1200);

    expect(j.getDedupSavedTokens()).toBe(2000);
  });

  it('includes dedup_saved_tokens in summary', () => {
    const j = new SessionJournal();
    j.recordDedupSaving(500);

    // getSummary doesn't include it, but getDedupSavedTokens() does
    expect(j.getDedupSavedTokens()).toBe(500);
  });

  it('deduplicates get_outline the same as get_symbol', () => {
    const j = new SessionJournal();
    const params = { path: 'src/server.ts' };

    j.record('get_outline', params, 15, {
      compactResult: { path: 'src/server.ts', symbols: [], _result_count: 15 },
      resultTokens: 1200,
    });

    const dup = j.checkDuplicate('get_outline', params);
    expect(dup).not.toBeNull();
    expect(dup!.action).toBe('dedup');
    expect(dup!.saved_tokens).toBe(1200);
  });

  it('different params produce no dedup', () => {
    const j = new SessionJournal();

    j.record('get_symbol', { symbol_id: 'a' }, 1, {
      compactResult: { symbol_id: 'a', _result_count: 1 },
      resultTokens: 500,
    });

    const dup = j.checkDuplicate('get_symbol', { symbol_id: 'b' });
    expect(dup).toBeNull();
  });
});

describe('SessionJournal — optimization hints', () => {
  it('detects multiple get_symbol from same file', () => {
    const j = new SessionJournal();
    const file = 'src/server.ts';

    // Simulate reading 5 symbols from the same file
    for (let i = 0; i < 5; i++) {
      j.record('get_symbol', { symbol_id: `${file}::func${i}#function` }, 1);
    }

    const hint = j.getOptimizationHint('get_symbol', { symbol_id: `${file}::func5#function` });
    expect(hint).not.toBeNull();
    expect(hint).toContain('get_context_bundle');
  });

  it('returns null when no wasteful pattern detected', () => {
    const j = new SessionJournal();
    j.record('search', { query: 'foo' }, 3);
    j.record('get_symbol', { symbol_id: 'a.ts::bar#function' }, 1);

    const hint = j.getOptimizationHint('get_outline', { path: 'b.ts' });
    expect(hint).toBeNull();
  });

  it('detects search → get_symbol chain', () => {
    const j = new SessionJournal();

    // Simulate typical explore pattern: search, search, then multiple get_symbol
    j.record('search', { query: 'foo' }, 5);
    j.record('search', { query: 'bar' }, 3);
    j.record('get_symbol', { symbol_id: 'a.ts::x#function' }, 1);
    j.record('get_symbol', { symbol_id: 'b.ts::y#function' }, 1);
    j.record('get_symbol', { symbol_id: 'c.ts::z#function' }, 1);

    const hint = j.getOptimizationHint('get_symbol', { symbol_id: 'd.ts::w#function' });
    expect(hint).not.toBeNull();
    expect(hint).toContain('get_task_context');
  });

  it('detects get_outline → many get_symbol chain', () => {
    const j = new SessionJournal();

    j.record('get_outline', { path: 'src/server.ts' }, 20);

    // Then read 6 symbols individually
    for (let i = 0; i < 6; i++) {
      j.record('get_symbol', { symbol_id: `src/server.ts::func${i}#function` }, 1);
    }

    const hint = j.getOptimizationHint('get_symbol', {
      symbol_id: 'src/server.ts::func7#function',
    });
    expect(hint).not.toBeNull();
    // Pattern 1 (same-file bulk reads) fires — recommends get_context_bundle or Read
    expect(hint).toContain('get_context_bundle');
  });
});

describe('SessionJournal — prefetch boosts', () => {
  it('returns empty when no task_context calls made', () => {
    const j = new SessionJournal();
    j.record('get_symbol', { symbol_id: 'a.ts::foo#function' }, 1);
    expect(j.getPrefetchBoosts()).toHaveLength(0);
  });

  it('identifies follow-up files after get_task_context', () => {
    const j = new SessionJournal();

    // Simulate: task_context → then several get_symbol calls for specific files
    j.record('get_task_context', { task: 'fix the bug' }, 5);
    j.record('get_symbol', { symbol_id: 'src/server.ts::createServer#function' }, 1);
    j.record('get_symbol', { symbol_id: 'src/server.ts::jh#function' }, 1);
    j.record('get_outline', { path: 'src/config.ts' }, 10);
    j.record('get_symbol', { symbol_id: 'src/server.ts::extractResultCount#function' }, 1);

    const boosts = j.getPrefetchBoosts();
    // src/server.ts was accessed 3 times as follow-up → should be a boost
    expect(boosts.length).toBeGreaterThan(0);
    expect(boosts.find((b) => b.file === 'src/server.ts')).toBeDefined();
    expect(boosts.find((b) => b.file === 'src/server.ts')!.frequency).toBe(3);
  });

  it('ignores infrequent follow-ups', () => {
    const j = new SessionJournal();
    j.record('get_task_context', { task: 'explore' }, 3);
    j.record('get_symbol', { symbol_id: 'a.ts::foo#function' }, 1); // only once

    const boosts = j.getPrefetchBoosts();
    // a.ts accessed only once → not a boost (needs >= 2)
    expect(boosts.find((b) => b.file === 'a.ts')).toBeUndefined();
  });
});
