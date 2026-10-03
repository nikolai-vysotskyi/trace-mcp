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

  it('keeps one entry per CTE name (matches index symbolId)', async () => {
    const sql = `WITH x AS (SELECT 1), outer AS (
  WITH x AS (SELECT 2) SELECT * FROM x
) SELECT * FROM outer`;
    const tree = await parseSqlSource(sql);
    const ctes = extractCtesFromTree(tree.rootNode);
    tree.delete();
    expect(ctes.map((c) => c.name).sort()).toEqual(['outer', 'x']);
  });
});
