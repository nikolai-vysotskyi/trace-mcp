/**
 * Behavioural coverage for the `get_complexity_report` MCP tool. The handler
 * lives inline in `src/tools/register/git.ts` and runs a parametrised SQL query
 * against the symbols+files tables. These tests exercise the same query shape
 * directly against an in-memory Store so we can pin output contract (rows
 * carry symbol_id/name/kind/file/line/cyclomatic/max_nesting/param_count),
 * sort_by, min_cyclomatic, file_path, and limit semantics.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { createTestStore } from '../../test-utils.js';

interface ComplexityRow {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  cyclomatic: number | null;
  max_nesting: number | null;
  param_count: number | null;
}

interface ReportOpts {
  file_path?: string;
  min_cyclomatic?: number;
  limit?: number;
  sort_by?: 'cyclomatic' | 'nesting' | 'params';
}

// Mirrors the inline handler in src/tools/register/git.ts so behavioural tests
// stay in sync with the SQL contract — see git.ts:573 for the canonical shape.
function complexityReport(
  store: Store,
  opts: ReportOpts = {},
): {
  symbols: ComplexityRow[];
  total: number;
} {
  const sortCol =
    opts.sort_by === 'nesting'
      ? 's.max_nesting'
      : opts.sort_by === 'params'
        ? 's.param_count'
        : 's.cyclomatic';
  const threshold = opts.min_cyclomatic ?? (opts.file_path ? 1 : 5);
  const maxRows = opts.limit ?? 30;

  const conditions = ['s.cyclomatic IS NOT NULL', 's.cyclomatic >= ?'];
  const params: unknown[] = [threshold];
  if (opts.file_path) {
    conditions.push('f.path = ?');
    params.push(opts.file_path);
  }
  params.push(maxRows);

  const rows = store.db
    .prepare(`
      SELECT s.symbol_id, s.name, s.kind, f.path as file, s.line_start as line,
             s.cyclomatic, s.max_nesting, s.param_count
      FROM symbols s JOIN files f ON s.file_id = f.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${sortCol} DESC
      LIMIT ?
    `)
    .all(...params) as ComplexityRow[];
  return { symbols: rows, total: rows.length };
}

function seed(store: Store): void {
  const fA = store.insertFile('src/complex.ts', 'typescript', 'h-a', 1000);
  store.insertSymbol(fA, {
    symbolId: 'src/complex.ts::hairy#function',
    name: 'hairy',
    kind: 'function',
    fqn: 'hairy',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 20,
    signature: 'function hairy(a, b, c)',
    metadata: { cyclomatic: 12, max_nesting: 5, param_count: 3 },
  });
  store.insertSymbol(fA, {
    symbolId: 'src/complex.ts::nested#function',
    name: 'nested',
    kind: 'function',
    fqn: 'nested',
    byteStart: 110,
    byteEnd: 200,
    lineStart: 25,
    lineEnd: 50,
    signature: 'function nested()',
    metadata: { cyclomatic: 4, max_nesting: 9, param_count: 0 },
  });
  store.insertSymbol(fA, {
    symbolId: 'src/complex.ts::manyArgs#function',
    name: 'manyArgs',
    kind: 'function',
    fqn: 'manyArgs',
    byteStart: 210,
    byteEnd: 280,
    lineStart: 55,
    lineEnd: 60,
    signature: 'function manyArgs(a, b, c, d, e, f, g)',
    metadata: { cyclomatic: 7, max_nesting: 2, param_count: 7 },
  });
  store.insertSymbol(fA, {
    symbolId: 'src/complex.ts::trivial#function',
    name: 'trivial',
    kind: 'function',
    fqn: 'trivial',
    byteStart: 290,
    byteEnd: 320,
    lineStart: 62,
    lineEnd: 64,
    signature: 'function trivial()',
    metadata: { cyclomatic: 1, max_nesting: 0, param_count: 0 },
  });

  // Second file so project-wide queries have something cross-file
  const fB = store.insertFile('src/other.ts', 'typescript', 'h-b', 500);
  store.insertSymbol(fB, {
    symbolId: 'src/other.ts::midRisk#function',
    name: 'midRisk',
    kind: 'function',
    fqn: 'midRisk',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 15,
    signature: 'function midRisk(a, b)',
    metadata: { cyclomatic: 8, max_nesting: 3, param_count: 2 },
  });
}

describe('get_complexity_report — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seed(store);
  });

  it('file-level: returns symbols with cyclomatic / max_nesting / param_count', () => {
    const { symbols, total } = complexityReport(store, { file_path: 'src/complex.ts' });
    expect(total).toBe(symbols.length);
    expect(total).toBeGreaterThan(0);
    for (const row of symbols) {
      expect(typeof row.symbol_id).toBe('string');
      expect(typeof row.name).toBe('string');
      expect(typeof row.kind).toBe('string');
      expect(row.file).toBe('src/complex.ts');
      expect(typeof row.cyclomatic).toBe('number');
      expect(typeof row.max_nesting).toBe('number');
      expect(typeof row.param_count).toBe('number');
    }
  });

  it('project-level (no file_path) returns top-complex symbols with cyclomatic >= 5 default', () => {
    const { symbols } = complexityReport(store, {});
    expect(symbols.length).toBeGreaterThan(0);
    for (const row of symbols) {
      expect(row.cyclomatic!).toBeGreaterThanOrEqual(5);
    }
    // 'trivial' has cyclomatic 1 — must NOT appear at project scope (default threshold 5)
    expect(symbols.map((s) => s.name)).not.toContain('trivial');
  });

  it("sort_by='cyclomatic' orders rows by cyclomatic descending", () => {
    const { symbols } = complexityReport(store, { sort_by: 'cyclomatic' });
    expect(symbols.length).toBeGreaterThan(1);
    for (let i = 1; i < symbols.length; i++) {
      expect(symbols[i - 1].cyclomatic!).toBeGreaterThanOrEqual(symbols[i].cyclomatic!);
    }
  });

  it("sort_by='nesting' orders rows by max_nesting descending", () => {
    const { symbols } = complexityReport(store, {
      file_path: 'src/complex.ts',
      sort_by: 'nesting',
    });
    expect(symbols.length).toBeGreaterThan(1);
    // 'nested' has the highest max_nesting in the fixture (9)
    expect(symbols[0].name).toBe('nested');
    for (let i = 1; i < symbols.length; i++) {
      expect(symbols[i - 1].max_nesting!).toBeGreaterThanOrEqual(symbols[i].max_nesting!);
    }
  });

  it("sort_by='params' orders rows by param_count descending", () => {
    const { symbols } = complexityReport(store, {
      file_path: 'src/complex.ts',
      sort_by: 'params',
    });
    // 'manyArgs' has 7 params, highest in fixture
    expect(symbols[0].name).toBe('manyArgs');
  });

  it('min_cyclomatic filter excludes simpler symbols', () => {
    const { symbols } = complexityReport(store, {
      file_path: 'src/complex.ts',
      min_cyclomatic: 10,
    });
    expect(symbols.map((s) => s.name)).toEqual(['hairy']); // only one with cyclomatic >= 10
  });

  it('limit caps the number of returned rows', () => {
    const { symbols, total } = complexityReport(store, {
      file_path: 'src/complex.ts',
      limit: 2,
    });
    expect(symbols.length).toBeLessThanOrEqual(2);
    expect(total).toBe(symbols.length);
  });
});
