import { describe, it, expect } from 'vitest';
import { buildNegativeEvidence } from '../../src/tools/shared/evidence.js';

describe('buildNegativeEvidence', () => {
  it('returns tool-specific suggestion for find_usages', () => {
    const ev = buildNegativeEvidence(100, 500, false, 'find_usages');
    expect(ev.verdict).toBe('not_found_in_project');
    expect(ev.scope).toBe('full_index');
    expect(ev.indexed_files).toBe(100);
    expect(ev.indexed_symbols).toBe(500);
    expect(ev.suggestion).toContain('no incoming references');
  });

  it('returns tool-specific suggestion for get_tests_for', () => {
    const ev = buildNegativeEvidence(50, 200, false, 'get_tests_for');
    expect(ev.suggestion).toContain('No tests found');
  });

  it('returns tool-specific suggestion for search_text', () => {
    const ev = buildNegativeEvidence(50, 200, false, 'search_text');
    expect(ev.suggestion).toContain('No text matches');
  });

  it('returns tool-specific suggestion for search', () => {
    const ev = buildNegativeEvidence(50, 200, false, 'search');
    expect(ev.suggestion).toContain('No symbols matched');
  });

  it('returns tool-specific suggestion for get_feature_context', () => {
    const ev = buildNegativeEvidence(50, 200, false, 'get_feature_context');
    expect(ev.suggestion).toContain('No code matched');
  });

  it('returns tool-specific suggestion for get_dead_code', () => {
    const ev = buildNegativeEvidence(50, 200, false, 'get_dead_code');
    expect(ev.suggestion).toContain('No dead code detected');
  });

  it('returns tool-specific suggestion for get_circular_imports', () => {
    const ev = buildNegativeEvidence(50, 200, false, 'get_circular_imports');
    expect(ev.suggestion).toContain('No circular import');
  });

  it('returns default suggestion for unknown tool', () => {
    const ev = buildNegativeEvidence(50, 200, true, 'some_other_tool');
    expect(ev.suggestion).toContain('does not exist in the indexed codebase');
    expect(ev.query_expanded).toBe(true);
  });

  // ─── Options-object overload + isolation verdict ─────────────

  it('options form: defaults to not_found_in_project verdict', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'search',
    });
    expect(ev.verdict).toBe('not_found_in_project');
    expect(ev.indexed_files).toBe(10);
    expect(ev.indexed_symbols).toBe(100);
    expect(ev.query_expanded).toBe(false);
  });

  it('options form: emits symbol_indexed_but_isolated when verdict requested', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'find_usages',
      verdict: 'symbol_indexed_but_isolated',
      symbol: 'src/foo.ts::bar#function',
    });
    expect(ev.verdict).toBe('symbol_indexed_but_isolated');
    expect(ev.symbol).toBe('src/foo.ts::bar#function');
    expect(ev.suggestion).toContain('no incoming references');
  });

  it('isolation verdict default suggestion for unknown tool', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'unknown_relation_tool',
      verdict: 'symbol_indexed_but_isolated',
    });
    expect(ev.verdict).toBe('symbol_indexed_but_isolated');
    expect(ev.suggestion).toContain('absence is authoritative');
  });

  it('returns suggestion for get_call_graph', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'get_call_graph',
      verdict: 'symbol_indexed_but_isolated',
    });
    expect(ev.suggestion).toContain('leaf');
  });

  it('returns suggestion for get_type_hierarchy', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'get_type_hierarchy',
    });
    expect(ev.suggestion).toContain('parents');
  });

  it('returns suggestion for get_implementations', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'get_implementations',
    });
    expect(ev.suggestion).toContain('implement or extend');
  });
});
