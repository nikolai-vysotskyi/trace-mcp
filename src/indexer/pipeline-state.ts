/**
 * Shared state interface for pipeline subsystems (FilePersister, EdgeResolver).
 * Extracted from IndexingPipeline to allow independent modules to access
 * pipeline state without circular dependencies.
 */
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { TraceMcpConfig } from '../config.js';
import type {
  RawSymbol,
  RawEdge,
  RawRoute,
  RawComponent,
  RawMigration,
  RawOrmModel,
  RawOrmAssociation,
  RawRnScreen,
  FileParseResult,
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
