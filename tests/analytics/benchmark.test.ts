import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { runBenchmark, formatBenchmarkMarkdown } from '../../src/analytics/benchmark.js';

describe('benchmark', () => {
  let store: Store;

  beforeEach(() => {
    const db = initializeDatabase(':memory:');
    store = new Store(db);

    const file1Id = store.insertFile('src/parser.ts', 'typescript', 'hash1', 5000);
    const file2Id = store.insertFile('src/store.ts', 'typescript', 'hash2', 8000);
    const file3Id = store.insertFile('src/utils.ts', 'typescript', 'hash3', 3000);

    store.insertSymbol(file1Id, {
      symbolId: 'parser.ts::parseInput',
      name: 'parseInput',
      kind: 'function',
      fqn: 'src/parser.ts::parseInput',
      signature: 'function parseInput(input: string): AST',
      byteStart: 100,
      byteEnd: 800,
      lineStart: 5,
      lineEnd: 30,
    });

    store.insertSymbol(file1Id, {
      symbolId: 'parser.ts::Parser',
      name: 'Parser',
      kind: 'class',
      fqn: 'src/parser.ts::Parser',
      signature: 'class Parser',
      byteStart: 900,
      byteEnd: 3000,
      lineStart: 35,
      lineEnd: 120,
    });

    store.insertSymbol(file2Id, {
      symbolId: 'store.ts::Store',
      name: 'Store',
      kind: 'class',
      fqn: 'src/store.ts::Store',
      signature: 'class Store',
      byteStart: 50,
      byteEnd: 6000,
      lineStart: 3,
      lineEnd: 200,
    });

    store.insertSymbol(file2Id, {
      symbolId: 'store.ts::createStore',
      name: 'createStore',
      kind: 'function',
      fqn: 'src/store.ts::createStore',
      signature: 'function createStore(config: Config): Store',
      byteStart: 6100,
      byteEnd: 7500,
      lineStart: 202,
      lineEnd: 250,
    });

    store.insertSymbol(file3Id, {
      symbolId: 'utils.ts::formatOutput',
      name: 'formatOutput',
      kind: 'function',
      fqn: 'src/utils.ts::formatOutput',
      signature: 'function formatOutput(data: any): string',
      byteStart: 0,
      byteEnd: 500,
      lineStart: 1,
      lineEnd: 20,
    });
  });

  describe('runBenchmark', () => {
    it('returns result with correct structure', () => {
      const result = runBenchmark(store, { queries: 3, seed: 42, projectName: 'test-project' });

      expect(result.project).toBe('test-project');
      expect(result.index_stats.files).toBeGreaterThan(0);
      expect(result.index_stats.symbols).toBeGreaterThan(0);

      expect(result.scenarios.length).toBeGreaterThanOrEqual(3);
      const scenarioNames = result.scenarios.map(s => s.name);
      expect(scenarioNames).toContain('symbol_lookup');
      expect(scenarioNames).toContain('file_exploration');
      expect(scenarioNames).toContain('search');

      for (const scenario of result.scenarios) {
        expect(scenario).toHaveProperty('name');
        expect(scenario).toHaveProperty('baseline_tokens');
        expect(scenario).toHaveProperty('trace_mcp_tokens');
        expect(scenario).toHaveProperty('reduction_pct');
        expect(scenario.baseline_tokens).toBeGreaterThanOrEqual(scenario.trace_mcp_tokens);
      }

      expect(result.totals.total_queries).toBeGreaterThan(0);
      expect(result.totals.baseline_tokens).toBeGreaterThan(0);
      expect(result.totals.reduction_pct).toBeGreaterThan(0);
      expect(result.totals.estimated_cost_saved_per_query).toHaveProperty('claude-opus-4-6');
    });

    it('produces deterministic results with same seed', () => {
      const r1 = runBenchmark(store, { queries: 3, seed: 123 });
      const r2 = runBenchmark(store, { queries: 3, seed: 123 });

      expect(r1.totals.baseline_tokens).toBe(r2.totals.baseline_tokens);
      expect(r1.totals.trace_mcp_tokens).toBe(r2.totals.trace_mcp_tokens);
    });
  });

  describe('formatBenchmarkMarkdown', () => {
    it('produces valid markdown', () => {
      const result = runBenchmark(store, { queries: 2, seed: 42, projectName: 'md-test', frameworks: ['express'] });
      const md = formatBenchmarkMarkdown(result);

      expect(md).toContain('## trace-mcp Token Efficiency Benchmark');
      expect(md).toContain('md-test');
      expect(md).toContain('Frameworks: express');
      expect(md).toContain('| Scenario |');
      expect(md).toContain('| **Total**');
    });

    it('omits frameworks line when none', () => {
      const result = runBenchmark(store, { queries: 2, seed: 42, projectName: 'no-fw' });
      const md = formatBenchmarkMarkdown(result);
      expect(md).not.toContain('Frameworks:');
    });
  });
});
