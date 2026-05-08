/** Row type interfaces for all database tables.
 *  Extracted from store.ts to break circular dependencies between Store and repository classes. */

export interface FileRow {
  id: number;
  path: string;
  language: string | null;
  framework_role: string | null;
  status: string;
  content_hash: string | null;
  byte_length: number | null;
  indexed_at: string;
  metadata: string | null;
  workspace: string | null;
  gitignored: number;
  mtime_ms: number | null;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  symbol_id: string;
  name: string;
  kind: string;
  fqn: string | null;
  parent_id: number | null;
  signature: string | null;
  summary: string | null;
  byte_start: number;
  byte_end: number;
  line_start: number | null;
  line_end: number | null;
  metadata: string | null;
}

export interface EdgeRow {
  id: number;
  source_node_id: number;
  target_node_id: number;
  edge_type_id: number;
  resolved: number;
  metadata: string | null;
  is_cross_ws: number;
  resolution_tier: string;
  /**
   * Numeric confidence in [0, 1]. Default seeded from resolution_tier:
   * lsp_resolved → 1.0, ast_resolved → 0.95, ast_inferred → 0.7,
   * text_matched → 0.4. Plugins MAY override on insert when they have a
   * better signal (e.g. spring DI through @Autowired metadata vs heuristic
   * receiver-type lookup).
   */
  confidence: number;
}

export interface RouteRow {
  id: number;
  method: string;
  uri: string;
  name: string | null;
  handler: string | null;
  controller_symbol_id: string | null;
  middleware: string | null;
  metadata: string | null;
  file_id: number | null;
  line: number | null;
}

export interface MigrationRow {
  id: number;
  file_id: number;
  table_name: string;
  operation: string;
  columns: string | null;
  indices: string | null;
  timestamp: string | null;
}

export interface ComponentRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  props: string | null;
  emits: string | null;
  slots: string | null;
  composables: string | null;
  framework: string;
}

export interface OrmModelRow {
  id: number;
  file_id: number;
  name: string;
  orm: string;
  collection_or_table: string | null;
  fields: string | null;
  options: string | null;
  metadata: string | null;
}

export interface OrmAssociationRow {
  id: number;
  source_model_id: number;
  target_model_id: number | null;
  target_model_name: string | null;
  kind: string;
  options: string | null;
  file_id: number | null;
  line: number | null;
}

export interface RnScreenRow {
  id: number;
  file_id: number;
  name: string;
  component_path: string | null;
  navigator_type: string | null;
  options: string | null;
  deep_link: string | null;
  metadata: string | null;
}

export interface EnvVarRow {
  id: number;
  file_id: number;
  key: string;
  value_type: string;
  value_format: string | null;
  comment: string | null;
  quoted: number;
  line: number | null;
}

export interface SymbolWithFilePath extends SymbolRow {
  file_path: string;
}

export interface EdgeTypeRow {
  name: string;
  category: string;
  description: string;
}

export interface IndexStats {
  totalFiles: number;
  totalSymbols: number;
  totalEdges: number;
  totalNodes: number;
  totalRoutes: number;
  totalComponents: number;
  totalMigrations: number;
  partialFiles: number;
  errorFiles: number;
}

export interface GraphSnapshotRow {
  id: number;
  commit_hash: string | null;
  created_at: string;
  snapshot_type: string;
  file_path: string | null;
  data: string;
}

export interface WorkspaceStats {
  workspace: string;
  file_count: number;
  symbol_count: number;
  languages: string | null;
}

export interface CrossWorkspaceEdge {
  id: number;
  edge_type: string;
  source_workspace: string | null;
  source_path: string | null;
  source_symbol: string | null;
  source_kind: string | null;
  target_workspace: string | null;
  target_path: string | null;
  target_symbol: string | null;
  target_kind: string | null;
}

export interface WorkspaceDependency {
  from_workspace: string;
  to_workspace: string;
  edge_count: number;
  edge_types: string;
}
