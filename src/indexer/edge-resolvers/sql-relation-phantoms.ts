/**
 * Phantom symbols for database relations referenced by `.sql` files (table/view names).
 * One shared node per normalized relation text per workspace.
 */
import type { PipelineState } from '../pipeline-state.js';

const PHANTOM_FILE_PATH_PREFIX = '__external__';

function ensurePhantomFile(state: PipelineState, workspace: string | null): number {
  const { store } = state;
  const path = `${PHANTOM_FILE_PATH_PREFIX}/${workspace ?? '_root'}/sql-relations.synthetic`;
  const existing = store.getFile(path);
  if (existing) return existing.id;
  // Must match phantom skip list in `subproject/reconcile-index.ts` (`__phantom__`).
  return store.insertFile(path, 'sql', '__phantom__', 0, workspace, null);
}

export function normalizeSqlRelationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function sqlRelationPhantomSymbolId(workspace: string | null, relationText: string): string {
  const ws = workspace ?? '_root';
  const norm = normalizeSqlRelationText(relationText);
  return `${PHANTOM_FILE_PATH_PREFIX}/${ws}::sql/relation/${norm}#variable`;
}

export class SqlRelationPhantomFactory {
  private cache = new Map<string, { symbol_id: string; node_id: number }>();

  constructor(private state: PipelineState) {}

  private key(relationText: string, workspace: string | null): string {
    return `${workspace ?? '_root'}::${normalizeSqlRelationText(relationText)}`;
  }

  ensure(relationText: string, workspace: string | null): { symbol_id: string; node_id: number } {
    const k = this.key(relationText, workspace);
    const cached = this.cache.get(k);
    if (cached) return cached;

    const { store } = this.state;
    const norm = normalizeSqlRelationText(relationText);
    const symbolIdStr = sqlRelationPhantomSymbolId(workspace, norm);
    const fileId = ensurePhantomFile(this.state, workspace);

    const existing = store.db
      .prepare('SELECT id FROM symbols WHERE symbol_id = ?')
      .get(symbolIdStr) as { id: number } | undefined;

    let symbolRowId: number;
    if (existing) {
      symbolRowId = existing.id;
    } else {
      const shortName = norm.includes('.') ? norm.slice(norm.lastIndexOf('.') + 1) : norm;
      symbolRowId = store.insertSymbol(fileId, {
        symbolId: symbolIdStr,
        name: shortName,
        kind: 'variable',
        fqn: norm,
        signature: `relation ${norm}`,
        byteStart: 0,
        byteEnd: 0,
        lineStart: 1,
        lineEnd: 1,
        metadata: { external: true, source: 'sql_relation', relation: norm },
      });
    }

    const nodeId =
      store.getNodeId('symbol', symbolRowId) ?? store.createNode('symbol', symbolRowId);
    const entry = { symbol_id: symbolIdStr, node_id: nodeId };
    this.cache.set(k, entry);
    return entry;
  }
}
