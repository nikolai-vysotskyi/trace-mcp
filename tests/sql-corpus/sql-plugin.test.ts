import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SqlLanguagePlugin } from '../../src/indexer/plugins/language/sql/index.js';
import groundTruth from './brightchamps-ground-truth.json';
import { corpusFile, resolveBrightchampsCorpusRoot } from './resolve-corpus-root.js';

const plugin = new SqlLanguagePlugin();

function cteNames(symbols: Array<{ name: string; metadata?: Record<string, unknown> }>): string[] {
  return symbols
    .filter((s) => s.metadata?.sqlKind === 'cte')
    .map((s) => s.name)
    .sort();
}

describe('SqlLanguagePlugin — AST CTE extraction (Phase 3)', () => {
  const root = resolveBrightchampsCorpusRoot();
  if (!root) {
    it.skip('corpus not found — set TRACE_SQL_CORPUS_ROOT', () => {});
    return;
  }

  for (const fixture of groundTruth.fixtures) {
    it(`${fixture.id}: plugin matches expected CTEs`, async () => {
      const full = corpusFile(fixture.path);
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
    const rel = 'booking_etl_queries/base_ownership.sql';
    const full = corpusFile(rel);
    expect(full).toBeTruthy();
    const result = await plugin.extractSymbols(rel, fs.readFileSync(full!));
    expect(result.isOk()).toBe(true);
    const sym = result.isOk() ? result.value.symbols?.find((s) => s.name === 'scoped') : undefined;
    expect(sym?.metadata?.extractor).toBe('tree-sitter-sql');
    expect(sym?.metadata?.preprocessorApplied).toContain('template_mustache');
  });
});
