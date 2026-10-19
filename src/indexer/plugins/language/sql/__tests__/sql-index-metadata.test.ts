import { describe, expect, it } from 'vitest';
import {
  buildSqlFileSymbolMetadata,
  relationRefConfidence,
  sqlCteSymbolId,
} from '../sql-index-metadata.js';
import { spikeParseSqlSource } from '../spike-parse.js';

describe('sql-index-metadata', () => {
  it('uses stable CTE symbol ids', () => {
    expect(sqlCteSymbolId('queries/a.sql', 'scoped')).toBe('queries/a.sql::scoped#variable');
  });

  it('classifies template placeholders in relation refs', () => {
    expect(relationRefConfidence('__tpl_schema_name__.records')).toBe('template-dependent');
    expect(relationRefConfidence('app.payments')).toBe('deterministic');
  });

  it('builds file metadata from spike parse', async () => {
    const sql = 'WITH x AS (SELECT 1) SELECT * FROM x';
    const spike = await spikeParseSqlSource(sql);
    const meta = buildSqlFileSymbolMetadata(spike);
    expect(meta.parseStatus).toBe('ok');
    expect(meta.extractor).toBe('tree-sitter-sql');
    expect(meta.preprocessorApplied.length).toBeGreaterThan(0);
    expect(meta.cteCount).toBe(1);
  });
});
