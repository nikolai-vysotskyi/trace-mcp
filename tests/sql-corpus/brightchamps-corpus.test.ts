import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractSqlSymbolsRegex } from '../../src/indexer/plugins/language/sql/sql-regex-config.js';
import groundTruth from './brightchamps-ground-truth.json';
import { corpusFile, resolveBrightchampsCorpusRoot } from './resolve-corpus-root.js';

function extractCteNames(filePath: string, content: Buffer): string[] {
  const result = extractSqlSymbolsRegex(filePath, content);
  if (result.isErr()) throw result.error;
  const symbols = result.value.symbols ?? [];
  return symbols
    .filter((s) => (s.metadata as { sqlKind?: string } | undefined)?.sqlKind === 'cte')
    .map((s) => s.name)
    .sort();
}

describe('brightchamps SQL corpus — regex baseline (v3.34.6 behavior)', () => {
  const root = resolveBrightchampsCorpusRoot();
  if (!root) {
    it.skip('corpus not found — set TRACE_SQL_CORPUS_ROOT', () => {});
    return;
  }

  for (const fixture of groundTruth.fixtures) {
    it(`${fixture.id}: matches documented regex baseline`, () => {
      const full = corpusFile(fixture.path);
      expect(full, `missing ${fixture.path}`).toBeTruthy();
      const content = fs.readFileSync(full!);
      const names = extractCteNames(fixture.path, content);
      const expected = [...fixture.regex_baseline_ctes].sort();
      expect(names).toEqual(expected);
    });
  }
});
