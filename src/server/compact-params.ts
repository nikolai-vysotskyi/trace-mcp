/**
 * Core parameters per tool for compact_schemas mode.
 *
 * When compact_schemas is enabled, only parameters listed here are kept
 * in the tool schema exposed to clients. Advanced/optional parameters
 * are stripped from the schema but still accepted at runtime (the handler
 * receives them as normal — only the JSON Schema definition is trimmed).
 *
 * Tools NOT listed here keep all their parameters unchanged.
 * Tools with ≤2 parameters are not worth compacting.
 */
export const COMPACT_CORE_PARAMS: Record<string, string[]> = {
  // Navigation
  search: ['query', 'kind', 'file_pattern', 'limit', 'fuzzy', 'fusion'],
  get_symbol: ['symbol_id', 'fqn'],
  get_change_impact: ['file_path', 'symbol_id', 'symbol_ids', 'depth'],
  get_context_bundle: ['symbol_id', 'symbol_ids', 'fqn', 'token_budget'],
  get_task_context: ['task', 'focus'],
  find_usages: ['symbol_id', 'fqn', 'kind_filter'],
  get_call_graph: ['symbol_id', 'fqn', 'direction', 'depth'],
  get_feature_context: ['description', 'token_budget'],

  // Analysis
  get_import_graph: ['file_path', 'depth'],
  get_complexity_report: ['file_path', 'symbol_id'],
  get_coupling: ['file_path', 'module_path'],
  get_dead_code: ['file_pattern'],
  get_dead_exports: ['file_pattern'],
  get_circular_imports: ['file_pattern'],
  detect_antipatterns: ['file_pattern'],
  scan_code_smells: ['file_pattern', 'kinds'],
  get_dataflow: ['symbol_id', 'fqn'],
  get_control_flow: ['symbol_id', 'fqn'],
  graph_query: ['query', 'start_symbol'],
  check_duplication: ['name', 'kind', 'file_path'],
  get_untested_symbols: ['file_pattern', 'kind'],
  get_untested_exports: ['file_pattern'],
  detect_communities: ['min_size'],
  get_complexity_trend: ['file_path'],
  get_coupling_trend: ['module_path'],
  get_symbol_complexity_trend: ['symbol_id'],

  // Git
  get_git_churn: ['file_path', 'since', 'limit'],
  get_co_changes: ['file_path', 'symbol_id'],
  get_changed_symbols: ['base', 'head'],
  compare_branches: ['branch', 'base'],
  get_code_owners: ['file_path', 'symbol_id'],

  // Refactoring
  check_rename: ['symbol_id', 'target_name'],
  apply_rename: ['symbol_id', 'new_name', 'dry_run'],
  apply_move: ['symbol_id', 'source_file', 'target_file', 'new_path', 'dry_run'],
  change_signature: ['symbol_id', 'changes', 'dry_run'],
  plan_refactoring: ['type', 'symbol_id', 'target_file', 'changes'],
  extract_function: ['file_path', 'start_line', 'end_line', 'name'],
  apply_codemod: ['pattern', 'replacement', 'file_pattern', 'dry_run'],
  remove_dead_code: ['symbol_id', 'dry_run'],
  pack_context: ['symbol_ids', 'file_paths', 'token_budget'],

  // Quality
  scan_security: ['file_pattern', 'rules'],
  check_quality_gates: ['scope'],
  taint_analysis: ['source_symbol_id', 'file_pattern'],
  export_security_context: ['scope', 'depth'],
  audit_config: [],

  // Framework
  get_request_flow: ['route', 'method'],
  get_component_tree: ['component', 'file_path'],
  get_model_context: ['model', 'file_path'],
  get_event_graph: ['event'],
  get_schema: ['model'],
  get_tests_for: ['symbol_id', 'fqn', 'file_path'],

  // Advanced / Topology
  get_workspace_map: [],
  get_cross_workspace_impact: ['symbol_id', 'file_path'],
  assess_change_risk: ['file_path', 'symbol_id'],
  predict_bugs: ['file_pattern'],
  get_tech_debt: ['module_path'],
  get_risk_hotspots: ['file_pattern'],
  plan_batch_change: ['package', 'from_version', 'to_version'],
  get_project_health: [],
  benchmark_project: [],

  // Session / Memory
  add_decision: ['title', 'rationale', 'scope'],
  query_decisions: ['query', 'scope', 'status'],

  // Batch
  batch: ['calls'],
};
