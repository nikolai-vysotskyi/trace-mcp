import type Database from 'better-sqlite3';

export interface FtsResult {
  symbolId: number;
  rank: number;
  name: string;
  fqn: string | null;
  kind: string;
  fileId: number;
  symbolIdStr: string;
}

export interface FtsFilters {
  kind?: string;
  language?: string;
  filePattern?: string;
}

export function searchFts(
  db: Database.Database,
  query: string,
  limit = 20,
  offset = 0,
  filters?: FtsFilters,
): FtsResult[] {
  // Escape FTS5 special characters
  const escaped = escapeFtsQuery(query);
  if (!escaped) return [];

  const conditions: string[] = ['symbols_fts MATCH ?'];
  const params: unknown[] = [escaped];

  // Push filters into SQL to avoid fetching excess rows
  if (filters?.kind) {
    conditions.push('s.kind = ?');
    params.push(filters.kind);
  }
  if (filters?.language) {
    conditions.push('f.language = ?');
    params.push(filters.language);
  }
  if (filters?.filePattern) {
    conditions.push('f.path LIKE ?');
    params.push(`%${filters.filePattern}%`);
  }

  const needsFileJoin = filters?.language || filters?.filePattern;
  const fileJoin = needsFileJoin ? 'JOIN files f ON f.id = s.file_id' : '';

  // FTS5 columns: name, fqn, signature, summary
  // Weights: name 10x, fqn 5x, signature 3x, summary 1x
  // bm25() returns negative scores (lower = better match)
  const sql = `
    SELECT
      s.id as symbolId,
      bm25(symbols_fts, 10.0, 5.0, 3.0, 1.0) as rank,
      s.name,
      s.fqn,
      s.kind,
      s.file_id as fileId,
      s.symbol_id as symbolIdStr
    FROM symbols_fts fts
    JOIN symbols s ON s.id = fts.rowid
    ${fileJoin}
    WHERE ${conditions.join(' AND ')}
    ORDER BY bm25(symbols_fts, 10.0, 5.0, 3.0, 1.0)
    LIMIT ? OFFSET ?
  `;

  params.push(limit, offset);
  return db.prepare(sql).all(...params) as FtsResult[];
}

export function escapeFtsQuery(query: string): string {
  // Remove special FTS5 characters, then strip boolean keywords that survive as whole words
  const cleaned = query
    .replace(/['"(){}[\]*:^~!@#$%&]/g, ' ')
    .replace(/\b(OR|AND|NOT)\b/gi, ' ')
    .trim();
  if (!cleaned) return '';

  // Split into terms and wrap each in quotes for exact phrase matching
  const terms = cleaned.split(/\s+/).filter(Boolean);
  return terms.map((t) => `"${t}"`).join(' ');
}
