import { describe, expect, it } from 'vitest';
import { extractCtesFromTree } from '../ast-extract.js';
import { parseSqlSource } from '../sql-parser.js';

describe('extractCtesFromTree', () => {
  it('uses identifier start line and CTE node end line', async () => {
    const sql = `WITH a AS (
  SELECT 1
), b AS (SELECT 2)`;
    const tree = await parseSqlSource(sql);
    const ctes = extractCtesFromTree(tree.rootNode);
    tree.delete();
    const a = ctes.find((c) => c.name === 'a');
    expect(a?.lineStart).toBe(1);
    expect(a?.lineEnd).toBeGreaterThan(1);
  });

  it('emits separate entries for repeated CTE names (disambiguated at symbol id)', async () => {
    const sql = `WITH x AS (SELECT 1), outer AS (
  WITH x AS (SELECT 2) SELECT * FROM x
) SELECT * FROM outer`;
    const tree = await parseSqlSource(sql);
    const ctes = extractCtesFromTree(tree.rootNode);
    tree.delete();
    expect(ctes.filter((c) => c.name === 'x')).toHaveLength(2);
    expect(ctes.map((c) => c.name).sort()).toEqual(['outer', 'x', 'x']);
  });

  it('records referencesCtes only from relation positions (object_reference)', async () => {
    const sql = `WITH a AS (SELECT 1), b AS (SELECT * FROM a) SELECT * FROM b`;
    const tree = await parseSqlSource(sql);
    const ctes = extractCtesFromTree(tree.rootNode);
    tree.delete();
    expect(ctes.find((c) => c.name === 'a')?.referencesCtes).toEqual([]);
    expect(ctes.find((c) => c.name === 'b')?.referencesCtes).toEqual(['a']);
  });

  it('does not treat selected column names as CTE references', async () => {
    const sql = `WITH a AS (SELECT 1), b AS (SELECT a FROM app.orders) SELECT 1`;
    const tree = await parseSqlSource(sql);
    const ctes = extractCtesFromTree(tree.rootNode);
    tree.delete();
    expect(ctes.find((c) => c.name === 'b')?.referencesCtes).toEqual([]);
  });
});
