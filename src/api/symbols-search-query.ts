/**
 * SQL builder for `GET /api/projects/symbols` (cli.ts). Pure and side-effect
 * free so a contract test can run the exact query the route uses against a
 * real Store, instead of re-typing the SQL string a second time and hoping
 * it stays in lockstep (TRA-1068 was exactly that kind of drift: the route
 * filtered on `s.fqn`, which is NULL for the overwhelming majority of
 * symbols — `s.name` is where the indexer actually puts the searchable name).
 */
export function buildSymbolsSearchQuery(
  query: string,
  kind: string,
  limit: number,
  isolated: boolean,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let sql = isolated
    ? `SELECT s.id, s.name, s.fqn, s.kind, f.path as file_path, s.line_start, s.line_end
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       LEFT JOIN nodes n ON n.ref_id = s.id AND n.node_type = 'symbol'
       LEFT JOIN edges e_out ON e_out.source_node_id = n.id
       LEFT JOIN edges e_in ON e_in.target_node_id = n.id
       WHERE e_out.id IS NULL AND e_in.id IS NULL`
    : `SELECT s.id, s.name, s.fqn, s.kind, f.path as file_path, s.line_start, s.line_end
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE 1=1`;
  if (query) {
    sql += ` AND (s.name LIKE ? OR s.fqn LIKE ?)`;
    params.push(`%${query}%`, `%${query}%`);
  }
  if (kind) {
    sql += ` AND s.kind = ?`;
    params.push(kind);
  }
  sql += ` ORDER BY s.name LIMIT ?`;
  params.push(limit);
  return { sql, params };
}
