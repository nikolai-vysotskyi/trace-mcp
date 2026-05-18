import { describe, expect, it } from 'vitest';
import {
  buildNegativeEvidence,
  classifyResolverGap,
  extractBareName,
} from '../../src/tools/shared/evidence.js';

describe('buildNegativeEvidence', () => {
  it('returns tool-specific suggestion for find_usages', () => {
    const ev = buildNegativeEvidence(100, 500, false, 'find_usages');
    // Positional form defaults to "not_found" — the per-tool override still
    // wins on suggestion text.
    expect(ev.verdict).toBe('not_found');
    expect(ev.scope).toBe('full_index');
    expect(ev.indexed_files).toBe(100);
    expect(ev.indexed_symbols).toBe(500);
    expect(ev.suggestion).toContain('search_text');
    expect(ev.suggestion).toContain('parametric');
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
    expect(ev.suggestion).toContain('Symbol not in indexed codebase');
    expect(ev.query_expanded).toBe(true);
  });

  // ─── Options-object overload + verdict semantics ─────────────

  it('options form: defaults to not_found verdict', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'search',
    });
    expect(ev.verdict).toBe('not_found');
    expect(ev.indexed_files).toBe(10);
    expect(ev.indexed_symbols).toBe(100);
    expect(ev.query_expanded).toBe(false);
  });

  it('options form: emits indexed_no_edges when symbol exists with no edges', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'find_usages',
      verdict: 'indexed_no_edges',
      symbol: 'src/foo.ts::bar#function',
    });
    expect(ev.verdict).toBe('indexed_no_edges');
    expect(ev.symbol).toBe('src/foo.ts::bar#function');
    // Per-tool find_usages suggestion still wins for indexed_no_edges.
    expect(ev.suggestion).toContain('search_text');
    expect(ev.suggestion).toContain('parametric');
  });

  it('options form: upgrades to resolver_gap_suspected when text hits > 2', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'find_usages',
      verdict: 'indexed_no_edges',
      symbol: 'src/db/store.ts::Store#class::getSymbolById#method',
      symbolKind: 'method',
      textOccurrences: 29,
    });
    expect(ev.verdict).toBe('resolver_gap_suspected');
    expect(ev.text_occurrences).toBe(29);
    expect(ev.suggestion).toContain('getSymbolById');
    expect(ev.suggestion).toContain('29');
    expect(ev.suggestion).toContain('parametric');
  });

  it('options form: keeps indexed_no_edges when text hits <= 2', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'find_usages',
      verdict: 'indexed_no_edges',
      symbol: 'src/foo.ts::veryUniqueName#function',
      symbolKind: 'function',
      textOccurrences: 1,
    });
    expect(ev.verdict).toBe('indexed_no_edges');
    expect(ev.text_occurrences).toBeUndefined();
  });

  it('options form: never upgrades interface verdicts to gap-suspected', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'get_type_hierarchy',
      verdict: 'indexed_no_edges',
      symbol: 'LanguagePlugin',
      symbolKind: 'interface',
      textOccurrences: 47,
    });
    expect(ev.verdict).toBe('indexed_no_edges');
    expect(ev.text_occurrences).toBeUndefined();
  });

  it('options form: never upgrades common builtin names (push/get/has/...)', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'find_usages',
      verdict: 'indexed_no_edges',
      symbol: 'src/foo.ts::Bag#class::push#method',
      symbolKind: 'method',
      textOccurrences: 200,
    });
    expect(ev.verdict).toBe('indexed_no_edges');
  });

  it('options form: not_found is never upgraded to gap (symbol not indexed)', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'find_usages',
      verdict: 'not_found',
      symbol: 'src/nope.ts::doesNotExist#function',
      textOccurrences: 99, // irrelevant — we never indexed it
    });
    expect(ev.verdict).toBe('not_found');
  });

  it('options form: unknown tool falls through to per-verdict default suggestion', () => {
    const noEdges = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'unknown_relation_tool',
      verdict: 'indexed_no_edges',
    });
    expect(noEdges.verdict).toBe('indexed_no_edges');
    expect(noEdges.suggestion).toContain('zero edges');

    const notFound = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'unknown_relation_tool',
      verdict: 'not_found',
    });
    expect(notFound.suggestion).toContain('Symbol not in indexed codebase');
  });

  it('returns suggestion for get_call_graph', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'get_call_graph',
      verdict: 'indexed_no_edges',
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

  // ─── Backwards-compat aliases ─────────────────────────────────

  it('accepts legacy not_found_in_project alias and normalizes to not_found', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'search',
      verdict: 'not_found_in_project',
    });
    expect(ev.verdict).toBe('not_found');
  });

  it('accepts legacy symbol_indexed_but_isolated alias and normalizes to indexed_no_edges', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'find_usages',
      verdict: 'symbol_indexed_but_isolated',
      symbol: 'src/foo.ts::bar#function',
    });
    expect(ev.verdict).toBe('indexed_no_edges');
  });

  it('legacy alias still participates in gap upgrade', () => {
    const ev = buildNegativeEvidence({
      indexedFiles: 10,
      indexedSymbols: 100,
      toolName: 'find_usages',
      verdict: 'symbol_indexed_but_isolated',
      symbol: 'src/db/store.ts::Store#class::getSymbolById#method',
      symbolKind: 'method',
      textOccurrences: 29,
    });
    expect(ev.verdict).toBe('resolver_gap_suspected');
    expect(ev.text_occurrences).toBe(29);
  });
});

describe('extractBareName', () => {
  it('strips FQN segments and #kind suffix', () => {
    expect(extractBareName('src/db/store.ts::Store#class::getSymbolById#method')).toBe(
      'getSymbolById',
    );
  });

  it('handles bare names', () => {
    expect(extractBareName('myFunction')).toBe('myFunction');
  });

  it('handles dotted FQNs', () => {
    expect(extractBareName('foo.bar.baz')).toBe('baz');
  });

  it('returns null for non-identifier shapes', () => {
    expect(extractBareName('()')).toBeNull();
    expect(extractBareName('')).toBeNull();
  });
});

describe('classifyResolverGap', () => {
  it('upgrades when text hits > 2 and name is uncommon', () => {
    const r = classifyResolverGap({
      symbol: 'src/foo.ts::Bar#class::compute#method',
      kindHint: 'method',
      textOccurrences: 7,
    });
    expect(r.isGap).toBe(true);
    expect(r.bareName).toBe('compute');
    expect(r.textOccurrences).toBe(7);
  });

  it('does not upgrade when text hits <= 2', () => {
    expect(
      classifyResolverGap({
        symbol: 'src/foo.ts::Bar#class::compute#method',
        kindHint: 'method',
        textOccurrences: 2,
      }).isGap,
    ).toBe(false);
  });

  it('does not upgrade common builtin names', () => {
    expect(
      classifyResolverGap({
        symbol: 'src/foo.ts::List#class::push#method',
        kindHint: 'method',
        textOccurrences: 50,
      }).isGap,
    ).toBe(false);
  });

  it('does not upgrade interface kind even with many hits', () => {
    expect(
      classifyResolverGap({
        symbol: 'LanguagePlugin',
        kindHint: 'interface',
        textOccurrences: 50,
      }).isGap,
    ).toBe(false);
  });

  it('does not upgrade type alias kind', () => {
    expect(
      classifyResolverGap({
        symbol: 'EvidenceVerdict',
        kindHint: 'type_alias',
        textOccurrences: 50,
      }).isGap,
    ).toBe(false);
  });

  it('does not upgrade when no bare name can be extracted', () => {
    expect(
      classifyResolverGap({
        symbol: '()',
        textOccurrences: 99,
      }).isGap,
    ).toBe(false);
  });
});
