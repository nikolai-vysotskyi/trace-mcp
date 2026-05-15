/**
 * Behavioural coverage for `SessionJournal.getSnapshot()` — the engine behind
 * the `get_session_snapshot` MCP tool.
 *
 * IMPL NOTE: the MCP tool is inline-registered in
 * `src/tools/register/session.ts` and forwards directly to
 * `journal.getSnapshot({...})`. We assert the underlying SessionJournal
 * method (same approach as `get-env-vars.behavioural.test.ts`).
 *
 * Snapshot fields use snake_case internally (focus_files / edited_files /
 * key_searches / dead_ends). The brief uses the public-facing camelCase
 * (focusFiles / editedFiles / keySearches / deadEnds). We assert the
 * documented structured contract under `result.structured.*`.
 */
import { describe, expect, it } from 'vitest';
import { SessionJournal } from '../../../src/session/journal.js';

function seedJournal(): SessionJournal {
  const j = new SessionJournal();
  // Multiple reads of the same files to populate focus_files.
  for (let i = 0; i < 3; i++) {
    j.record('get_outline', { path: 'src/server.ts' }, 5);
  }
  j.record('get_outline', { path: 'src/config.ts' }, 4);
  j.record('get_symbol', { symbol_id: 'src/util.ts::doThing#function' }, 1);

  // An edit
  j.record('register_edit', { file_path: 'src/edited.ts' }, 1);

  // Productive search (has results)
  j.record('search', { query: 'useful term' }, 3);
  // Two dead-end searches — zero results
  j.record('search', { query: 'no-such-thing' }, 0);
  j.record('search', { query: 'also-missing' }, 0);
  return j;
}

describe('SessionJournal.getSnapshot() — behavioural contract', () => {
  it('returns focus_files / edited_files / key_searches / dead_ends', () => {
    const j = seedJournal();
    const snap = j.getSnapshot();
    const s = snap.structured;

    expect(Array.isArray(s.focus_files)).toBe(true);
    expect(Array.isArray(s.edited_files)).toBe(true);
    expect(Array.isArray(s.key_searches)).toBe(true);
    expect(Array.isArray(s.dead_ends)).toBe(true);

    // Focus files surfaced from get_outline / get_symbol calls.
    const focusPaths = s.focus_files.map((f) => f.path);
    expect(focusPaths).toContain('src/server.ts');
    expect(focusPaths).toContain('src/config.ts');

    // Edited file surfaced from register_edit.
    expect(s.edited_files).toContain('src/edited.ts');

    // Productive search surfaced as a key search.
    expect(s.key_searches.some((k) => k.query.includes('useful term'))).toBe(true);

    // Dead ends include the two zero-result queries.
    const deadQueries = s.dead_ends.map((d) => d.query);
    expect(deadQueries.some((q) => q.includes('no-such-thing'))).toBe(true);
    expect(deadQueries.some((q) => q.includes('also-missing'))).toBe(true);
  });

  it('maxFiles / maxEdits / maxSearches respected', () => {
    const j = new SessionJournal();
    // Five distinct files, each read twice → five focus_files candidates.
    for (let i = 0; i < 5; i++) {
      const p = `src/file${i}.ts`;
      j.record('get_outline', { path: p }, 3);
      j.record('get_outline', { path: p }, 3);
    }
    // Four register_edit entries.
    for (let i = 0; i < 4; i++) {
      j.record('register_edit', { file_path: `src/edit${i}.ts` }, 1);
    }
    // Three distinct productive search queries.
    j.record('search', { query: 'q-alpha' }, 1);
    j.record('search', { query: 'q-beta' }, 2);
    j.record('search', { query: 'q-gamma' }, 3);

    const snap = j.getSnapshot({ maxFiles: 2, maxEdits: 2, maxSearches: 2 });
    expect(snap.structured.focus_files.length).toBe(2);
    expect(snap.structured.edited_files.length).toBe(2);
    expect(snap.structured.key_searches.length).toBe(2);
  });

  it('includeNegativeEvidence=false strips dead_ends', () => {
    const j = seedJournal();
    const without = j.getSnapshot({ includeNegativeEvidence: false });
    expect(without.structured.dead_ends).toEqual([]);

    const withNeg = j.getSnapshot({ includeNegativeEvidence: true });
    expect(withNeg.structured.dead_ends.length).toBeGreaterThan(0);
  });

  it('empty journal returns an empty structured envelope', () => {
    const j = new SessionJournal();
    const snap = j.getSnapshot();
    expect(snap.structured.total_calls).toBe(0);
    expect(snap.structured.focus_files).toEqual([]);
    expect(snap.structured.edited_files).toEqual([]);
    expect(snap.structured.key_searches).toEqual([]);
    expect(snap.structured.dead_ends).toEqual([]);
    expect(typeof snap.snapshot).toBe('string');
    expect(typeof snap.estimated_tokens).toBe('number');
  });
});
