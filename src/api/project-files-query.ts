/**
 * SQL builder for `GET /api/projects/files` (cli.ts). Pure and side-effect
 * free so contract and integration tests can run the exact query the route
 * uses against a real Store (TRA-1069: sorting by f.mtime_ms DESC NULLS LAST instead
 * of f.indexed_at DESC).
 */

export const CODE_FILTER = `
    AND f.path NOT LIKE '%.md'
    AND f.path NOT LIKE '%.json'
    AND f.path NOT LIKE '%.yaml'
    AND f.path NOT LIKE '%.yml'
    AND f.path NOT LIKE '%.toml'
    AND f.path NOT LIKE '%.txt'
    AND f.path NOT LIKE '%.css'
    AND f.path NOT LIKE '%.html'
    AND f.path NOT LIKE '%.svg'
    AND f.path NOT LIKE '%.lock'
    AND f.path NOT LIKE '%.env%'
    AND f.path NOT LIKE '%package.json'
    AND f.path NOT LIKE '%tsconfig%'
`;

export function buildProjectFilesQuery(
  sortBy: string,
  scope: string,
  limit: number,
): { sql: string; params: unknown[] } {
  // Scope filter: match files by path prefix or glob-like pattern
  let scopeFilter = '';
  const scopeParams: unknown[] = [];
  if (scope) {
    if (scope.includes('*')) {
      // Convert glob to LIKE: src/*.ts → src/%.ts
      scopeFilter = `AND f.path LIKE ?`;
      scopeParams.push(scope.replace(/\*/g, '%'));
    } else if (scope.endsWith('/')) {
      scopeFilter = `AND f.path LIKE ?`;
      scopeParams.push(`%${scope}%`);
    } else {
      // Could be a directory prefix or exact file
      scopeFilter = `AND (f.path LIKE ? OR f.path LIKE ?)`;
      scopeParams.push(`%/${scope}%`, `%${scope}/%`);
    }
  }

  let sql: string;
  if (sortBy === 'isolated') {
    sql = `
      SELECT f.path,
             COUNT(DISTINCT s.id) as symbols,
             0 as edges
      FROM files f
      JOIN symbols s ON s.file_id = f.id
      LEFT JOIN nodes n ON n.ref_id = s.id AND n.node_type = 'symbol'
      LEFT JOIN edges e_out ON e_out.source_node_id = n.id
      LEFT JOIN edges e_in ON e_in.target_node_id = n.id
      WHERE e_out.id IS NULL AND e_in.id IS NULL
      ${CODE_FILTER} ${scopeFilter}
      GROUP BY f.id
      HAVING symbols > 0
      ORDER BY symbols DESC
      LIMIT ?
    `;
  } else if (sortBy === 'edges') {
    sql = `
      SELECT f.path,
             COUNT(DISTINCT s.id) as symbols,
             COUNT(DISTINCT e.id) as edges
      FROM files f
      JOIN symbols s ON s.file_id = f.id
      LEFT JOIN nodes n ON n.ref_id = s.id AND n.node_type = 'symbol'
      LEFT JOIN edges e ON e.source_node_id = n.id OR e.target_node_id = n.id
      WHERE 1=1 ${CODE_FILTER} ${scopeFilter}
      GROUP BY f.id
      ORDER BY edges DESC
      LIMIT ?
    `;
  } else if (sortBy === 'recent') {
    sql = `
      SELECT f.path,
             COUNT(DISTINCT s.id) as symbols,
             0 as edges
      FROM files f
      LEFT JOIN symbols s ON s.file_id = f.id
      WHERE 1=1 ${CODE_FILTER} ${scopeFilter}
      GROUP BY f.id
      ORDER BY f.mtime_ms DESC NULLS LAST
      LIMIT ?
    `;
  } else {
    sql = `
      SELECT f.path,
             COUNT(DISTINCT s.id) as symbols,
             0 as edges
      FROM files f
      LEFT JOIN symbols s ON s.file_id = f.id
      WHERE 1=1 ${CODE_FILTER} ${scopeFilter}
      GROUP BY f.id
      ORDER BY symbols DESC
      LIMIT ?
    `;
  }

  return { sql, params: [...scopeParams, limit] };
}
