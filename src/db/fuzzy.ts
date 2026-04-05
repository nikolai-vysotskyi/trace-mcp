import type Database from 'better-sqlite3';
import { distance as levenshtein } from 'fastest-levenshtein';

// ─── Trigram utilities ─────────────────────────────────────

/** Generate trigrams from a string. E.g. "User" → ["use", "ser"] */
export function generateTrigrams(text: string): string[] {
  const lower = text.toLowerCase();
  if (lower.length < 3) return [lower];
  const trigrams: string[] = [];
  for (let i = 0; i <= lower.length - 3; i++) {
    trigrams.push(lower.substring(i, i + 3));
  }
  return trigrams;
}

/** Jaccard similarity between two trigram sets */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── Schema ────────────────────────────────────────────────

export function createTrigramTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbol_trigrams (
      symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      trigram   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trigrams_tri ON symbol_trigrams(trigram);
    CREATE INDEX IF NOT EXISTS idx_trigrams_sym ON symbol_trigrams(symbol_id);
  `);
}

// ─── Indexing ──────────────────────────────────────────────

/** Insert trigrams for a batch of symbols. Wraps in transaction for performance. */
export function indexTrigramsBatch(
  db: Database.Database,
  symbols: Array<{ id: number; name: string; fqn: string | null }>,
): void {
  if (symbols.length === 0) return;

  const insert = db.prepare(
    'INSERT INTO symbol_trigrams (symbol_id, trigram) VALUES (?, ?)',
  );

  db.transaction(() => {
    for (const sym of symbols) {
      // Generate trigrams from both name and last segment of FQN
      const names = [sym.name];
      if (sym.fqn && sym.fqn !== sym.name) {
        const lastPart = sym.fqn.split(/[\\/.:]/).pop();
        if (lastPart && lastPart !== sym.name) names.push(lastPart);
      }

      const seen = new Set<string>();
      for (const name of names) {
        for (const tri of generateTrigrams(name)) {
          if (!seen.has(tri)) {
            seen.add(tri);
            insert.run(sym.id, tri);
          }
        }
      }
    }
  })();
}

/** Delete trigrams for symbols belonging to a file. */
export function deleteTrigramsByFile(db: Database.Database, fileId: number): void {
  db.prepare(
    'DELETE FROM symbol_trigrams WHERE symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)',
  ).run(fileId);
}

// ─── Fuzzy search ──────────────────────────────────────────

export interface FuzzyMatch {
  symbolId: number;
  symbolIdStr: string;
  name: string;
  fqn: string | null;
  kind: string;
  fileId: number;
  similarity: number;
  editDistance: number;
}

/**
 * Fuzzy search using trigram Jaccard similarity + Levenshtein re-ranking.
 * 1. Generate query trigrams
 * 2. Find symbols sharing trigrams (SQL GROUP BY + HAVING)
 * 3. Compute Jaccard similarity, filter by threshold
 * 4. Re-rank top candidates by Levenshtein distance
 */
export function fuzzySearch(
  db: Database.Database,
  query: string,
  options: {
    threshold?: number;
    maxEditDistance?: number;
    limit?: number;
    kind?: string;
    language?: string;
    filePattern?: string;
  } = {},
): FuzzyMatch[] {
  const {
    threshold = 0.3,
    maxEditDistance = 3,
    limit = 20,
    kind,
    language,
    filePattern,
  } = options;

  const queryTrigrams = generateTrigrams(query);
  if (queryTrigrams.length === 0) return [];

  const queryTrigramSet = new Set(queryTrigrams);

  // Step 1: Find candidate symbols that share at least one trigram with the query.
  // Use a single efficient query that counts shared trigrams per symbol.
  const placeholders = queryTrigrams.map(() => '?').join(',');

  // Build filter conditions
  const filterJoins: string[] = [];
  const filterConditions: string[] = [];
  const filterParams: unknown[] = [];

  if (kind) {
    filterConditions.push('s.kind = ?');
    filterParams.push(kind);
  }
  if (language || filePattern) {
    filterJoins.push('JOIN files f ON f.id = s.file_id');
    if (language) {
      filterConditions.push('f.language = ?');
      filterParams.push(language);
    }
    if (filePattern) {
      filterConditions.push('f.path LIKE ?');
      filterParams.push(`%${filePattern}%`);
    }
  }

  const whereExtra = filterConditions.length > 0
    ? 'AND ' + filterConditions.join(' AND ')
    : '';

  // Fetch candidates with shared trigram count — limits to top 200 by shared count
  const candidateSql = `
    SELECT
      s.id, s.symbol_id, s.name, s.fqn, s.kind, s.file_id,
      COUNT(DISTINCT st.trigram) AS shared_count
    FROM symbol_trigrams st
    JOIN symbols s ON s.id = st.symbol_id
    ${filterJoins.join(' ')}
    WHERE st.trigram IN (${placeholders})
    ${whereExtra}
    GROUP BY s.id
    HAVING shared_count >= 1
    ORDER BY shared_count DESC
    LIMIT 200
  `;

  const params = [...queryTrigrams, ...filterParams];
  const candidates = db.prepare(candidateSql).all(...params) as Array<{
    id: number;
    symbol_id: string;
    name: string;
    fqn: string | null;
    kind: string;
    file_id: number;
    shared_count: number;
  }>;

  if (candidates.length === 0) return [];

  // Step 2: Compute Jaccard similarity and Levenshtein distance
  const queryLower = query.toLowerCase();
  const results: FuzzyMatch[] = [];

  for (const c of candidates) {
    const nameTrigrams = new Set(generateTrigrams(c.name));
    const similarity = jaccardSimilarity(queryTrigramSet, nameTrigrams);

    if (similarity < threshold) continue;

    const editDist = levenshtein(queryLower, c.name.toLowerCase());
    if (editDist > maxEditDistance) continue;

    results.push({
      symbolId: c.id,
      symbolIdStr: c.symbol_id,
      name: c.name,
      fqn: c.fqn,
      kind: c.kind,
      fileId: c.file_id,
      similarity,
      editDistance: editDist,
    });
  }

  // Sort by similarity DESC, then edit distance ASC
  results.sort((a, b) => {
    const simDiff = b.similarity - a.similarity;
    if (Math.abs(simDiff) > 0.01) return simDiff;
    return a.editDistance - b.editDistance;
  });

  return results.slice(0, limit);
}
