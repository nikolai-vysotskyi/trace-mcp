/**
 * Capped, data-derived caveat for zero-result responses (TRA-680).
 *
 * `total: 0` is ambiguous: it can mean "this symbol genuinely has no callers", or
 * "the index cannot see them here". An agent that reads the first meaning either
 * states a wrong conclusion or falls back to reading the repo by hand — the
 * multi-thousand-token behaviour this product exists to prevent.
 *
 * The note is derived from what the index actually stored, never from a
 * hand-written table of "languages we know are weak": that would rot every time
 * a resolver improves and would silently lie about languages we have since fixed.
 * Concretely it reads the `resolution_tier` distribution of the call edges the
 * index holds for the target's language, plus the file's freshness.
 *
 * Only usage / caller / impact queries call this — a caveat about call
 * resolution on a file outline or a symbol lookup would be pure noise.
 */

import type { Store } from '../../db/store.js';
import { computeFileFreshness } from '../../scoring/freshness.js';

/**
 * Hard cap on the emitted note. This is a token saving only while it stays much
 * smaller than the fallback it prevents; an advisory that grows is a regression.
 */
export const EMPTY_RESULT_NOTE_MAX_LEN = 140;

/** Tiers where the edge endpoint was actually resolved, not guessed by name. */
const RESOLVED_TIERS = ['scip_resolved', 'lsp_resolved', 'ast_resolved'];

/** Edge kinds whose presence depends on call resolution. */
const CALL_EDGE_TYPES = ['calls', 'references'];

/** Below this resolved share the index cannot back a confident zero. */
const LOW_RESOLUTION_SHARE = 0.5;

/** Fewer call edges than this and the share is noise, not a measurement. */
const MIN_SAMPLE = 20;

export interface CallEdgeResolution {
  total: number;
  resolved: number;
  /** resolved / total, or 0 when the language has no call edges at all. */
  share: number;
}

/**
 * Resolved-edge share of the call edges this index holds for `language`.
 *
 * A call edge is attributed to the language of the file its SOURCE lives in —
 * that is the file whose parse produced the edge, so it is the resolver whose
 * quality the share measures. Sources are symbols for `calls`/`references`, but
 * file nodes appear too, so both node types are mapped back to a file.
 *
 * ponytail: full scan of the call edges, run only on the empty-result path.
 * Add a per-language aggregate table if empty results ever become hot.
 */
export function callEdgeResolution(store: Store, language: string): CallEdgeResolution {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN e.resolution_tier IN (${RESOLVED_TIERS.map(() => '?').join(',')})
                                THEN 1 ELSE 0 END), 0) AS resolved
         FROM edges e
         JOIN edge_types et ON et.id = e.edge_type_id
         JOIN nodes n ON n.id = e.source_node_id
         LEFT JOIN symbols s ON n.node_type = 'symbol' AND s.id = n.ref_id
         JOIN files f ON f.id = CASE n.node_type
                                  WHEN 'symbol' THEN s.file_id
                                  WHEN 'file' THEN n.ref_id
                                END
        WHERE et.name IN (${CALL_EDGE_TYPES.map(() => '?').join(',')})
          AND f.language = ?`,
    )
    .get(...RESOLVED_TIERS, ...CALL_EDGE_TYPES, language) as
    | { total: number; resolved: number }
    | undefined;

  const total = row?.total ?? 0;
  const resolved = row?.resolved ?? 0;
  return { total, resolved, share: total === 0 ? 0 : resolved / total };
}

/** Truncate to the budget rather than letting a long path blow it. */
function cap(text: string): string {
  return text.length <= EMPTY_RESULT_NOTE_MAX_LEN
    ? text
    : `${text.slice(0, EMPTY_RESULT_NOTE_MAX_LEN - 1)}…`;
}

/**
 * Build the note for a zero-result usage/caller/impact response, or `undefined`
 * when the index has no reason to be unsure. `filePath` is the indexed path of
 * the queried target.
 *
 * Checks, first hit wins — one note, never a list:
 *   1. the index is behind the working tree for that file;
 *   2. the target's language has no call edges in this index at all;
 *   3. too few call edges to measure;
 *   4. a low resolved share for that language.
 */
export function buildEmptyResultNote(
  store: Store,
  projectRoot: string,
  filePath: string | undefined,
): string | undefined {
  if (!filePath) return undefined;
  const file = store.getFile(filePath);
  // Not indexed at all — the zero says nothing about the code.
  if (!file)
    return cap(`${filePath} is not in the index; this zero reflects coverage, not the code.`);

  if (computeFileFreshness(projectRoot, file) !== 'fresh') {
    return cap(
      `Index is behind ${file.path} on disk — reindex before reading this zero as "no callers".`,
    );
  }

  const language = file.language;
  if (!language) return undefined;

  const { total, share } = callEdgeResolution(store, language);
  if (total === 0) {
    return cap(
      `No ${language} call edges in this index at all — this zero reflects coverage, not the code.`,
    );
  }
  if (total < MIN_SAMPLE) {
    return cap(
      `Only ${total} ${language} call edges indexed — too few to read this zero as proof of no callers.`,
    );
  }
  if (share < LOW_RESOLUTION_SHARE) {
    const pct = Math.round(share * 100);
    return cap(
      `Only ${pct}% of ${language} call edges here resolve — this zero may be a resolver gap, not absence.`,
    );
  }
  return undefined;
}
