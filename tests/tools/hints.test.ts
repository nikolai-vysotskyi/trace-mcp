import { describe, test, expect } from 'vitest';
import { getHints, withHints, type Hint } from '../../src/tools/hints.js';

describe('Next-step hints', () => {
  describe('getHints', () => {
    test('returns empty array for unknown tool', () => {
      expect(getHints('nonexistent_tool', {})).toEqual([]);
    });

    test('returns max 3 hints by default', () => {
      const result = {
        symbol_id: 'src/foo.ts#bar',
        name: 'bar',
        kind: 'function',
        file: 'src/foo.ts',
      };
      const hints = getHints('get_symbol', result);
      expect(hints.length).toBeLessThanOrEqual(3);
      expect(hints.length).toBeGreaterThan(0);
    });

    test('respects custom max', () => {
      const result = { symbol_id: 'src/foo.ts#bar' };
      const hints = getHints('get_symbol', result, 1);
      expect(hints.length).toBe(1);
    });

    test('get_symbol hints include call_graph and change_impact', () => {
      const result = { symbol_id: 'src/foo.ts#myFunc' };
      const hints = getHints('get_symbol', result);
      const toolNames = hints.map((h) => h.tool);
      expect(toolNames).toContain('get_call_graph');
      expect(toolNames).toContain('get_change_impact');
      expect(toolNames).toContain('get_tests_for');
    });

    test('get_symbol passes symbol_id to hint args', () => {
      const result = { symbol_id: 'src/foo.ts#myFunc' };
      const hints = getHints('get_symbol', result);
      const callGraphHint = hints.find((h) => h.tool === 'get_call_graph');
      expect(callGraphHint?.args?.symbol_id).toBe('src/foo.ts#myFunc');
    });

    test('search hints reference first result', () => {
      const result = {
        items: [
          { symbol_id: 'src/a.ts#A', name: 'A', kind: 'class', score: 1.0 },
          { symbol_id: 'src/b.ts#B', name: 'B', kind: 'function', score: 0.8 },
        ],
        total: 2,
        search_mode: 'bm25',
      };
      const hints = getHints('search', result);
      const symbolHint = hints.find((h) => h.tool === 'get_symbol');
      expect(symbolHint?.args?.symbol_id).toBe('src/a.ts#A');
    });

    test('search hints suggest narrowing when total > 20', () => {
      const result = {
        items: [{ symbol_id: 'src/a.ts#A', name: 'A' }],
        total: 150,
      };
      const hints = getHints('search', result);
      const narrowHint = hints.find((h) => h.why.includes('150 results'));
      expect(narrowHint).toBeDefined();
    });

    test('get_tests_for suggests reading source when no tests found', () => {
      const result = { tests: [] };
      const hints = getHints('get_tests_for', result);
      expect(hints.length).toBeGreaterThan(0);
      expect(hints[0].tool).toBe('get_symbol');
    });

    test('get_tests_for returns no hints when tests exist', () => {
      const result = { tests: [{ file: 'test.ts', symbols: [] }] };
      const hints = getHints('get_tests_for', result);
      expect(hints.length).toBe(0);
    });

    test('get_project_map hints include suggest_queries', () => {
      const hints = getHints('get_project_map', {});
      const toolNames = hints.map((h) => h.tool);
      expect(toolNames).toContain('suggest_queries');
    });

    test('get_call_graph suggests change_impact', () => {
      const hints = getHints('get_call_graph', { callers: [], callees: [] });
      const toolNames = hints.map((h) => h.tool);
      expect(toolNames).toContain('get_change_impact');
    });

    test('get_call_graph suggests extraction when high fan-in', () => {
      const hints = getHints('get_call_graph', {
        callers: Array(6).fill({ symbol_id: 'x' }),
      });
      const extractHint = hints.find((h) => h.tool === 'get_extraction_candidates');
      expect(extractHint).toBeDefined();
    });

    test('check_rename_safe suggests apply_rename when safe', () => {
      const hints = getHints('check_rename_safe', { safe: true, conflicts: [] });
      const applyHint = hints.find((h) => h.tool === 'apply_rename');
      expect(applyHint).toBeDefined();
    });

    test('check_rename_safe returns empty when not safe', () => {
      const hints = getHints('check_rename_safe', { safe: false, conflicts: ['x'] });
      const applyHint = hints.find((h) => h.tool === 'apply_rename');
      expect(applyHint).toBeUndefined();
    });

    test('get_dead_code suggests remove_dead_code', () => {
      const hints = getHints('get_dead_code', { dead: [{ symbol_id: 'x' }] });
      const removeHint = hints.find((h) => h.tool === 'remove_dead_code');
      expect(removeHint).toBeDefined();
    });

    test('get_coupling_metrics suggests dependency_cycles', () => {
      const hints = getHints('get_coupling_metrics', []);
      const toolNames = hints.map((h) => h.tool);
      expect(toolNames).toContain('get_dependency_cycles');
    });

    test('get_dependency_cycles suggests layer_violations', () => {
      const hints = getHints('get_dependency_cycles', {});
      const toolNames = hints.map((h) => h.tool);
      expect(toolNames).toContain('get_layer_violations');
    });

    test('get_schema suggests model_context', () => {
      const hints = getHints('get_schema', {});
      const toolNames = hints.map((h) => h.tool);
      expect(toolNames).toContain('get_model_context');
    });

    test('get_repo_health suggests hotspots and dead_code', () => {
      const hints = getHints('get_repo_health', {});
      const toolNames = hints.map((h) => h.tool);
      expect(toolNames).toContain('get_hotspots');
      expect(toolNames).toContain('get_dead_code');
    });

    test('never throws on malformed input', () => {
      expect(() => getHints('get_symbol', null)).not.toThrow();
      expect(() => getHints('get_symbol', undefined)).not.toThrow();
      expect(() => getHints('search', 42)).not.toThrow();
      expect(() => getHints('get_outline', 'string')).not.toThrow();
    });
  });

  describe('withHints', () => {
    test('adds _hints key to object results', () => {
      const result = { symbol_id: 'src/foo.ts#bar' };
      const enriched = withHints('get_symbol', result) as Record<string, unknown>;
      expect(enriched._hints).toBeDefined();
      expect(Array.isArray(enriched._hints)).toBe(true);
      expect(enriched.symbol_id).toBe('src/foo.ts#bar');
    });

    test('wraps array results in {data, _hints}', () => {
      const result = [{ symbol_id: 'x' }];
      const enriched = withHints('get_outline', result) as Record<string, unknown>;
      expect(enriched.data).toEqual(result);
      expect(enriched._hints).toBeDefined();
    });

    test('returns original object unchanged when no hints', () => {
      const result = { foo: 'bar' };
      const enriched = withHints('nonexistent_tool', result);
      expect(enriched).toBe(result); // same reference, not modified
    });

    test('wraps null result when hints exist', () => {
      // get_project_map always has hints, even for null
      const enriched = withHints('get_project_map', null) as Record<string, unknown>;
      expect(enriched.data).toBeNull();
      expect(enriched._hints).toBeDefined();
    });

    test('does not mutate original object', () => {
      const result = { symbol_id: 'src/foo.ts#bar' };
      const original = { ...result };
      withHints('get_symbol', result);
      expect(result).toEqual(original); // original is unchanged
    });

    test('hint structure has required fields', () => {
      const result = { symbol_id: 'src/foo.ts#bar' };
      const enriched = withHints('get_symbol', result) as { _hints: Hint[] };
      for (const hint of enriched._hints) {
        expect(hint.tool).toBeDefined();
        expect(typeof hint.tool).toBe('string');
        expect(hint.why).toBeDefined();
        expect(typeof hint.why).toBe('string');
      }
    });

    test('JSON serialization works correctly', () => {
      const result = { symbol_id: 'src/foo.ts#bar', name: 'bar' };
      const enriched = withHints('get_symbol', result);
      const json = JSON.stringify(enriched);
      const parsed = JSON.parse(json);
      expect(parsed._hints).toBeDefined();
      expect(parsed.symbol_id).toBe('src/foo.ts#bar');
    });
  });
});
