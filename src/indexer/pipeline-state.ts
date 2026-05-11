/**
 * Shared state interface for pipeline subsystems (FilePersister, EdgeResolver).
 * Extracted from IndexingPipeline to allow independent modules to access
 * pipeline state without circular dependencies.
 */

import type { TraceMcpConfig } from '../config.js';
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type {
  FileParseResult,
  RawComponent,
  RawEdge,
  RawMigration,
  RawOrmAssociation,
  RawOrmModel,
  RawRnScreen,
  RawRoute,
  RawSymbol,
} from '../plugin-api/types.js';
import type { GitignoreMatcher } from '../utils/gitignore.js';
import type { WorkspaceInfo } from './monorepo.js';

/** Pre-computed extraction for a single file — no DB writes performed yet. */
export interface FileExtraction {
  relPath: string;
  existingId: number | null;
  hash: string;
  contentSize: number;
  language: string;
  workspace: string | null;
  gitignored: boolean;
  status: string;
  frameworkRole?: string;
  mtimeMs: number | null;
  symbols: RawSymbol[];
  otherEdges: RawEdge[];
  importEdges: { from: string; specifiers: string[]; relPath: string }[];
  routes: RawRoute[];
  components: RawComponent[];
  migrations: RawMigration[];
  ormModels: RawOrmModel[];
  ormAssociations: RawOrmAssociation[];
  rnScreens: RawRnScreen[];
  frameworkExtracts: FileParseResult[];
}

export interface PipelineState {
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly config: TraceMcpConfig;
  readonly rootPath: string;
  readonly workspaces: WorkspaceInfo[];
  readonly isIncremental: boolean;
  readonly changedFileIds: Set<number>;
  readonly pendingImports: Map<number, { from: string; specifiers: string[]; relPath: string }[]>;
  readonly fileContentCache: Map<string, string>;
  readonly gitignore: GitignoreMatcher | undefined;
}

/**
 * Restricts edge resolution to files (and symbols) that actually changed in
 * the current pipeline run. Resolvers that opt into scope-aware mode can
 * filter their candidate SELECTs by `changedFileIds`; resolvers that ignore
 * the scope continue to do full passes (backward-compat).
 *
 * Empty `changedFileIds` + empty new/deleted maps means the run was a no-op
 * (e.g. hash-gate hit on every file) and edge resolution is fully skipped.
 *
 * Constructed via `buildChangeScope(state)` after extract phase. `undefined`
 * is passed to resolvers when no scope information is available
 * (`indexAll(force=true)` or first index) — they fall back to full pass.
 */
export interface ChangeScope {
  /** file_id values that were re-extracted (or newly inserted) in this run. */
  readonly changedFileIds: ReadonlySet<number>;
  /** symbol name → ids: NEW symbols introduced in this run (for phantom-rebind). */
  readonly newSymbolNames: ReadonlyMap<string, ReadonlySet<number>>;
  /** symbol name → ids: DELETED symbols removed in this run (for phantom-unbind). */
  readonly deletedSymbolNames: ReadonlyMap<string, ReadonlySet<number>>;
}
