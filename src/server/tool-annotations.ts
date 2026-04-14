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
  index_sessions: INDEX_MUTATING,
  mine_sessions: INDEX_MUTATING,
  refresh_co_changes: INDEX_MUTATING,
  detect_communities: INDEX_MUTATING,

  // ── Store mutation (not idempotent — creates new records) ──
  add_decision: {
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
