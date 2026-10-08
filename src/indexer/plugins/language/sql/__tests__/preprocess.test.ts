import { describe, expect, it } from 'vitest';
import { preprocessSqlForParse } from '../preprocess.js';
import { spikeParseSqlSource } from '../spike-parse.js';

describe('preprocessSqlForParse', () => {
  it('substitutes templates and bind params without breaking ::cast', () => {
    const { source, templates, bindParams } = preprocessSqlForParse(
      'SELECT x::date FROM {{SCHEMA_NAME}}.t WHERE id = :run_mode AND ts::timestamptz > :id_list',
    );
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('SCHEMA_NAME');
    expect(bindParams.sort()).toEqual(['id_list', 'run_mode']);
    expect(source).toContain('__tpl_schema_name__');
    expect(source).toContain('x::date');
    expect(source).not.toContain('{{SCHEMA_NAME}}');
  });

  it('replaces Python format braces with comments', () => {
    const { source, formatSlots } = preprocessSqlForParse(
      'FROM t\n    {pool_date_filter}\nORDER BY 1',
    );
    expect(formatSlots).toHaveLength(1);
    expect(formatSlots[0].name).toBe('pool_date_filter');
    expect(source).toContain('/* __fmt_pool_date_filter__ */');
    expect(source).not.toContain('{pool_date_filter}');
  });

  it('strips MATERIALIZED from CTE headers', () => {
    const { source } = preprocessSqlForParse('WITH foo AS MATERIALIZED (SELECT 1)');
    expect(source).toContain('AS (');
    expect(source).not.toMatch(/AS\s+MATERIALIZED/i);
  });

  it('joins DISTINCT and ON across line breaks', () => {
    const split = `SELECT DISTINCT
      ON (student_id, source_id) student_id
    FROM t`;
    const { source } = preprocessSqlForParse(split);
    expect(source).toContain('SELECT DISTINCT ON (student_id, source_id)');
    expect(source).not.toMatch(/DISTINCT\s*\n\s*ON/i);
  });

  it('normalizes chained AT TIME ZONE for tree-sitter-sql', () => {
    const inSql =
      "MIN(case when c2.name = 'x' then (c.event_ts AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC' end)";
    const { source } = preprocessSqlForParse(inSql);
    expect(source).not.toMatch(/AT\s+TIME\s+ZONE/i);
    expect(source).toContain('c.event_ts');
  });

  it('maps CTE lines back to original when template precedes WITH', async () => {
    const original = `SELECT 1 FROM {{SCHEMA_NAME}}.t;
WITH scoped AS (SELECT 2)
SELECT * FROM scoped`;
    const spike = await spikeParseSqlSource(original);
    const scoped = spike.ctes.find((c) => c.name === 'scoped');
    expect(scoped?.lineStart).toBe(2);
  });
});
