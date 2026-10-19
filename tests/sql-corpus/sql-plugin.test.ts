import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SqlLanguagePlugin } from '../../src/indexer/plugins/language/sql/index.js';
import groundTruth from './fixture-ground-truth.json';
import { fixtureFile } from './fixture-paths.js';

const plugin = new SqlLanguagePlugin();

function cteNames(symbols: Array<{ name: string; metadata?: Record<string, unknown> }>): string[] {
  return symbols
    .filter((s) => s.metadata?.sqlKind === 'cte')
    .map((s) => s.name)
    .sort();
}

describe('SqlLanguagePlugin — AST CTE extraction', () => {
  for (const fixture of groundTruth.fixtures) {
    it(`${fixture.id}: plugin matches expected CTEs`, async () => {
      const full = fixtureFile(fixture.path);
      expect(full).toBeTruthy();
      const result = await plugin.extractSymbols(fixture.path, fs.readFileSync(full!));
      expect(result.isOk()).toBe(true);
      if (result.isErr()) return;
      const names = cteNames(result.value.symbols ?? []);
      const expected = fixture.ctes.map((c) => c.name).sort();
      expect(names).toEqual(expected);

      const expectedStatus = (fixture as { parse_status?: string }).parse_status;
      if (expectedStatus) {
        expect(result.value.status).toBe(expectedStatus);
        const meta = result.value.symbols?.[0]?.metadata as { parseStatus?: string };
        expect(meta?.parseStatus).toBe(expectedStatus);
      }
    });
  }

  it('metadata includes preprocessor pipeline on CTE symbols', async () => {
    const rel = 'etl/two_cte_join_sample.sql';
    const full = fixtureFile(rel);
    expect(full).toBeTruthy();
    const result = await plugin.extractSymbols(rel, fs.readFileSync(full!));
    expect(result.isOk()).toBe(true);
    const sym = result.isOk() ? result.value.symbols?.find((s) => s.name === 'scoped') : undefined;
    expect(sym?.metadata?.extractor).toBe('tree-sitter-sql');
    expect(sym?.metadata?.preprocessorApplied).toContain('template_mustache');
  });
});
