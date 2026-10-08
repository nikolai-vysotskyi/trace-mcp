import { describe, expect, it } from 'vitest';
import {
  ascendFromPyFile,
  extractPathConstants,
  extractPythonSqlLoadRefs,
  resolveToIndexedSqlPath,
} from '../python-sql-loader-paths.js';

describe('extractPythonSqlLoadRefs', () => {
  it('resolves module constants in loader calls', () => {
    const src = `
SQL_FILE = "etl/two_cte_join_sample.sql"
def run():
    read_sql_file(SQL_FILE)
`;
    const refs = extractPythonSqlLoadRefs(src, 'python/etl_runner.py');
    expect(
      refs.some((r) => r.sqlPath === 'etl/two_cte_join_sample.sql' && r.via === 'loader_call'),
    ).toBe(true);
  });

  it('ignores loader calls inside comments', () => {
    const src = `
# read_sql_file("etl/commented.sql")
def run():
    pass
`;
    const refs = extractPythonSqlLoadRefs(src, 'python/etl_runner.py');
    expect(refs).toHaveLength(0);
  });

  it('ignores .sql paths inside string doc literals', () => {
    const src = `
DOC = """
Example: read_sql_file("etl/doc_only.sql")
"""
`;
    const refs = extractPythonSqlLoadRefs(src, 'python/etl_runner.py');
    expect(refs).toHaveLength(0);
  });

  it('captures qualified string literals (and loader calls)', () => {
    const src = 'render_sql_file("ledger/payment_ledger.sql")';
    const refs = extractPythonSqlLoadRefs(src, 'python/etl_runner.py');
    expect(refs.map((r) => r.sqlPath)).toContain('ledger/payment_ledger.sql');
    expect(refs.some((r) => r.via === 'loader_call' && r.callee === 'render_sql_file')).toBe(true);
  });
});

describe('extractPathConstants', () => {
  it('joins ROOT Path chain to a repo-relative .sql path', () => {
    const src = `
ROOT = Path(__file__).resolve().parent.parent
BASE_SQL_PATH = ROOT / "etl"
SAMPLE_SQL_FILE = BASE_SQL_PATH / "two_cte_join_sample.sql"
`;
    const map = extractPathConstants(src, 'python/path_chain_loader.py');
    expect(ascendFromPyFile('python/path_chain_loader.py', 2)).toBe('');
    expect(map.get('SAMPLE_SQL_FILE')).toBe('etl/two_cte_join_sample.sql');
  });
});

describe('resolveToIndexedSqlPath', () => {
  const indexed = new Set(['etl/two_cte_join_sample.sql', 'python/nested/query.sql']);

  it('matches repo-relative paths', () => {
    expect(
      resolveToIndexedSqlPath('etl/two_cte_join_sample.sql', 'python/etl_runner.py', indexed),
    ).toBe('etl/two_cte_join_sample.sql');
  });

  it('resolves relative to the Python file directory', () => {
    expect(resolveToIndexedSqlPath('nested/query.sql', 'python/runner.py', indexed)).toBe(
      'python/nested/query.sql',
    );
  });
});
