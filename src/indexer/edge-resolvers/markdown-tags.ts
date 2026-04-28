/**
 * Pass 2: Aggregate per-note tag symbols into note → canonical-tag edges.
 *
 * The MarkdownLanguagePlugin emits one `tag:<name>` symbol per note that
 * carries the tag — denormalised but useful for keeping origin metadata
 * (frontmatter vs inline). To make `find_usages` on `tag:foo` return every
 * note carrying that tag, we pick a canonical tag symbol per FQN here and
 * emit a `tagged` edge from each note to that canonical symbol.
 */

import { logger } from '../../logger.js';
import type { RawEdge } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

interface TagSymbolRow {
  id: number;
  symbol_id: string;
  fqn: string | null;
}

interface NoteSymbolRow {
  symbol_id: string;
  metadata: string | null;
}

interface ParsedNoteMeta {
  tags?: string[];
}

export function resolveMarkdownTagEdges(
  state: PipelineState,
  storeRawEdges: (edges: RawEdge[]) => void,
): void {
  const { store } = state;

  const tagRows = store.db
    .prepare(
      `SELECT id, symbol_id, fqn
       FROM symbols
       WHERE kind = 'constant' AND fqn LIKE 'tag:%'
       ORDER BY id ASC`,
    )
    .all() as TagSymbolRow[];

  if (tagRows.length === 0) return;

  // First-seen wins → stable canonical per FQN.
  const canonicalByFqn = new Map<string, string>();
  for (const row of tagRows) {
    if (!row.fqn) continue;
    if (!canonicalByFqn.has(row.fqn)) {
      canonicalByFqn.set(row.fqn, row.symbol_id);
    }
  }

  if (canonicalByFqn.size === 0) return;

  const noteRows = store.db
    .prepare(
      `SELECT symbol_id, metadata
       FROM symbols
       WHERE kind = 'namespace' AND fqn LIKE 'note:%'`,
    )
    .all() as NoteSymbolRow[];

  if (noteRows.length === 0) return;

  const edges: RawEdge[] = [];
  const seen = new Set<string>();

  for (const row of noteRows) {
    if (!row.metadata) continue;
    let meta: ParsedNoteMeta;
    try {
      meta = JSON.parse(row.metadata) as ParsedNoteMeta;
    } catch {
      continue;
    }
    if (!meta.tags?.length) continue;

    for (const tag of meta.tags) {
      const fqn = `tag:${tag}`;
      const targetSymbolId = canonicalByFqn.get(fqn);
      if (!targetSymbolId) continue;
      const dedupeKey = `${row.symbol_id}\0${targetSymbolId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      edges.push({
        sourceSymbolId: row.symbol_id,
        targetSymbolId,
        edgeType: 'tagged',
        resolved: true,
        resolution: 'ast_resolved',
        metadata: { tag },
      });
    }
  }

  if (edges.length > 0) {
    storeRawEdges(edges);
    logger.info({ edges: edges.length, tags: canonicalByFqn.size }, 'Markdown tag edges resolved');
  }
}
