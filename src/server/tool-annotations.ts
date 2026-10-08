/**
 * Centralized MCP ToolAnnotations for all trace-mcp tools.
 *
 * These annotations tell clients (and scoring systems like Glama TDQS)
 * about the behavioral characteristics of each tool: read-only vs mutating,
 * destructive vs additive, idempotent vs not, closed vs open world.
 *
 * Tools not listed here get DEFAULT_ANNOTATIONS (read-only, idempotent, closed world).
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

// ── Annotation presets ──────────────────────────────────────────────

/** Pure read from local index / git. No side effects. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Mutates the local index/store but is idempotent (re-running = same state). */
const INDEX_MUTATING: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Mutates source files, non-destructive (additive transformations). */
const FILE_WRITING: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Mutates source files, potentially destructive (can delete/overwrite code). */
const FILE_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** Writes output files (HTML visualizations, docs, SBOM) but doesn't modify source. */
const OUTPUT_WRITING: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Reads from external runtime data (OTLP traces). */
const RUNTIME_READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// ── Per-tool overrides ──────────────────────────────────────────────
// Only tools that differ from DEFAULT_ANNOTATIONS need entries here.

const OVERRIDES: Record<string, ToolAnnotations> = {
  // ── Refactoring: file-destructive ──
  apply_codemod: FILE_DESTRUCTIVE,
  remove_dead_code: FILE_DESTRUCTIVE,

  // ── Refactoring: file-writing (non-destructive) ──
  apply_rename: FILE_WRITING,
  apply_move: FILE_WRITING,
  change_signature: FILE_WRITING,
  extract_function: FILE_WRITING,

  // ── Output generation (writes files but doesn't modify source) ──
  generate_docs: OUTPUT_WRITING,
  generate_sbom: OUTPUT_WRITING,
  visualize_graph: OUTPUT_WRITING,
  visualize_subproject_topology: OUTPUT_WRITING,

  // ── Index / store mutation (idempotent) ──
  reindex: INDEX_MUTATING,
  register_edit: INDEX_MUTATING,
  embed_repo: INDEX_MUTATING,
  subproject_add_repo: INDEX_MUTATING,
  subproject_sync: INDEX_MUTATING,
  invalidate_decision: INDEX_MUTATING,
  approve_decision: INDEX_MUTATING,
  reject_decision: INDEX_MUTATING,
  index_sessions: INDEX_MUTATING,
  mine_sessions: INDEX_MUTATING,
  refresh_co_changes: INDEX_MUTATING,
  detect_communities: INDEX_MUTATING,
  // ── Index / decision-store mutation, defaulted to read-only before
  // TRA-1988: each of these writes the index DB or decisions.db, so on a
  // readonly snapshot handle they failed with SQLITE_READONLY instead of a
  // retryable busy (see SnapshotBackend.mutatingToolName, which keys off
  // this table — a tool that gains a write later is covered without
  // touching that file).
  snapshot_graph: INDEX_MUTATING,
  pin: INDEX_MUTATING,
  unpin: INDEX_MUTATING,
  consolidate_decisions: INDEX_MUTATING,
  build_decision_clusters: INDEX_MUTATING,
  tune_decision_weights: INDEX_MUTATING,
  regenerate_project_memo: INDEX_MUTATING,

  // ── Destructive index repair (deletes data — see its DESTRUCTIVE note) ──
  repair_index: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },

  // ── Store mutation (not idempotent — creates new records) ──
  add_decision: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // Writes a new decision row into decisions.db (see add_decision above).
  remember_decision: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },

  // ── Runtime intelligence (reads external OTLP data) ──
  get_runtime_profile: RUNTIME_READ,
  get_runtime_call_graph: RUNTIME_READ,
  get_endpoint_analytics: RUNTIME_READ,
  get_runtime_deps: RUNTIME_READ,
};

/** Default annotations applied to any tool not in OVERRIDES. */
export const DEFAULT_ANNOTATIONS: ToolAnnotations = READ_ONLY;

/**
 * Look up annotations for a given tool name.
 * Returns tool-specific overrides if defined, otherwise DEFAULT_ANNOTATIONS.
 */
export function getToolAnnotations(toolName: string): ToolAnnotations {
  return OVERRIDES[toolName] ?? DEFAULT_ANNOTATIONS;
}

// ── Worktree scope (GH #1481) ───────────────────────────────────────

/**
 * Where a tool runs in a linked-worktree session that has a branch index (a
 * copy of the canonical index with the branch re-indexed into it, served by
 * a tool-host server rooted at the worktree):
 *
 * - `index`: reads or writes the code index, or the worktree's files —
 *   answered by the branch index.
 * - `session`: reads or writes state that belongs to the session or to the
 *   project rather than to the index — the journal, session/state stores,
 *   decisions, corpora, pins, cross-project calls. Stays on the session's own
 *   server: the copy is rebuilt and thrown away, and its tool host keys
 *   per-project state by the worktree path.
 *
 * The gate reads this when a tool is registered. A tool not listed below is
 * `session`. That is the safe default for a new tool: if it keeps per-project
 * state, the state stays where every other session sees it; if it only reads
 * the index, it answers from the canonical index with `stale_on_branch`
 * flags (correct, just less precise on the branch) until it is added here.
 */
export type ToolStateScope = 'index' | 'session';

export const INDEX_SCOPE: ReadonlySet<string> = new Set<string>([
  // Index reads.
  'assess_change_risk',
  'audit_config',
  'check_architecture',
  'check_claudemd_drift',
  'check_duplication',
  'check_edit_safe',
  'check_quality_gates',
  'check_rename',
  'compare_branches',
  'detect_antipatterns',
  'detect_ast_clones',
  'detect_drift',
  'diff_graph_snapshots',
  'export_graph',
  'export_security_context',
  'find_usages',
  'generate_insights_report',
  'get_api_surface',
  'get_artifacts',
  'get_call_graph',
  'get_change_impact',
  'get_changed_symbols',
  'get_circular_imports',
  'get_co_changes',
  'get_code_owners',
  'get_communities',
  'get_community',
  'get_complexity_report',
  'get_complexity_trend',
  'get_context_bundle',
  'get_control_flow',
  'get_coupling',
  'get_coupling_trend',
  'get_cross_domain_deps',
  'get_cross_workspace_impact',
  'get_dataflow',
  'get_dead_code',
  'get_dependency_diagram',
  'get_diagnostics',
  'get_domain_context',
  'get_domain_map',
  'get_edge_bottlenecks',
  'get_env_vars',
  'get_feature_context',
  'get_file_health_timeline',
  'get_git_churn',
  'get_graph_timeline',
  'get_health_trends',
  'get_implementations',
  'get_import_graph',
  'get_index_health',
  'get_minimal_context',
  'get_outline',
  'get_package_deps',
  'get_pagerank',
  'get_plugin_registry',
  'get_project_health',
  'get_project_map',
  'get_refactor_candidates',
  'get_related_symbols',
  'get_risk_hotspots',
  'get_suggested_questions',
  'get_surprises',
  'get_symbol',
  'get_symbol_complexity_trend',
  'get_symbol_owners',
  'get_task_context',
  'get_tech_debt',
  'get_tests_for',
  'get_type_hierarchy',
  'get_untested_symbols',
  'get_workspace_map',
  'graph_query',
  'list_graph_snapshots',
  'pack_context',
  'plan_batch_change',
  'plan_refactoring',
  'predict_bugs',
  'query_by_intent',
  'scan_code_smells',
  'scan_security',
  'search',
  'search_text',
  'self_audit',
  'suggest_queries',
  'taint_analysis',
  'traverse_graph',
  'verify_docs',
  'verify_index',
  // Index writes: the branch index is the index of this worktree.
  'detect_communities',
  'embed_repo',
  'refresh_co_changes',
  'register_edit',
  'reindex',
  'repair_index',
  'snapshot_graph',
  // Output and source writes, rooted at the worktree.
  'apply_codemod',
  'apply_move',
  'apply_rename',
  'change_signature',
  'extract_function',
  'generate_docs',
  'generate_sbom',
  'remove_dead_code',
  'visualize_graph',
]);

/** The worktree scope of a tool (see `ToolStateScope`; unlisted: `session`). */
export function getToolStateScope(toolName: string): ToolStateScope {
  return INDEX_SCOPE.has(toolName) ? 'index' : 'session';
}
