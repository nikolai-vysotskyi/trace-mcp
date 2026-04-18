/**
 * Phantom external symbols — synthetic symbol nodes for class names referenced
 * by the project but not indexed (e.g. framework base classes living in vendor/
 * or node_modules/).
 *
 * Without phantoms, `class MyMigration extends Migration` drops the `extends`
 * edge because `Migration` isn't in the project. Every Laravel migration,
 * every Nova resource, every service provider ends up as an isolated island.
 *
 * With phantoms, all N migrations share a single synthetic `Migration` node,
 * clustering them together in the dependency graph without polluting the
 * project's real symbol count (phantoms are flagged via metadata and can be
 * filtered out by tools that only care about project code).
 *
 * Scope: resolver-level helper. Does not modify extraction; phantoms are
 * created on-demand during edge resolution when a class ref fails to resolve
 * against indexed symbols.
 */
import type { PipelineState } from '../pipeline-state.js';

export interface PhantomSymbol {
  id: number;
  symbol_id: string;
  name: string;
  kind: 'class' | 'interface' | 'trait';
  fqn: string;
  file_id: number;
  workspace: string | null;
  node_id: number;
  external: true;
}

const PHANTOM_FILE_PATH_PREFIX = '__external__';

/**
 * Ensures a phantom "external" file exists for a workspace+language combo, and
 * returns its file_id. Safe to call repeatedly — idempotent via INSERT OR IGNORE.
 */
function ensurePhantomFile(
  state: PipelineState,
  workspace: string | null,
  language: string,
): number {
  const { store } = state;
  const path = `${PHANTOM_FILE_PATH_PREFIX}/${workspace ?? '_root'}/${language}.synthetic`;
  const existing = store.getFile(path);
  if (existing) return existing.id;
  return store.insertFile(path, language, '__phantom__', 0, workspace, null);
}

/**
 * Derive a stable "package bucket" identifier from an FQN. Used to group many
 * external imports into a small number of phantom file nodes so the graph
 * clusters descendants rather than fragmenting them into one phantom per class.
 *
 *   Illuminate\Database\Migrations\Migration → Illuminate\Database
 *   Laravel\Nova\Resource                    → Laravel\Nova
 *   React.Component (TS)                     → React
 */
export function packageBucketFor(fqn: string): string {
  if (!fqn) return 'unknown';
  // PHP-style namespace
  if (fqn.includes('\\')) {
    const parts = fqn.split('\\').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}\\${parts[1]}`;
    return parts[0] ?? fqn;
  }
  // TS/JS-style dotted
  if (fqn.includes('.')) {
    const parts = fqn.split('.').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
    return parts[0] ?? fqn;
  }
  return fqn;
}

export class PhantomSymbolFactory {
  private cache = new Map<string, PhantomSymbol>();
  private filesByKey = new Map<string, number>();

  constructor(private state: PipelineState, private language: string) {}

  /**
   * Cache key: workspace-scoped so two workspaces referencing the same class
   * name (e.g. both laravel apps extending `Model`) get distinct phantoms.
   * This preserves the strict workspace-isolation semantics the resolvers use.
   */
  private key(fqn: string, workspace: string | null): string {
    return `${workspace ?? '_root'}::${fqn}`;
  }

  /** Look up an existing phantom without creating one. */
  peek(fqn: string, workspace: string | null): PhantomSymbol | null {
    return this.cache.get(this.key(fqn, workspace)) ?? null;
  }

  /**
   * Get-or-create a phantom symbol for a class-like reference. The returned
   * symbol has a valid node_id and can be used as an edge target immediately.
   */
  ensure(
    fqn: string,
    workspace: string | null,
    kind: 'class' | 'interface' | 'trait' = 'class',
  ): PhantomSymbol {
    const k = this.key(fqn, workspace);
    const cached = this.cache.get(k);
    if (cached) return cached;

    const { store } = this.state;
    const fileKey = `${workspace ?? '_root'}::${this.language}`;
    let fileId = this.filesByKey.get(fileKey);
    if (fileId == null) {
      fileId = ensurePhantomFile(this.state, workspace, this.language);
      this.filesByKey.set(fileKey, fileId);
    }

    // Short name = last segment of FQN (strip namespace/package prefix)
    const shortName =
      fqn.includes('\\') ? fqn.slice(fqn.lastIndexOf('\\') + 1)
        : fqn.includes('.') ? fqn.slice(fqn.lastIndexOf('.') + 1)
          : fqn;

    // Workspace-scoped symbol id: two workspaces referencing the same external
    // class (e.g. both Laravel apps extending `Model`) must have distinct
    // phantom nodes. Without the workspace prefix, `INSERT OR IGNORE` on
    // `symbol_id` collapses them onto a single phantom and every edge points
    // there — visually merging otherwise independent projects.
    const wsPart = workspace ?? '_root';
    const symbolIdStr = `${PHANTOM_FILE_PATH_PREFIX}/${wsPart}::${fqn}#${kind}`;

    // Check if phantom already persisted (e.g. from a prior indexing run)
    const existing = store.db.prepare(
      'SELECT id FROM symbols WHERE symbol_id = ?',
    ).get(symbolIdStr) as { id: number } | undefined;

    let symbolId: number;
    if (existing) {
      symbolId = existing.id;
    } else {
      symbolId = store.insertSymbol(fileId, {
        symbolId: symbolIdStr,
        name: shortName,
        kind,
        fqn,
        signature: `${kind} ${fqn} (external)`,
        byteStart: 0,
        byteEnd: 0,
        lineStart: 1,
        lineEnd: 1,
        metadata: { external: true, source: 'phantom' },
      });
    }

    const nodeId = store.getNodeId('symbol', symbolId) ?? store.createNode('symbol', symbolId);

    const phantom: PhantomSymbol = {
      id: symbolId,
      symbol_id: symbolIdStr,
      name: shortName,
      kind,
      fqn,
      file_id: fileId,
      workspace,
      node_id: nodeId,
      external: true,
    };
    this.cache.set(k, phantom);
    return phantom;
  }
}

export interface PhantomPackageFile {
  id: number;
  path: string;
  node_id: number;
  workspace: string | null;
  bucket: string;
}

/**
 * Factory for phantom *files* that represent external packages (vendor
 * dependencies, framework base libraries). Each bucket (e.g. `Illuminate\Database`)
 * gets one phantom file per workspace. File-level `imports` edges from real
 * project files land on these phantom files, producing clusters of "everything
 * that uses Laravel DB", "everything that uses React", etc. — which reflects
 * how developers actually think about the codebase.
 */
export class PhantomPackageFactory {
  private cache = new Map<string, PhantomPackageFile>();

  constructor(private state: PipelineState, private language: string) {}

  private key(bucket: string, workspace: string | null): string {
    return `${workspace ?? '_root'}::${bucket}`;
  }

  ensure(bucket: string, workspace: string | null): PhantomPackageFile {
    const k = this.key(bucket, workspace);
    const cached = this.cache.get(k);
    if (cached) return cached;

    const { store } = this.state;
    const safe = bucket.replace(/[\\/]/g, '__');
    const path = `${PHANTOM_FILE_PATH_PREFIX}/${workspace ?? '_root'}/pkg/${safe}.synthetic`;

    let fileId: number;
    const existing = store.getFile(path);
    if (existing) {
      fileId = existing.id;
    } else {
      fileId = store.insertFile(path, this.language, '__phantom_pkg__', 0, workspace, null);
    }

    const nodeId = store.getNodeId('file', fileId) ?? store.createNode('file', fileId);

    const entry: PhantomPackageFile = { id: fileId, path, node_id: nodeId, workspace, bucket };
    this.cache.set(k, entry);
    return entry;
  }
}
