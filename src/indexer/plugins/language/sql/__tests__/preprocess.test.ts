import { describe, expect, it } from 'vitest';
import {
  normalizePgAtTimeZone,
  normalizePgDistinctOn,
  normalizePgDoubleColonCast,
  normalizePgMaterializedCte,
  normalizePythonFormatBraces,
  preprocessSqlForParse,
} from '../preprocess.js';

describe('preprocessSqlForParse', () => {
  it('substitutes templates and bind params without breaking ::cast', () => {
    const { source, templates, bindParams } = preprocessSqlForParse(
      'SELECT x::date FROM {{SCHEMA_NAME}}.t WHERE id = :run_mode AND ts::timestamptz > :id_list',
    );
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('SCHEMA_NAME');
    expect(bindParams).toEqual(['run_mode', 'id_list']);
    expect(source).toContain('__tpl_schema_name__');
    expect(source).toContain('x::date');
    expect(source).not.toContain('{{SCHEMA_NAME}}');
  });

  it('leaves {{TEMPLATE}} to template pass, not format braces', () => {
    const { source, formatSlots } = normalizePythonFormatBraces('FROM {{SCHEMA_NAME}}.t');
    expect(formatSlots).toHaveLength(0);
    expect(source).toContain('{{SCHEMA_NAME}}');
  });

  it('replaces Python format braces with comments', () => {
    const { source, formatSlots } = normalizePythonFormatBraces(
      'FROM t\n    {pool_date_filter}\nORDER BY 1',
    );
    expect(formatSlots).toHaveLength(1);
    expect(formatSlots[0].name).toBe('pool_date_filter');
    expect(source).toContain('/* __fmt_pool_date_filter__ */');
    expect(source).not.toContain('{pool_date_filter}');
  });

  it('rewrites postfix :: casts to CAST(... AS ...)', () => {
    expect(normalizePgDoubleColonCast('le.parent_id::int')).toBe('CAST(le.parent_id AS int)');
    expect(normalizePgDoubleColonCast('(x)::text')).toBe('CAST((x) AS text)');
  });

  it('strips MATERIALIZED from CTE headers', () => {
    expect(normalizePgMaterializedCte('foo AS MATERIALIZED (')).toBe('foo AS (');
  });

  it('joins DISTINCT and ON across line breaks', () => {
    const split = `SELECT DISTINCT
      ON (student_id, source_id) student_id
    FROM t`;
    const out = normalizePgDistinctOn(split);
    expect(out).toContain('SELECT DISTINCT ON (student_id, source_id)');
    expect(out).not.toMatch(/DISTINCT\s*\n\s*ON/i);
  });

  it('normalizes chained AT TIME ZONE for tree-sitter-sql', () => {
    const inSql =
      "MIN(case when c2.name = 'x' then (c.event_ts AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC' end)";
    const out = normalizePgAtTimeZone(inSql);
    expect(out).not.toMatch(/AT\s+TIME\s+ZONE/i);
    expect(out).toContain('c.event_ts');
  });
});
