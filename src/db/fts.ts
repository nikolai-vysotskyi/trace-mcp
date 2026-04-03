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

export function searchFts(
  db: Database.Database,
  query: string,
  limit = 20,
  offset = 0,
): FtsResult[] {
  // Escape FTS5 special characters
  const escaped = escapeFtsQuery(query);
  if (!escaped) return [];

  const sql = `
    SELECT
      s.id as symbolId,
      rank as rank,
      s.name,
      s.fqn,
      s.kind,
      s.file_id as fileId,
      s.symbol_id as symbolIdStr
    FROM symbols_fts fts
    JOIN symbols s ON s.id = fts.rowid
    WHERE symbols_fts MATCH ?
    ORDER BY rank
    LIMIT ? OFFSET ?
  `;

  return db.prepare(sql).all(escaped, limit, offset) as FtsResult[];
}

export function escapeFtsQuery(query: string): string {
  // Remove special FTS5 characters, wrap terms in quotes for exact matching
  const cleaned = query.replace(/['"(){}[\]*:^~!@#$%&]/g, ' ').trim();
  if (!cleaned) return '';

  // Split into terms and wrap each in quotes
  const terms = cleaned.split(/\s+/).filter(Boolean);
  return terms.map((t) => `"${t}"`).join(' ');
}
