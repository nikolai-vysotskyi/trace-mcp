/**
 * Tool presets — predefined subsets of tools to reduce token overhead.
 *
 * Each preset lists tool names to register. 'full' means all tools.
 * Framework-conditional and config-conditional guards still apply on top of presets.
 */

export const TOOL_PRESETS: Record<string, string[] | 'all'> = {
  minimal: [
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
    // navigation+
    'get_related_symbols',
    'get_context_bundle',
    'get_task_context',
    'get_call_graph',
    'get_tests_for',
    'get_implementations',
    'reindex',
    'get_env_vars',
    // analysis
    'get_dead_code',
    'get_circular_imports',
    'get_complexity_report',
    'check_rename',
    'get_coupling',
    'detect_antipatterns',
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
    'get_session_resume',
  ],

  full: 'all',

  review: [
    'search',
    'get_symbol',
    'get_outline',
    'get_call_graph',
    'get_change_impact',
    'find_usages',
    'get_tests_for',
    'check_rename',
    'get_context_bundle',
    'get_task_context',
    'get_project_map',
    'get_index_health',
    'assess_change_risk',
    'get_dead_code',
    'get_complexity_report',
    'detect_antipatterns',
  ],

  architecture: [
    'get_project_map',
    'get_index_health',
    'search',
    'get_outline',
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
  ],
};

/** All known preset names */
type PresetName = keyof typeof TOOL_PRESETS;

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
