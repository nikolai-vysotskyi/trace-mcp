import type Database from 'better-sqlite3';
import { distance as levenshtein } from 'fastest-levenshtein';
import { filePatternToLike } from './fts.js';

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

// ─── Indexing ──────────────────────────────────────────────
// TRA-1541: trigram writes are owned by the `symbols_tri_*` sync triggers on
// `symbols` (schema.ts DDL + `ensureNameTriTriggers`), backed by the
// `symbols_name_tri` external-content FTS5 table (1 row per symbol). The two
// functions below are kept as no-op-compatible shims so existing callers
// (and tests driving `insertSymbol` + `fuzzySearch` directly) keep working:
// rows already land in the FTS index via the triggers, and deletes cascade
// through them. The persist path (file-persister.ts) no longer calls either
// — that was the second write per symbol this issue eliminates.

/**
 * No-op shim (TRA-1541). Trigram indexing happens automatically via the
 * `symbols_tri_ai` trigger when symbols are inserted. Kept for API
 * compatibility — callers can simply stop calling it.
 */
export function indexTrigramsBatch(
  _db: Database.Database,
  _symbols: Array<{ id: number; name: string; fqn: string | null }>,
): void {
  // Intentionally empty: trigger-maintained.
}

/** No-op shim (TRA-1541). Deletes cascade via the `symbols_tri_ad` trigger. */
export function deleteTrigramsByFile(_db: Database.Database, _fileId: number): void {
  // Intentionally empty: trigger-maintained.
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
 * Quote one trigram as an FTS5 phrase, doubling embedded quotes. Trigrams
 * are raw 3-char slices of user input, so they can contain FTS5 syntax
 * (`"`, `*`, spaces, unicode) — never interpolate them bare.
 */
function quoteTrigramForMatch(trigram: string): string {
  return `"${trigram.replace(/"/g, '""')}"`;
}

/**
 * Fuzzy search using trigram candidates + Levenshtein re-ranking.
 * 1. Generate query trigrams, OR them into a `symbols_name_tri` MATCH
 *    (TRA-1541; mirrors the old `shared_count >= 1` candidate semantics —
 *    a bare MATCH would AND all trigrams and drop typo'd queries).
 * 2. Compute Jaccard similarity, filter by threshold
 * 3. Re-rank top candidates by Levenshtein distance
 *
 * Queries shorter than 3 chars produce no FTS5 trigram tokens, so they use
 * a LIKE-substring candidate probe instead; the Jaccard + edit-distance
 * gates below are unchanged, so final results match the old behavior.
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
  const { threshold = 0.3, maxEditDistance = 3, limit = 20, kind, language, filePattern } = options;

  // Empty query: generateTrigrams never returns [] so without this the LIKE
  // fallback below would run `LIKE '%%'` — a full scan capped at 200 rows
  // that the gates then filter back to []. Correct result, wasted work.
  if (query.length === 0) return [];

  const queryTrigrams = generateTrigrams(query);

  const queryTrigramSet = new Set(queryTrigrams);

  // Step 1: Find candidate symbols that share at least one trigram with the query.
  // TRA-1541: candidates come from the trigger-maintained symbols_name_tri
  // FTS5 table. The OR-of-trigrams preserves the old `shared_count >= 1`
  // union semantics (a single MATCH phrase would require ALL trigrams and
  // silently drop typo queries like 'getUsrProfile'). Ordering by bm25 rank
  // approximates the old shared_count DESC before the LIMIT 200 cap; the
  // Jaccard + edit-distance gates below make the final cut either way.
  const useLikeFallback = query.length < 3;

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
      filterParams.push(filePatternToLike(filePattern));
    }
  }

  const whereExtra = filterConditions.length > 0 ? `AND ${filterConditions.join(' AND ')}` : '';

  // Fetch candidates — limits to top 200 by rank
  const candidateSql = useLikeFallback
    ? `
    SELECT
      s.id, s.symbol_id, s.name, s.fqn, s.kind, s.file_id
    FROM symbols s
    ${filterJoins.join(' ')}
    WHERE s.name LIKE ? ESCAPE '\\'
    ${whereExtra}
    ORDER BY s.id
    LIMIT 200
  `
    : `
    SELECT
      s.id, s.symbol_id, s.name, s.fqn, s.kind, s.file_id
    FROM symbols_name_tri tri
    JOIN symbols s ON s.id = tri.rowid
    ${filterJoins.join(' ')}
    WHERE symbols_name_tri MATCH ?
    ${whereExtra}
    ORDER BY rank
    LIMIT 200
  `;

  const params = useLikeFallback
    ? [`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, ...filterParams]
    : [[...queryTrigramSet].map(quoteTrigramForMatch).join(' OR '), ...filterParams];
  const candidates = db.prepare(candidateSql).all(...params) as Array<{
    id: number;
    symbol_id: string;
    name: string;
    fqn: string | null;
    kind: string;
    file_id: number;
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
