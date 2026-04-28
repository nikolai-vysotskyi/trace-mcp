/**
 * Pass 2: Resolve Obsidian-style wikilinks and markdown links between notes.
 *
 * Pass 1 (MarkdownLanguagePlugin) emits one `note` symbol per markdown file
 * with `fqn = note:<basename>` and stores the file's wikilinks / mdLinks /
 * aliases / block refs in the symbol's metadata JSON. Here we walk those
 * notes, build basename + alias lookup maps, and insert `references` (or
 * `embeds` for `![[X]]`) edges to the matching note or section symbol.
 *
 * Resolution is case-insensitive and Unicode-NFC-normalised — Obsidian
 * treats `[[Foo]]`, `[[foo]]`, and `[[Fóo]]` (NFC vs NFD) as the same
 * target.
 */

import { logger } from '../../logger.js';
import type { RawEdge } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';
import {
  type MdLinkRef,
  normalizeKey,
  type WikilinkRef,
} from '../plugins/language/markdown/index.js';

interface NoteRow {
  symbol_id: string;
  fqn: string | null;
  metadata: string | null;
}

interface SectionRow {
  symbol_id: string;
  fqn: string | null;
}

interface ParsedNoteMeta {
  aliases?: string[];
  wikilinks?: WikilinkRef[];
  mdLinks?: MdLinkRef[];
}

const MD_EXT_RE = /\.(md|mdx|markdown)(?:#.*)?$/i;

function basenameOfPath(p: string): string {
  const noFragment = p.split('#')[0];
  const last = noFragment.split('/').pop() ?? noFragment;
  return last.replace(/\.(md|mdx|markdown)$/i, '');
}

export function resolveMarkdownWikilinkEdges(
  state: PipelineState,
  storeRawEdges: (edges: RawEdge[]) => void,
): void {
  const { store } = state;

  const noteRows = store.db
    .prepare(
      `SELECT symbol_id, fqn, metadata
       FROM symbols
       WHERE kind = 'namespace' AND fqn LIKE 'note:%'`,
    )
    .all() as NoteRow[];

  if (noteRows.length === 0) return;

  // basename + aliases → noteSymbolId. Aliases lose to basenames on collision —
  // matches Obsidian (a literal note name takes precedence over an alias).
  const byKey = new Map<string, string>();
  for (const row of noteRows) {
    if (!row.fqn) continue;
    const basename = row.fqn.slice('note:'.length);
    if (basename) byKey.set(normalizeKey(basename), row.symbol_id);
  }
  for (const row of noteRows) {
    if (!row.metadata) continue;
    let meta: ParsedNoteMeta;
    try {
      meta = JSON.parse(row.metadata) as ParsedNoteMeta;
    } catch {
      continue;
    }
    if (meta.aliases?.length) {
      for (const alias of meta.aliases) {
        const k = normalizeKey(alias);
        if (!byKey.has(k)) byKey.set(k, row.symbol_id);
      }
    }
  }

  // Section lookup: `note:<basename>#<heading>` → section symbolId
  const sectionRows = store.db
    .prepare(
      `SELECT symbol_id, fqn
       FROM symbols
       WHERE kind = 'class' AND fqn LIKE 'note:%#%'`,
    )
    .all() as SectionRow[];
  const sectionByKey = new Map<string, string>();
  for (const row of sectionRows) {
    if (!row.fqn) continue;
    const idx = row.fqn.indexOf('#');
    if (idx < 0) continue;
    const basename = row.fqn.slice('note:'.length, idx);
    const heading = row.fqn.slice(idx + 1);
    if (!basename || !heading) continue;
    const key = `${normalizeKey(basename)}#${normalizeKey(heading)}`;
    sectionByKey.set(key, row.symbol_id);
  }

  const edges: RawEdge[] = [];
  let unresolved = 0;

  function resolveSectionTarget(
    basenameKey: string,
    section: string | undefined,
  ): string | undefined {
    if (!section) return undefined;
    return sectionByKey.get(`${basenameKey}#${normalizeKey(section)}`);
  }

  for (const row of noteRows) {
    if (!row.metadata) continue;
    let meta: ParsedNoteMeta;
    try {
      meta = JSON.parse(row.metadata) as ParsedNoteMeta;
    } catch {
      continue;
    }

    const sourceSymbolId = row.symbol_id;

    if (meta.wikilinks?.length) {
      for (const w of meta.wikilinks) {
        if (!w.target) continue;
        const targetKey = normalizeKey(w.target);
        const noteTargetId = byKey.get(targetKey);
        if (!noteTargetId) {
          unresolved++;
          continue;
        }
        // `[[X#Section]]` → prefer the section symbol when it exists
        const sectionTargetId = resolveSectionTarget(targetKey, w.section);
        const targetSymbolId = sectionTargetId ?? noteTargetId;
        if (targetSymbolId === sourceSymbolId) continue;
        edges.push({
          sourceSymbolId,
          targetSymbolId,
          edgeType: w.embed ? 'embeds' : 'references',
          resolved: true,
          resolution: 'ast_inferred',
          metadata: {
            wikilink: w.target,
            ...(w.alias != null && { alias: w.alias }),
            ...(w.section != null && { section: w.section }),
            ...(w.blockRef != null && { blockRef: w.blockRef }),
            ...(w.embed && { embed: true }),
            ...(sectionTargetId == null && w.section != null && { sectionResolved: false }),
            line: w.line,
          },
        });
      }
    }

    if (meta.mdLinks?.length) {
      for (const link of meta.mdLinks) {
        if (!link.target) continue;
        if (
          link.target.startsWith('http://') ||
          link.target.startsWith('https://') ||
          link.target.startsWith('mailto:') ||
          link.target.startsWith('//')
        ) {
          continue;
        }
        if (!MD_EXT_RE.test(link.target)) continue;
        const targetKey = normalizeKey(basenameOfPath(link.target));
        if (!targetKey) continue;
        const targetSymbolId = byKey.get(targetKey);
        if (!targetSymbolId) {
          unresolved++;
          continue;
        }
        if (targetSymbolId === sourceSymbolId) continue;
        edges.push({
          sourceSymbolId,
          targetSymbolId,
          edgeType: 'references',
          resolved: true,
          resolution: 'ast_inferred',
          metadata: {
            mdLink: link.target,
            text: link.text,
            line: link.line,
          },
        });
      }
    }
  }

  if (edges.length > 0) storeRawEdges(edges);
  if (edges.length > 0 || unresolved > 0) {
    logger.info({ resolved: edges.length, unresolved }, 'Markdown wikilink edges resolved');
  }
}
