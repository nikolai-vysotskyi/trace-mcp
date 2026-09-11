/**
 * Tool presets — predefined subsets of tools to reduce token overhead.
 *
 * Each preset lists tool names to register. 'full' means all tools.
 * Framework-conditional and config-conditional guards still apply on top of presets.
 */

/**
 * The lookup floor: what any code-intelligence surface has to be able to answer
 * regardless of the role it is shaped for (TRA-1162).
 *
 * The five TRA-603 role presets were each written as a standalone list, and
 * three of them — `perf`, `security`, `architecture` — came out unable to call
 * `find_usages` at all. That is the 6th busiest tool in the maintainer's store
 * (821 of 27 394 recorded calls, 3.0%), it is in {@link ALWAYS_LOAD_TOOLS}
 * because the server asks clients to keep it eagerly loaded, and its schema
 * costs 380 tokens. A preset that can find a symbol but not its callers is not
 * a cheaper surface, it is an incomplete one: the tool is one `load_tools`
 * round-trip away either way, so deferring it only pays off in sessions that
 * never ask who calls anything.
 *
 * Deliberately the *cheap* five, not all fifteen of `ALWAYS_LOAD_TOOLS`. The
 * remaining gaps (`get_feature_context`, `get_task_context`,
 * `get_context_bundle`, `get_call_graph`, `get_change_impact`,
 * `suggest_queries`) are each under 160 recorded calls — 0.6% of volume — and
 * closing all of them costs `architecture` 2 024 tokens on every session. The
 * store cannot say whether an *architecture* session wants them, because it
 * does not record which preset a call ran under, so that trade stays unmade
 * rather than guessed. `router` (empty by design, dispatches through `batch`)
 * and `state` (a composable suite, not a standalone surface) opt out.
 *
 * Composing rather than re-listing is what stops the drift coming back.
 * Deduplicated so `listPresets()` keeps reporting a real tool count.
 */
export const NAVIGATION_PRIMITIVES: readonly string[] = [
  'search',
  'search_text',
  'get_outline',
  'get_symbol',
  'find_usages',
];

const withLookupFloor = (roleTools: string[]): string[] => [
  ...new Set([...NAVIGATION_PRIMITIVES, ...roleTools]),
];

export const TOOL_PRESETS: Record<string, string[] | 'all'> = {
  // The router surface (TRA-675): membership is deliberately empty, so a
  // session advertises only UNGATED_META_TOOLS — 10 tools, 1,604 tokens, 95.6%
  // below `full` and 79.2% below the shipped `minimal` default. It is usable
  // rather than crippled because `batch` dispatches any non-excluded tool by
  // name, including ones this preset defers (see the `batch` description), so
  // there is no escalation round-trip: `load_tools()` names the catalog and
  // `batch` calls it. Opt-in, never the default — on a host that already defers
  // tool schemas itself (Claude Code's ToolSearch) it buys ~2.9k tokens while
  // taking away the first-five-minutes tools `ALWAYS_LOAD_TOOLS` protects; on a
  // host without one it buys ~6.2k per session.
  router: [],

  // The default surface (TRA-402). Membership is ALWAYS_LOAD_TOOLS — the
  // first-five-minutes set below — plus the decision-memory quartet. Those two
  // lists used to disagree: `minimal` omitted get_task_context, get_call_graph
  // and get_context_bundle while ALWAYS_LOAD_TOOLS declared them essential, so
  // the smallest preset was missing tools the server was asking clients to keep
  // eagerly loaded. Anything outside this set is one `load_tools` call away.
  minimal: [
    'search',
    'search_text',
    'get_outline',
    'get_symbol',
    'find_usages',
    'get_call_graph',
    'get_change_impact',
    'get_project_map',
    'get_feature_context',
    'get_task_context',
    'get_context_bundle',
    'suggest_queries',
    'get_index_health',
    // register_edit/batch are core infra (every edit-and-reindex loop and
    // every multi-query round-trip needs them) — every non-full preset
    // must carry them, not just 'full'.
    'register_edit',
    'batch',
    // Live decision-memory quartet on the minimal preset:
    //   remember = remember_decision (live agent write into the decision graph)
    //   improve  = mine_sessions     (post-hoc extraction from session logs)
    // Keeping the canonical trace-mcp names rather than introducing alias
    // tools — the quartet semantics are documented via this preset only,
    // so agents working in code-intel mode are not paying tax on four
    // extra registrations.
    'remember_decision',
    'query_decisions',
    'invalidate_decision',
    'mine_sessions',
    'get_diagnostics',
  ],

  standard: [
    // minimal
    'search',
    'search_text',
    'get_outline',
    'get_symbol',
    'find_usages',
    'get_change_impact',
    'get_project_map',
    'get_feature_context',
    'suggest_queries',
    'get_index_health',
    'register_edit',
    'batch',
    // navigation+
    'get_related_symbols',
    'get_context_bundle',
    'get_task_context',
    'get_call_graph',
    'get_tests_for',
    'get_implementations',
    'reindex',
    'get_env_vars',
    'get_changed_symbols',
    // analysis
    'get_dead_code',
    'remove_dead_code',
    'get_circular_imports',
    'get_complexity_report',
    'check_rename',
    'get_coupling',
    'detect_antipatterns',
    'check_duplication',
    'get_control_flow',
    // quality & security (top real-world usage per TRA-3 session mining)
    'check_quality_gates',
    'scan_security',
    'self_audit',
    'apply_codemod',
    // framework (gated further by has())
    'get_request_flow',
    'get_component_tree',
    'get_model_context',
    'get_event_graph',
    'get_schema',
    // predictive
    'predict_bugs',
    'assess_change_risk',
    'get_tech_debt',
    // trends
    'get_complexity_trend',
    'get_coupling_trend',
    'get_symbol_complexity_trend',
    // workspace
    'get_workspace_map',
    // session
    'get_wake_up',
    // Live decision-memory quartet (mirrors minimal preset)
    'remember_decision',
    'query_decisions',
    'invalidate_decision',
    'mine_sessions',
    'get_diagnostics',
  ],

  // SKILL.state agent execution state tracking suite (TRA-596, arXiv:2608.26263)
  state: [
    // Core infra every non-full preset carries: a preset that cannot look a
    // symbol up is not a usable surface on its own (tool-config.test.ts).
    'search',
    'get_symbol',
    'register_edit',
    'batch',
    'trace_state_init',
    'trace_state_patch',
    'trace_state_get',
    'trace_state_checkpoint',
    'trace_state_rollback',
    'trace_state_add_dead_end',
    'trace_state_list',
  ],

  full: 'all',

  review: withLookupFloor([
    'search',
    'search_text',
    'get_symbol',
    'get_outline',
    'get_call_graph',
    'get_change_impact',
    'find_usages',
    'get_context_bundle',
    'get_task_context',
    'get_project_map',
    'get_index_health',
    'get_tests_for',
    'check_rename',
    'check_edit_safe',
    'check_quality_gates',
    'assess_change_risk',
    'get_dead_code',
    'get_complexity_report',
    'detect_antipatterns',
    'get_changed_symbols',
    'get_untested_symbols',
    'get_diagnostics',
    'register_edit',
    'batch',
  ]),

  dev: withLookupFloor([
    'search',
    'search_text',
    'get_outline',
    'get_symbol',
    'find_usages',
    'get_call_graph',
    'get_change_impact',
    'get_project_map',
    'get_index_health',
    'get_feature_context',
    'get_task_context',
    'get_context_bundle',
    'suggest_queries',
    'get_implementations',
    'get_type_hierarchy',
    'get_related_symbols',
    'get_tests_for',
    'get_untested_symbols',
    'get_changed_symbols',
    'apply_rename',
    'remove_dead_code',
    'check_rename',
    'check_edit_safe',
    'apply_codemod',
    'extract_function',
    'apply_move',
    'change_signature',
    'plan_refactoring',
    'check_quality_gates',
    'get_diagnostics',
    'reindex',
    'register_edit',
    'batch',
    'remember_decision',
    'query_decisions',
  ]),

  security: withLookupFloor([
    'search',
    'search_text',
    'get_symbol',
    'get_outline',
    'get_project_map',
    'get_index_health',
    'get_change_impact',
    'get_call_graph',
    'get_context_bundle',
    'get_task_context',
    'scan_security',
    'taint_analysis',
    'export_security_context',
    'generate_sbom',
    'get_package_deps',
    'audit_config',
    'detect_antipatterns',
    'scan_code_smells',
    'get_artifacts',
    'self_audit',
    'get_risk_hotspots',
    'get_env_vars',
    'remember_decision',
    'query_decisions',
    'register_edit',
    'batch',
  ]),

  design: withLookupFloor([
    'search',
    'search_text',
    'get_symbol',
    'get_outline',
    'get_project_map',
    'get_index_health',
    'get_context_bundle',
    'get_feature_context',
    'get_component_tree',
    'get_screen_context',
    'get_navigation_graph',
    'get_state_stores',
    'find_usages',
    'get_related_symbols',
    'get_model_context',
    'register_edit',
    'batch',
  ]),

  perf: withLookupFloor([
    'search',
    'search_text',
    'get_symbol',
    'get_outline',
    'get_project_map',
    'get_index_health',
    'get_change_impact',
    'get_call_graph',
    'get_context_bundle',
    'get_task_context',
    'analyze_perf',
    'benchmark_project',
    'get_complexity_report',
    'get_complexity_trend',
    'get_symbol_complexity_trend',
    'get_coupling_trend',
    'get_risk_hotspots',
    'get_edge_bottlenecks',
    'predict_bugs',
    'get_tech_debt',
    'get_real_savings',
    'get_session_stats',
    'get_session_analytics',
    'get_startup_context_audit',
    'apply_startup_recommendations',
    'rollback_startup_recommendations',
    'get_usage_trends',
    'register_edit',
    'batch',
  ]),

  architecture: withLookupFloor([
    'get_project_map',
    'get_index_health',
    'search',
    'search_text',
    'get_symbol',
    'get_outline',
    'register_edit',
    'batch',
    'get_circular_imports',
    'get_coupling',
    'get_pagerank',
    'check_architecture',
    'get_dead_code',
    'predict_bugs',
    'get_tech_debt',
    'get_risk_hotspots',
    'get_refactor_candidates',
    'detect_antipatterns',
    'get_project_health',
    'self_audit',
    'get_workspace_map',
    'get_cross_workspace_impact',
    'graph_query',
    'get_domain_map',
    'benchmark_project',
    'get_complexity_trend',
    'get_coupling_trend',
    'get_symbol_complexity_trend',
    'get_edge_bottlenecks',
    'generate_insights_report',
    'query_decisions',
    'remember_decision',
  ]),
};

/** Union of all tool names explicitly listed across all defined presets. */
export const ALL_PRESET_TOOLS: ReadonlySet<string> = new Set(
  Object.values(TOOL_PRESETS).flatMap((v) => (Array.isArray(v) ? v : [])),
);

/** Complete set of all known trace-mcp tools (TRA-1063). */
export const ALL_KNOWN_TRACE_TOOLS: ReadonlySet<string> = new Set([
  ...ALL_PRESET_TOOLS,
  'add_decision',
  'analyze_perf',
  'apply_codemod',
  'apply_move',
  'apply_rename',
  'apply_startup_recommendations',
  'approve_decision',
  'assess_change_risk',
  'audit_config',
  'batch',
  'benchmark_project',
  'build_corpus',
  'build_decision_clusters',
  'call_project_tool',
  'change_signature',
  'check_architecture',
  'check_claudemd_drift',
  'check_duplication',
  'check_edit_safe',
  'check_embedding_drift',
  'check_quality_gates',
  'check_rename',
  'compare_branches',
  'consolidate_decisions',
  'delete_corpus',
  'detect_antipatterns',
  'detect_ast_clones',
  'detect_communities',
  'detect_drift',
  'detect_topic_tunnels',
  'diff_graph_snapshots',
  'discover_claude_sessions',
  'discover_hermes_sessions',
  'embed_repo',
  'export_decisions',
  'export_graph',
  'export_security_context',
  'extract_function',
  'find_usages',
  'generate_docs',
  'generate_insights_report',
  'generate_sbom',
  'get_api_contract',
  'get_api_surface',
  'get_artifacts',
  'get_call_graph',
  'get_changed_symbols',
  'get_circular_imports',
  'get_cluster_decisions',
  'get_co_changes',
  'get_code_owners',
  'get_communities',
  'get_community',
  'get_complexity_report',
  'get_complexity_trend',
  'get_component_tree',
  'get_contract_drift',
  'get_contract_versions',
  'get_control_flow',
  'get_coupling',
  'get_coupling_trend',
  'get_coverage_report',
  'get_cross_domain_deps',
  'get_cross_service_impact',
  'get_cross_workspace_impact',
  'get_dataflow',
  'get_dead_code',
  'get_decision',
  'get_decision_clusters',
  'get_decision_stats',
  'get_decision_timeline',
  'get_dependency_diagram',
  'get_di_tree',
  'get_diagnostics',
  'get_domain_context',
  'get_domain_map',
  'get_edge_bottlenecks',
  'get_endpoint_analytics',
  'get_env_vars',
  'get_event_graph',
  'get_federation_impact',
  'get_file_health_timeline',
  'get_git_churn',
  'get_graph_timeline',
  'get_health_trends',
  'get_implementations',
  'get_import_graph',
  'get_index_health',
  'get_livewire_context',
  'get_middleware_chain',
  'get_minimal_context',
  'get_model_context',
  'get_module_graph',
  'get_navigation_graph',
  'get_nova_resource',
  'get_optimization_report',
  'get_package_deps',
  'get_pagerank',
  'get_plugin_registry',
  'get_preset_info',
  'get_project_health',
  'get_project_map',
  'get_real_savings',
  'get_refactor_candidates',
  'get_request_flow',
  'get_risk_hotspots',
  'get_runtime_call_graph',
  'get_runtime_deps',
  'get_runtime_profile',
  'get_schema',
  'get_screen_context',
  'get_service_deps',
  'get_service_map',
  'get_session_analytics',
  'get_session_journal',
  'get_session_snapshot',
  'get_session_stats',
  'get_startup_context_audit',
  'get_state_stores',
  'get_subproject_clients',
  'get_subproject_graph',
  'get_subproject_impact',
  'get_suggested_questions',
  'get_surprises',
  'get_symbol_complexity_trend',
  'get_symbol_owners',
  'get_tech_debt',
  'get_tests_for',
  'get_type_hierarchy',
  'get_untested_symbols',
  'get_usage_trends',
  'get_wake_up',
  'get_workspace_map',
  'graph_query',
  'index_sessions',
  'invalidate_decision',
  'list_bundles',
  'list_corpora',
  'list_graph_snapshots',
  'list_pins',
  'list_projects',
  'load_tools',
  'mine_sessions',
  'pack_context',
  'pin',
  'plan_batch_change',
  'plan_refactoring',
  'plan_turn',
  'predict_bugs',
  'query_by_intent',
  'query_corpus',
  'query_decisions',
  'refresh_co_changes',
  'regenerate_project_memo',
  'register_edit',
  'reindex',
  'reject_decision',
  'remember_decision',
  'remove_dead_code',
  'repair_index',
  'rollback_startup_recommendations',
  'scan_code_smells',
  'scan_security',
  'search_bundles',
  'search_sessions',
  'search_text',
  'self_audit',
  'snapshot_graph',
  'subproject_add_repo',
  'subproject_sync',
  'taint_analysis',
  'trace_state_add_dead_end',
  'trace_state_checkpoint',
  'trace_state_get',
  'trace_state_init',
  'trace_state_list',
  'trace_state_patch',
  'trace_state_rollback',
  'traverse_graph',
  'tune_decision_weights',
  'tune_weights',
  'unpin',
  'verify_docs',
  'verify_index',
  'visualize_graph',
  'visualize_subproject_topology',
]);

/** Resolve a preset by name, returning the tool set or null if unknown. */
export function resolvePreset(name: string): Set<string> | 'all' | null {
  const preset = TOOL_PRESETS[name];
  if (preset === undefined) return null;
  if (preset === 'all') return 'all';
  return new Set(preset);
}

/** Get list of available preset names */
export function listPresets(): { name: string; toolCount: number | 'all' }[] {
  return Object.entries(TOOL_PRESETS).map(([name, tools]) => ({
    name,
    toolCount: tools === 'all' ? 'all' : tools.length,
  }));
}

/**
 * Tools that should bypass Claude Code's ToolSearch deferral and stay
 * eagerly loaded even when the rest of trace-mcp's surface is hidden
 * behind a search step. These get `_meta: { 'anthropic/alwaysLoad': true }`
 * stamped on them in the tool-gate, per
 * https://code.claude.com/docs/en/mcp.
 *
 * Picked to cover the "first-five-minutes" workflow on a fresh task:
 * orient (project map / health), find a thing (search), inspect it
 * (outline, symbol, usages), understand the blast radius (change impact,
 * call graph), and pull context for the broader task (feature/task
 * context, context bundle). `batch` is here because it's how an agent
 * collapses a sequence of these into one round-trip.
 */
export const ALWAYS_LOAD_TOOLS: ReadonlySet<string> = new Set([
  'search',
  'search_text',
  'get_outline',
  'get_symbol',
  'find_usages',
  'get_call_graph',
  'get_change_impact',
  'get_project_map',
  'get_index_health',
  'get_feature_context',
  'get_task_context',
  'get_context_bundle',
  'suggest_queries',
  'register_edit',
  'batch',
]);
