/**
 * Semantic dedup / consolidation persistence — extracted from `DecisionStore`
 * (Task: god-class decomposition). Backs the `consolidate_decisions` MCP tool:
 *
 *   - `findSimilarDecisions`      — top-K candidates for a subject via FTS5
 *     full-text match + title trigram similarity.
 *   - `applyConsolidationVerdict` — atomic application of one LLM verdict
 *     (merge / replace / invalidate / keep_separate).
 *
 * These two methods need three core decision mutators (`getDecision`,
 * `updateDecision`, `invalidateDecision`) that stay on `DecisionStore`. Rather
 * than pull the whole store in (which would re-close an import cycle), the
 * store injects a tiny `ConsolidationHost` callback surface at construction.
 *
 * `DecisionStore` holds one `ConsolidationOperations` instance and delegates
 * its public methods verbatim — the public API and behavior are unchanged,
 * only the implementation moved.
 */

import type Database from 'better-sqlite3';
import { titleSimilarity } from './decision-clusterer.js';
import { type ConsolidationVerdict, mergeContents, mergeTags } from './decision-consolidator.js';
import type { DecisionRow } from './decision-types.js';

/**
 * The slice of `DecisionStore` that consolidation needs. Injected so this
 * module never imports the store (which would close an import cycle).
 */
export interface ConsolidationHost {
  getDecision(id: number): DecisionRow | undefined;
  updateDecision(id: number, patch: { content?: string; tags?: string[] }): void;
  invalidateDecision(id: number): void;
}

/**
 * Extract FTS5-safe word tokens from a title. Strips punctuation, filters
 * very short / numeric-only tokens, and dedups while preserving order.
 * Returns at most 8 tokens — FTS5 OR-queries with 20+ terms get costly.
 */
export function extractFtsWords(title: string): string[] {
  if (!title) return [];
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

/** Parse a JSON tag column into a bounded string array. Tolerant of malformed input. */
export function parseTagsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string').slice(0, 20);
  } catch {
    return [];
  }
}

export class ConsolidationOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly host: ConsolidationHost,
  ) {}

  /**
   * Return up to `topK` candidates similar to the given subject, sorted by
   * title trigram similarity (descending). Combines:
   *   - FTS5 match on the subject's title words (OR-joined; quoted for
   *     safety against FTS operators in titles)
   *   - same-`type` filter when `same_type_only`
   *   - trigram Jaccard floor (`min_title_similarity`)
   *   - excludes the subject itself, optionally invalidated rows
   *
   * Returns [] when the subject has no FTS-extractable title words and
   * no candidate set can be produced cheaply.
   */
  findSimilarDecisions(opts: {
    subject_id: number;
    topK?: number;
    min_title_similarity?: number;
    same_type_only?: boolean;
    project_root?: string;
    active_only?: boolean;
  }): DecisionRow[] {
    const subject = this.host.getDecision(opts.subject_id);
    if (!subject) return [];

    const topK = Math.max(1, Math.min(opts.topK ?? 5, 50));
    const minSim = Math.max(0, Math.min(opts.min_title_similarity ?? 0.4, 1));
    const sameTypeOnly = opts.same_type_only ?? false;
    const activeOnly = opts.active_only ?? true;
    // Default project scope = the subject's own project. Pass `''` to mean
    // "any project" (rare; mostly for cross-project audits).
    const projectScope = opts.project_root !== undefined ? opts.project_root : subject.project_root;

    // Build the candidate pool. We branch on whether we can produce a
    // useful FTS query — short / punctuation-only titles fall through to
    // a project-wide scan capped at 500 rows.
    const ftsWords = extractFtsWords(subject.title);
    const conditions: string[] = ['d.id <> ?'];
    const params: unknown[] = [subject.id];

    if (projectScope) {
      conditions.push('d.project_root = ?');
      params.push(projectScope);
    }
    if (activeOnly) {
      conditions.push('d.valid_until IS NULL');
    }
    if (sameTypeOnly) {
      conditions.push('d.type = ?');
      params.push(subject.type);
    }

    let pool: DecisionRow[];
    if (ftsWords.length > 0) {
      const ftsQuery = ftsWords.map((w) => `"${w}"`).join(' OR ');
      conditions.push('d.id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?)');
      params.push(ftsQuery);
      const sql = `SELECT d.* FROM decisions d WHERE ${conditions.join(' AND ')} LIMIT 200`;
      pool = this.db.prepare(sql).all(...params) as DecisionRow[];
    } else {
      const sql = `SELECT d.* FROM decisions d WHERE ${conditions.join(' AND ')} ORDER BY d.valid_from DESC LIMIT 500`;
      pool = this.db.prepare(sql).all(...params) as DecisionRow[];
    }

    // Score by trigram similarity to the subject's title.
    const scored = pool
      .map((row) => ({ row, sim: titleSimilarity(subject.title, row.title) }))
      .filter((s) => s.sim >= minSim);
    scored.sort((a, b) => b.sim - a.sim);

    return scored.slice(0, topK).map((s) => s.row);
  }

  /**
   * Atomically apply one consolidation verdict. Returns whether any write
   * happened and which row ids were touched (useful for the MCP response
   * envelope and audit logs).
   *
   * Verdict semantics:
   *   - `keep_separate`        → no-op, applied=false
   *   - `merge_into_existing`  → update existing.content (concat unless
   *     `merged_content` is provided), union tags, invalidate subject
   *   - `replace_existing`     → invalidate existing, subject untouched
   *   - `invalidate_existing`  → invalidate existing only
   *
   * Runs in a single transaction so a mid-flight failure rolls back
   * cleanly. Returns `applied:false` when either row is missing or already
   * invalidated (defensive — the LLM may pick a row that was just
   * invalidated by a prior verdict in the same batch).
   */
  applyConsolidationVerdict(opts: {
    subject_id: number;
    verdict: ConsolidationVerdict;
    /** Optional: caller-supplied merged content. If absent, plain concat. */
    merged_content?: string;
  }): { applied: boolean; affected_ids: number[] } {
    if (opts.verdict.kind === 'keep_separate') {
      return { applied: false, affected_ids: [] };
    }

    const tx = this.db.transaction(() => {
      const subject = this.host.getDecision(opts.subject_id);
      if (!subject) return { applied: false, affected_ids: [] as number[] };

      const existingId =
        opts.verdict.kind === 'merge_into_existing' ||
        opts.verdict.kind === 'replace_existing' ||
        opts.verdict.kind === 'invalidate_existing'
          ? opts.verdict.existing_id
          : null;

      const existing = existingId !== null ? this.host.getDecision(existingId) : null;
      if (!existing) return { applied: false, affected_ids: [] as number[] };

      // Refuse to act on a row whose validity window has already closed.
      // A prior verdict may have invalidated it earlier in this batch.
      if (existing.valid_until !== null) {
        return { applied: false, affected_ids: [] as number[] };
      }

      switch (opts.verdict.kind) {
        case 'merge_into_existing': {
          if (subject.valid_until !== null) {
            // Subject already invalidated — nothing left to merge.
            return { applied: false, affected_ids: [] as number[] };
          }
          const mergedContent =
            opts.merged_content ?? mergeContents(existing.content, subject.content);
          const mergedTagsArr = mergeTags(
            parseTagsJson(existing.tags),
            parseTagsJson(subject.tags),
          );
          this.host.updateDecision(existing.id, {
            content: mergedContent,
            tags: mergedTagsArr,
          });
          this.host.invalidateDecision(subject.id);
          return { applied: true, affected_ids: [existing.id, subject.id] };
        }
        case 'replace_existing': {
          this.host.invalidateDecision(existing.id);
          return { applied: true, affected_ids: [existing.id] };
        }
        case 'invalidate_existing': {
          this.host.invalidateDecision(existing.id);
          return { applied: true, affected_ids: [existing.id] };
        }
        default:
          return { applied: false, affected_ids: [] as number[] };
      }
    });

    return tx();
  }
}
