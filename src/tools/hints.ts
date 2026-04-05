/**
 * Next-step hints — contextual suggestions appended to tool responses.
 *
 * Each tool has a hints generator that receives the result and returns 1-3
 * actionable suggestions. Hints are cheap strings — no DB queries, no I/O.
 */

export interface Hint {
  tool: string;
  args?: Record<string, string>;
  why: string;
}

type HintGenerator = (result: unknown) => Hint[];

/** Extract a value from an arbitrary nested object by key path */
function dig(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------------------
// Per-tool hint generators
// ---------------------------------------------------------------------------

const hintGenerators: Record<string, HintGenerator> = {
  get_symbol(r) {
    const hints: Hint[] = [];
    const sid = str(dig(r, 'symbol_id'));
    if (sid) {
      hints.push({ tool: 'get_call_graph', args: { symbol_id: sid }, why: 'See who calls this and what it calls' });
      hints.push({ tool: 'get_change_impact', args: { symbol_id: sid }, why: 'Check what breaks if you change this' });
      hints.push({ tool: 'get_tests_for', args: { symbol_id: sid }, why: 'Find tests covering this symbol' });
    }
    return hints;
  },

  search(r) {
    const hints: Hint[] = [];
    const items = arr(dig(r, 'items'));
    if (items.length > 0) {
      const first = items[0] as Record<string, unknown>;
      const sid = str(first?.symbol_id);
      if (sid) {
        hints.push({ tool: 'get_symbol', args: { symbol_id: sid }, why: 'Read the full source of the top result' });
        hints.push({ tool: 'get_context_bundle', args: { symbol_id: sid }, why: 'Get the symbol + its imports in one call' });
      }
    }
    const total = dig(r, 'total');
    if (typeof total === 'number' && total > 20) {
      hints.push({ tool: 'search', args: { kind: '<specific_kind>' }, why: `${total} results — narrow with kind/language/file_pattern filters` });
    }
    return hints;
  },

  get_outline(r) {
    const hints: Hint[] = [];
    const symbols = arr(r);
    if (symbols.length > 0) {
      const first = symbols[0] as Record<string, unknown>;
      const sid = str(first?.symbol_id);
      if (sid) {
        hints.push({ tool: 'get_symbol', args: { symbol_id: sid }, why: 'Read the source of a specific symbol' });
      }
    }
    return hints;
  },

  get_change_impact(r) {
    const hints: Hint[] = [];
    const deps = arr(dig(r, 'dependents'));
    if (deps.length > 0) {
      hints.push({ tool: 'get_tests_for', args: { symbol_id: '<affected_symbol>' }, why: 'Find tests for affected dependents' });
    }
    hints.push({ tool: 'check_rename_safe', args: { symbol_id: '<symbol>' }, why: 'Verify rename is safe across all usages' });
    return hints;
  },

  get_call_graph(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_change_impact', args: { symbol_id: '<symbol>' }, why: 'See full reverse dependency chain beyond direct callers' });
    const callers = arr(dig(r, 'callers'));
    if (callers.length > 5) {
      hints.push({ tool: 'get_extraction_candidates', args: {}, why: 'High fan-in — check if this is an extraction candidate' });
    }
    return hints;
  },

  find_usages(r) {
    const hints: Hint[] = [];
    const refs = arr(dig(r, 'references'));
    if (refs.length > 0) {
      hints.push({ tool: 'get_change_impact', args: { symbol_id: '<symbol>' }, why: 'See transitive impact beyond direct references' });
      hints.push({ tool: 'get_tests_for', args: { symbol_id: '<symbol>' }, why: 'Find tests covering this symbol' });
    }
    return hints;
  },

  get_request_flow(r) {
    const hints: Hint[] = [];
    const handler = str(dig(r, 'handler', 'symbol_id'));
    if (handler) {
      hints.push({ tool: 'get_symbol', args: { symbol_id: handler }, why: 'Read the controller/handler source' });
      hints.push({ tool: 'get_call_graph', args: { symbol_id: handler }, why: 'See what the handler calls' });
    }
    hints.push({ tool: 'get_middleware_chain', args: { url: '<url>' }, why: 'See middleware applied to this route' });
    return hints;
  },

  get_model_context(r) {
    const hints: Hint[] = [];
    const name = str(dig(r, 'model', 'name')) || str(dig(r, 'name'));
    if (name) {
      hints.push({ tool: 'get_schema', args: { table_name: name.toLowerCase() + 's' }, why: 'See the full DB schema for this model\'s table' });
      hints.push({ tool: 'find_usages', args: { fqn: name }, why: 'Find all places that use this model' });
    }
    return hints;
  },

  get_tests_for(r) {
    const hints: Hint[] = [];
    const tests = arr(dig(r, 'tests'));
    if (tests.length === 0) {
      hints.push({ tool: 'get_symbol', args: { symbol_id: '<symbol>' }, why: 'No tests found — read the source to write tests manually' });
    }
    return hints;
  },

  get_feature_context(r) {
    const hints: Hint[] = [];
    const symbols = arr(dig(r, 'symbols'));
    if (symbols.length > 0) {
      const first = symbols[0] as Record<string, unknown>;
      const sid = str(first?.symbol_id);
      if (sid) {
        hints.push({ tool: 'get_context_bundle', args: { symbol_id: sid }, why: 'Get deeper context for the most relevant symbol' });
        hints.push({ tool: 'get_change_impact', args: { symbol_id: sid }, why: 'Understand impact before making changes' });
      }
    }
    return hints;
  },

  get_task_context(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_change_impact', args: { symbol_id: '<entry_point>' }, why: 'Verify blast radius before starting changes' });
    return hints;
  },

  get_project_map(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'suggest_queries', why: 'Get example queries tailored to this project' });
    hints.push({ tool: 'get_repo_health', why: 'Check code quality metrics and hotspots' });
    return hints;
  },

  get_context_bundle(r) {
    const hints: Hint[] = [];
    const symbols = arr(dig(r, 'symbols'));
    for (const sym of symbols.slice(0, 1)) {
      const sid = str((sym as Record<string, unknown>)?.symbol_id);
      if (sid) {
        hints.push({ tool: 'get_change_impact', args: { symbol_id: sid }, why: 'Check what depends on this before editing' });
        hints.push({ tool: 'get_tests_for', args: { symbol_id: sid }, why: 'Find tests to run after changes' });
      }
    }
    return hints;
  },

  get_component_tree(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_change_impact', args: { file_path: '<component_path>' }, why: 'See what depends on this component' });
    return hints;
  },

  get_event_graph(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_call_graph', args: { symbol_id: '<listener>' }, why: 'Trace what an event listener does' });
    return hints;
  },

  get_module_graph(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_di_tree', args: { service_name: '<provider>' }, why: 'Trace DI dependencies for a specific provider' });
    return hints;
  },

  get_di_tree(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_change_impact', args: { symbol_id: '<service>' }, why: 'See what breaks if you change this service' });
    return hints;
  },

  get_coupling_metrics(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_dependency_cycles', why: 'Find circular dependency chains' });
    hints.push({ tool: 'get_extraction_candidates', why: 'Find functions worth extracting to reduce coupling' });
    return hints;
  },

  get_dependency_cycles(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_layer_violations', why: 'Check if cycles violate architectural layers' });
    return hints;
  },

  get_dead_code(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'remove_dead_code', args: { symbol_id: '<dead_symbol>' }, why: 'Safely remove confirmed dead code' });
    return hints;
  },

  check_rename_safe(r) {
    const hints: Hint[] = [];
    const safe = dig(r, 'safe');
    if (safe === true) {
      hints.push({ tool: 'apply_rename', args: { symbol_id: '<symbol>', new_name: '<name>' }, why: 'Rename is safe — apply it' });
    }
    return hints;
  },

  get_repo_health(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_hotspots', why: 'Find files with highest churn + complexity' });
    hints.push({ tool: 'get_dead_code', why: 'Find and clean up unreachable code' });
    return hints;
  },

  get_hotspots(r) {
    const hints: Hint[] = [];
    const files = arr(r);
    if (files.length > 0) {
      const first = files[0] as Record<string, unknown>;
      const fp = str(first?.file);
      if (fp) {
        hints.push({ tool: 'get_outline', args: { path: fp }, why: 'Examine the highest-churn file' });
        hints.push({ tool: 'get_change_impact', args: { file_path: fp }, why: 'See blast radius for the hotspot file' });
      }
    }
    return hints;
  },

  get_livewire_context(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_event_graph', why: 'See Livewire event dispatches and listeners' });
    return hints;
  },

  get_schema(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_model_context', args: { model_name: '<ModelName>' }, why: 'See ORM model relationships for a table' });
    return hints;
  },

  graph_query(r) {
    const hints: Hint[] = [];
    const nodes = arr(dig(r, 'nodes'));
    if (nodes.length > 0) {
      hints.push({ tool: 'get_change_impact', args: { symbol_id: '<node>' }, why: 'Analyze impact for a graph result node' });
    }
    return hints;
  },

  detect_antipatterns(r) {
    const hints: Hint[] = [];
    const findings = arr(dig(r, 'findings'));
    if (findings.length > 0) {
      const first = findings[0] as Record<string, unknown>;
      const modelName = str(first?.model);
      if (modelName) {
        hints.push({ tool: 'get_model_context', args: { model_name: modelName }, why: 'See full context for the flagged model' });
      }
      const related = arr(first?.related_symbols);
      if (related.length > 0) {
        hints.push({ tool: 'get_call_graph', args: { symbol_id: str(related[0]) }, why: 'Trace the call path that triggers the antipattern' });
      }
    }
    hints.push({ tool: 'scan_security', args: { rules: '["all"]' }, why: 'Also check for security vulnerabilities' });
    return hints;
  },

  scan_code_smells(r) {
    const hints: Hint[] = [];
    const summary = dig(r, 'summary') as Record<string, number> | undefined;
    if (summary?.empty_function) {
      hints.push({ tool: 'get_dead_code', why: 'Empty functions may also be dead code — cross-check with dead code analysis' });
    }
    if (summary?.todo_comment) {
      hints.push({ tool: 'get_tech_debt', why: 'See overall tech debt score for modules with many TODOs' });
    }
    if (summary?.hardcoded_value) {
      hints.push({ tool: 'scan_security', args: { rules: '["hardcoded_secrets"]' }, why: 'Some hardcoded values may be security-sensitive' });
    }
    return hints;
  },

  get_page_rank(r) {
    const hints: Hint[] = [];
    const ranked = arr(r);
    if (ranked.length > 0) {
      const first = ranked[0] as Record<string, unknown>;
      const sid = str(first?.symbol_id);
      if (sid) {
        hints.push({ tool: 'get_symbol', args: { symbol_id: sid }, why: 'Read the most important symbol in the codebase' });
      }
    }
    return hints;
  },

  batch(r) {
    const hints: Hint[] = [];
    const results = arr(dig(r, 'batch_results'));
    if (results.length > 0) {
      hints.push({ tool: 'get_session_stats', args: {}, why: 'Check token savings from this batch vs individual calls' });
    }
    return hints;
  },

  get_optimization_report(r) {
    const hints: Hint[] = [];
    const opts = arr(dig(r, 'optimizations'));
    const hasRepeated = opts.some((o) => str((o as Record<string, unknown>)?.rule) === 'repeated-file-read');
    if (hasRepeated) {
      hints.push({ tool: 'get_outline', args: { path: '<frequently_read_file>' }, why: 'Use get_outline + get_symbol instead of repeated full-file reads' });
    }
    hints.push({ tool: 'get_real_savings', args: { period: 'today' }, why: 'See actual per-file token savings breakdown' });
    return hints;
  },

  get_real_savings(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_session_stats', args: {}, why: 'See per-tool call counts and savings for this session' });
    return hints;
  },

  get_session_stats(r) {
    const hints: Hint[] = [];
    hints.push({ tool: 'get_optimization_report', args: { period: 'today' }, why: 'Find specific waste patterns to fix' });
    return hints;
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate contextual hints for a tool response.
 * Returns up to `max` hints (default 3). Zero-cost if no generator is registered.
 */
export function getHints(toolName: string, result: unknown, max = 3): Hint[] {
  const gen = hintGenerators[toolName];
  if (!gen) return [];
  try {
    return gen(result).slice(0, max);
  } catch {
    // Hints are best-effort — never break a tool response
    return [];
  }
}

/**
 * Wrap a tool result object with hints. Returns a new object with `_hints` key.
 * If no hints are available, returns the original object unchanged.
 */
export function withHints(toolName: string, result: unknown): unknown {
  const hints = getHints(toolName, result);
  if (hints.length === 0) return result;

  // For primitive/array results, wrap in an object
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { data: result, _hints: hints };
  }

  return { ...(result as Record<string, unknown>), _hints: hints };
}
