import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SQL_PREPROCESSOR_PIPELINE } from '../../src/indexer/plugins/language/sql/sql-index-metadata.js';
import { SqlLanguagePlugin } from '../../src/indexer/plugins/language/sql/index.js';
import { corpusFile, resolveBrightchampsCorpusRoot } from './resolve-corpus-root.js';

const plugin = new SqlLanguagePlugin();

type CteMeta = {
  sqlKind?: string;
  parseStatus?: string;
  hasError?: boolean;
  extractor?: string;
  preprocessorApplied?: string[];
  templates?: Array<{ name: string }>;
  bindParams?: string[];
  relationRefs?: unknown[];
};

function cteMeta(
  symbols: Array<{ name: string; metadata?: Record<string, unknown> }>,
  name: string,
): CteMeta {
  const sym = symbols.find((s) => s.name === name);
  expect(sym).toBeTruthy();
  return sym!.metadata as CteMeta;
}

describe('SqlLanguagePlugin — persisted metadata contract', () => {
  const root = resolveBrightchampsCorpusRoot();
  if (!root) {
    it.skip('corpus not found — set TRACE_SQL_CORPUS_ROOT', () => {});
    return;
  }

  it('base_ownership: ok AST file metadata on every CTE symbol', async () => {
    const rel = 'booking_etl_queries/base_ownership.sql';
    const result = await plugin.extractSymbols(rel, fs.readFileSync(corpusFile(rel)!));
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.status).toBe('ok');
    const symbols = result.value.symbols ?? [];
    const scoped = symbols.find((s) => s.name === 'scoped');
    const empAge = symbols.find((s) => s.name === 'emp_age');
    expect(scoped?.lineStart).toBeLessThan(scoped?.lineEnd ?? 0);
    expect(empAge?.lineStart).toBeLessThan(empAge?.lineEnd ?? 0);

    for (const name of ['scoped', 'emp_age']) {
      const m = cteMeta(symbols, name);
      expect(m.sqlKind).toBe('cte');
      expect(m.parseStatus).toBe('ok');
      expect(m.hasError).toBe(false);
      expect(m.extractor).toBe('tree-sitter-sql');
      expect(m.preprocessorApplied).toEqual([...SQL_PREPROCESSOR_PIPELINE]);
      expect(m.templates?.map((t) => t.name)).toContain('SCHEMA_NAME');
      expect(m.bindParams).toEqual(expect.arrayContaining(['run_mode', 'id_list']));
      expect(Array.isArray(m.relationRefs)).toBe(true);
    }
  });

  it('row_calls_rigor_unnest: partial parse_status on file and CTEs', async () => {
    const rel = 'Rigor Queries/calls_task_queries/row_calls_rigor_template.sql';
    const result = await plugin.extractSymbols(rel, fs.readFileSync(corpusFile(rel)!));
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.status).toBe('partial');
    const m = cteMeta(result.value.symbols ?? [], 'day_order');
    expect(m.parseStatus).toBe('partial');
    expect(m.hasError).toBe(true);
    expect(m.extractor).toBe('tree-sitter-sql');
  });

  it('TRACE_SQL_AST=0 uses regex fallback metadata shape', async () => {
    const prev = process.env.TRACE_SQL_AST;
    process.env.TRACE_SQL_AST = '0';
    try {
      const rel = 'booking_etl_queries/base_ownership.sql';
      const result = await plugin.extractSymbols(rel, fs.readFileSync(corpusFile(rel)!));
      expect(result.isOk()).toBe(true);
      if (result.isErr()) return;
      const names = (result.value.symbols ?? [])
        .filter((s) => (s.metadata as CteMeta)?.sqlKind === 'cte')
        .map((s) => s.name);
      expect(names).toEqual(['scoped']);
      const m = cteMeta(result.value.symbols ?? [], 'scoped');
      expect(m.preprocessorApplied).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.TRACE_SQL_AST;
      else process.env.TRACE_SQL_AST = prev;
    }
  });
});
