/**
 * Behavioural coverage for `SessionJournal.getSummary()` — the engine behind
 * the `get_session_journal` MCP tool.
 *
 * IMPL: src/session/journal.ts
 *
 * The tool is inline-registered in src/tools/register/session.ts and forwards
 * to `journal.getSummary()` (plus `journal.getDedupSavedTokens()`). We assert
 * the underlying SessionJournal contract directly, mirroring the precedent in
 * tests/tools/behavioural/get-session-stats.behavioural.test.ts.
 *
 * Cases:
 *  - empty journal returns zero totals + empty arrays
 *  - record() pushes calls and populates files_read for get_outline/get_symbol
 *  - duplicate calls (same tool + params) appear in duplicate_queries
 *  - zero-result search calls appear in searches_with_zero_results
 *  - summary shape: { total_entries, files_read, searches_with_zero_results,
 *    duplicate_queries }
 */
import { describe, expect, it } from 'vitest';
import { SessionJournal } from '../../../src/session/journal.js';

describe('SessionJournal.getSummary() — behavioural contract', () => {
  it('empty journal returns zero totals and empty arrays', () => {
    const j = new SessionJournal();
    const s = j.getSummary();
    expect(s.total_entries).toBe(0);
    expect(s.files_read).toEqual([]);
    expect(s.searches_with_zero_results).toEqual([]);
    expect(s.duplicate_queries).toEqual([]);
  });

  it('record() pushes entries and populates files_read for symbol/outline tools', () => {
    const j = new SessionJournal();
    j.record('get_outline', { path: 'src/server.ts' }, 12);
    j.record('get_symbol', { file_path: 'src/config.ts' }, 1);
    j.record('search', { query: 'registerTool' }, 5);

    const s = j.getSummary();
    expect(s.total_entries).toBe(3);
    expect(s.files_read.sort()).toEqual(['src/config.ts', 'src/server.ts']);
    // Non-zero search did not enter the zero-result bucket.
    expect(s.searches_with_zero_results).toEqual([]);
  });

  it('duplicate (same tool + same params) calls land in duplicate_queries', () => {
    const j = new SessionJournal();
    j.record('search', { query: 'foo' }, 3);
    j.record('search', { query: 'foo' }, 3);
    j.record('search', { query: 'bar' }, 1);

    const s = j.getSummary();
    expect(s.total_entries).toBe(3);
    // "foo" was repeated; "bar" was not.
    expect(s.duplicate_queries.length).toBe(1);
    expect(s.duplicate_queries[0]).toContain('search');
  });

  it('zero-result search calls land in searches_with_zero_results', () => {
    const j = new SessionJournal();
    j.record('search', { query: 'nonexistent-symbol' }, 0);
    j.record('search', { query: 'also-nothing' }, 0);
    j.record('search', { query: 'has-results' }, 7);

    const s = j.getSummary();
    expect(s.searches_with_zero_results.length).toBe(2);
    expect(
      s.searches_with_zero_results.every((q) => typeof q === 'string' && q.includes('search')),
    ).toBe(true);
  });

  it('summary envelope exposes exactly the documented keys', () => {
    const j = new SessionJournal();
    j.record('get_outline', { path: 'src/a.ts' }, 4);
    const s = j.getSummary();
    expect(Object.keys(s).sort()).toEqual(
      ['duplicate_queries', 'files_read', 'searches_with_zero_results', 'total_entries'].sort(),
    );
    expect(typeof s.total_entries).toBe('number');
    expect(Array.isArray(s.files_read)).toBe(true);
    expect(Array.isArray(s.searches_with_zero_results)).toBe(true);
    expect(Array.isArray(s.duplicate_queries)).toBe(true);
  });
});
