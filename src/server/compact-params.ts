/**
 * Core parameters per tool for compact_schemas mode.
 *
 * When compact_schemas is enabled, only parameters listed here are kept
 * in the tool schema exposed to clients. Advanced/optional parameters
 * are stripped from the schema but still accepted at runtime (the handler
 * receives them as normal — only the JSON Schema definition is trimmed).
 *
 * Tools NOT listed here keep all their parameters unchanged — which is why
 * `tool-schema-budget.test.ts` fails when an always-on tool with 3+ params has
 * no entry here. Coverage silently decayed to 61/141 tools once already
 * (TRA-346), which is what made `compact_schemas` deliver 30% instead of the
 * documented 40-60%.
 *
 * Tools with ≤2 parameters are exempt: there is nothing meaningful to strip.
 * Required params must always be listed — stripping one hides a parameter the
 * handler cannot run without.
 */
export const COMPACT_CORE_PARAMS: Record<string, string[]> = {
  // Navigation
  search: ['query', 'kind', 'file_pattern', 'limit', 'fuzzy', 'fusion'],
  get_symbol: ['symbol_id', 'fqn'],
  get_change_impact: ['file_path', 'symbol_id', 'symbol_ids', 'depth'],
  get_context_bundle: ['symbol_id', 'symbol_ids', 'fqn', 'token_budget'],
  get_task_context: ['task', 'focus'],
  find_usages: ['symbol_id', 'fqn', 'file_path'],
  get_call_graph: ['symbol_id', 'fqn', 'depth'],
  get_feature_context: ['description', 'token_budget'],

  // Analysis
  get_complexity_report: ['file_path', 'limit'],
  get_coupling: ['limit'],
  get_dead_code: ['file_pattern'],
  detect_antipatterns: ['file_pattern'],
  scan_code_smells: ['scope', 'category', 'limit'],
  get_dataflow: ['symbol_id', 'fqn'],
  get_control_flow: ['symbol_id', 'fqn'],
  graph_query: ['query', 'depth'],
  check_duplication: ['name', 'kind', 'symbol_id'],
  get_untested_symbols: ['file_pattern', 'scope', 'level', 'max_results'],
  get_complexity_trend: ['file_path'],
  get_coupling_trend: ['file_path', 'since_days'],
  get_symbol_complexity_trend: ['symbol_id'],

  // Git
  get_git_churn: ['file_pattern', 'since_days', 'limit'],
  get_co_changes: ['file', 'limit'],
  get_changed_symbols: ['since', 'until'],
  compare_branches: ['branch', 'base'],

  // Refactoring
  check_rename: ['symbol_id', 'target_name'],
  apply_rename: ['symbol_id', 'new_name', 'dry_run'],
  apply_move: ['symbol_id', 'source_file', 'target_file', 'new_path', 'dry_run'],
  change_signature: ['symbol_id', 'changes', 'dry_run'],
  plan_refactoring: ['type', 'symbol_id', 'target_file', 'changes'],
  // Ungated meta-tool — invisible to the coverage guard until TRA-402 taught
  // the capture harness about `_originalTool`. `task` is the only param that
  // isn't a tuning knob.
  plan_turn: ['task'],
  extract_function: ['file_path', 'start_line', 'end_line', 'function_name', 'dry_run'],
  apply_codemod: ['pattern', 'replacement', 'file_pattern', 'dry_run'],
  remove_dead_code: ['symbol_id', 'dry_run'],
  pack_context: ['scope', 'path', 'query', 'max_tokens'],

  // Quality
  scan_security: ['scope', 'rules'],
  check_quality_gates: ['scope'],
  taint_analysis: ['scope'],
  export_security_context: ['scope', 'depth'],
  audit_config: [],

  // Framework
  get_request_flow: ['url', 'method'],
  get_component_tree: ['component_path', 'depth'],
  get_tests_for: ['symbol_id', 'fqn', 'file_path'],

  // Advanced / Topology
  get_workspace_map: [],
  assess_change_risk: ['file_path', 'symbol_id'],
  predict_bugs: ['file_pattern'],
  get_risk_hotspots: ['limit'],
  plan_batch_change: ['package', 'from_version', 'to_version'],
  get_project_health: [],
  benchmark_project: [],

  // Session / Memory
  add_decision: ['title', 'content', 'type', 'symbol_id', 'file_path', 'tags'],
  query_decisions: ['search', 'type', 'symbol_id', 'file_path', 'limit'],

  // Graph / topology
  visualize_graph: ['scope', 'granularity', 'output'],
  traverse_graph: ['start_symbol_id', 'start_file_path', 'direction', 'max_depth'],
  get_dependency_diagram: ['scope', 'depth'],
  get_graph_timeline: ['since_days', 'granularity'],
  get_edge_bottlenecks: ['top_n'],
  export_graph: ['format'],
  get_domain_map: ['depth'],
  get_domain_context: ['domain', 'token_budget'],
  get_package_deps: ['package', 'project'],
  get_api_surface: ['file_pattern'],

  // Navigation / inspection
  get_outline: ['path', 'detail_level', 'nested'],
  search_text: ['query', 'file_pattern', 'is_regex', 'grouping'],
  get_pagerank: ['limit'],
  get_refactor_candidates: ['limit', 'min_cyclomatic'],
  detect_ast_clones: ['file_pattern', 'min_loc'],
  get_env_vars: ['pattern', 'file'],
  get_artifacts: ['category', 'query'],
  check_edit_safe: ['file_path', 'symbol_id'],
  check_architecture: ['preset'],
  check_claudemd_drift: [],
  generate_docs: ['scope', 'path'],
  generate_sbom: ['format'],
  analyze_perf: ['tool', 'window'],

  // Health / trends
  get_file_health_timeline: ['file_path', 'since_days'],
  get_health_trends: ['file_path', 'module'],
  get_session_snapshot: [],
  reindex: ['path', 'force'],

  // Decisions / memory
  remember_decision: ['title', 'content', 'type', 'symbol_id', 'file_path', 'tags'],
  get_wake_up: ['scope', 'max_decisions'],
  get_decision_clusters: ['search', 'limit'],
  get_cluster_decisions: ['id'],
  get_decision_timeline: ['symbol_id', 'file_path'],
  export_decisions: ['format', 'type', 'limit'],
  consolidate_decisions: ['dry_run'],
  build_decision_clusters: ['dry_run'],
  tune_decision_weights: ['dry_run'],
  mine_sessions: ['force'],
  regenerate_project_memo: ['force'],
  discover_hermes_sessions: ['profile', 'limit'],

  // Corpora / pins / projects
  build_corpus: ['name', 'scope', 'module_path', 'feature_query'],
  query_corpus: ['name', 'question', 'mode'],
  search_bundles: ['query', 'kind'],
  pin: ['symbol_id', 'file_path'],
  call_project_tool: ['project', 'tool', 'args'],

  // SKILL.state
  trace_state_init: ['task_id', 'goal'],
  trace_state_patch: ['task_id', 'patch'],
  trace_state_get: ['task_id'],
  trace_state_checkpoint: ['task_id', 'label'],
  trace_state_rollback: ['task_id', 'checkpoint'],
  trace_state_add_dead_end: ['task_id', 'reason'],
  trace_state_list: [],
};
