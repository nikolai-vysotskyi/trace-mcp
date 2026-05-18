/**
 * Budget-driven auto-defaults for expensive tools.
 *
 * When the session token budget hits warning/critical, we silently cap a small
 * set of "expansive" parameters (graph depth, full project map, etc.) so the
 * agent doesn't keep paying for broad exploration after we've already warned
 * twice. The override is recorded in the response `_meta.budget_defaults` so
 * the agent can see exactly what was forced and why.
 *
 * Rules:
 *  - Only apply when the user did NOT explicitly set the parameter.
 *  - Never override a value that's *more conservative* than the default.
 *  - Skip the AI tool entirely (model selection isn't covered here).
 *  - Token-budget tools (get_task_context / get_feature_context / pack_context /
 *    get_context_bundle) already have `computeAdaptiveBudget` — don't double-cap.
 */

export type BudgetLevel = 'none' | 'info' | 'warning' | 'critical';

interface AutoDefaultRule {
  /** Minimum level at which the rule fires (inclusive) */
  level: 'warning' | 'critical';
  /** Param name on the tool's schema */
  param: string;
  /** Forced value */
  value: unknown;
  /** Predicate: only apply if current value is "more expensive" than `value` */
  isMoreExpensive: (currentValue: unknown) => boolean;
}

const BUDGET_AUTO_DEFAULTS: Record<string, AutoDefaultRule[]> = {
  get_project_map: [
    {
      level: 'warning',
      param: 'summary_only',
      value: true,
      isMoreExpensive: (v) => v !== true,
    },
  ],
  get_call_graph: [
    {
      level: 'warning',
      param: 'depth',
      value: 2,
      isMoreExpensive: (v) => typeof v === 'number' && v > 2,
    },
    {
      level: 'critical',
      param: 'depth',
      value: 1,
      isMoreExpensive: (v) => typeof v === 'number' && v > 1,
    },
  ],
  get_type_hierarchy: [
    {
      level: 'warning',
      param: 'max_depth',
      value: 5,
      isMoreExpensive: (v) => typeof v === 'number' && v > 5,
    },
    {
      level: 'critical',
      param: 'max_depth',
      value: 3,
      isMoreExpensive: (v) => typeof v === 'number' && v > 3,
    },
  ],
  get_dependency_diagram: [
    {
      level: 'warning',
      param: 'depth',
      value: 2,
      isMoreExpensive: (v) => typeof v === 'number' && v > 2,
    },
    {
      level: 'critical',
      param: 'depth',
      value: 1,
      isMoreExpensive: (v) => typeof v === 'number' && v > 1,
    },
  ],
  get_change_impact: [
    {
      level: 'critical',
      param: 'depth',
      value: 2,
      isMoreExpensive: (v) => typeof v === 'number' && v > 2,
    },
  ],
};

/** Compute the current budget level from session totals. Mirrors the rule used by `jh()`. */
export function computeBudgetLevel(totalCalls: number, totalRawTokens: number): BudgetLevel {
  if (totalCalls >= 50 || totalRawTokens >= 200_000) return 'critical';
  if (totalCalls >= 30 || totalRawTokens >= 100_000) return 'warning';
  if (totalCalls >= 15 || totalRawTokens >= 50_000) return 'info';
  return 'none';
}

export interface AppliedDefault {
  param: string;
  forced_value: unknown;
  reason: string;
}

/**
 * Mutate `params` in-place with budget-driven defaults. Returns the list of
 * defaults that were actually applied (empty if none) so the caller can attach
 * them to the response `_meta`.
 */
export function applyBudgetDefaults(
  toolName: string,
  params: Record<string, unknown>,
  level: BudgetLevel,
): AppliedDefault[] {
  if (level === 'none' || level === 'info') return [];
  const rules = BUDGET_AUTO_DEFAULTS[toolName];
  if (!rules) return [];

  // Apply critical rules first so they win over (looser) warning rules for the
  // same param. The `alreadyApplied` guard below then prevents double-capping.
  const ordered = [...rules].sort((a, b) => {
    const rank = (l: 'warning' | 'critical') => (l === 'critical' ? 0 : 1);
    return rank(a.level) - rank(b.level);
  });

  const applied: AppliedDefault[] = [];

  for (const rule of ordered) {
    // Rule fires only if current level >= rule level
    if (rule.level === 'critical' && level !== 'critical') continue;

    const userValue = params[rule.param];

    // Skip if user explicitly set a value that is already at-or-below the cap
    if (userValue !== undefined && !rule.isMoreExpensive(userValue)) continue;

    // Don't double-apply: if a stricter (critical) rule already fired for this
    // param in this call, the looser (warning) rule should not overwrite it.
    const alreadyApplied = applied.find((a) => a.param === rule.param);
    if (alreadyApplied) continue;

    params[rule.param] = rule.value;
    applied.push({
      param: rule.param,
      forced_value: rule.value,
      reason: `Budget ${level}: forced ${rule.param}=${JSON.stringify(rule.value)} to reduce response size`,
    });
  }

  return applied;
}

/**
 * Build the human-readable `_warnings` strings that the tool gate attaches to
 * the top level of a response when:
 *   (a) `applyBudgetDefaults` actually *clamped* a user-requested value, or
 *   (b) the response itself signals truncation (`traverse_graph`'s
 *       `truncated_by_depth / _nodes / _budget` flags).
 *
 * Kept as a pure function — easy to unit-test without spinning up an MCP
 * server. The gate is responsible for calling this and writing the array onto
 * the parsed response object.
 *
 *   - `originalParams` is the snapshot of params *before* `applyBudgetDefaults`
 *     mutated them. Required to report the user's requested value alongside
 *     the forced cap.
 *   - `appliedDefaults` is the list returned by `applyBudgetDefaults`.
 *   - `parsedResponse` is the JSON-parsed response body; we read
 *     `truncated_by_*` flags off it for traverse_graph.
 */
export function buildClampWarnings(
  toolName: string,
  originalParams: Record<string, unknown>,
  appliedDefaults: AppliedDefault[],
  parsedResponse: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];

  // (a) Clamp warnings. Only emit when the user actually requested a *higher*
  // value than the cap; if they didn't pass anything we silently default-cap
  // them, which is not a clamp — just the documented default behavior.
  for (const def of appliedDefaults) {
    const requested = originalParams[def.param];
    if (requested === undefined) continue;
    if (typeof requested !== 'number') continue;
    if (typeof def.forced_value !== 'number') continue;
    if (requested <= def.forced_value) continue;
    warnings.push(
      `${def.param} clamped from ${requested} to ${def.forced_value} to stay within token budget. Pass token_budget: <higher> to expand.`,
    );
  }

  // (b) traverse_graph mirrors its own truncated_by_* fields into `_warnings`
  // so the user sees the truncation cause without digging through individual
  // booleans.
  if (toolName === 'traverse_graph') {
    if (parsedResponse.truncated_by_depth === true) {
      const requestedDepth =
        typeof originalParams.max_depth === 'number' ? originalParams.max_depth : 3;
      warnings.push(
        `Traversal truncated at max_depth=${requestedDepth}. Pass max_depth: <higher> to walk further.`,
      );
    }
    if (parsedResponse.truncated_by_nodes === true) {
      const requestedNodes =
        typeof originalParams.max_nodes === 'number' ? originalParams.max_nodes : 100;
      warnings.push(
        `Result truncated at ${requestedNodes} nodes (max_nodes limit). Pass max_nodes: <higher> to see more.`,
      );
    }
    if (parsedResponse.truncated_by_budget === true) {
      const requestedBudget =
        typeof originalParams.token_budget === 'number' ? originalParams.token_budget : 4000;
      warnings.push(
        `Result truncated by token_budget=${requestedBudget}. Pass token_budget: <higher> to fit more nodes.`,
      );
    }
  }

  return warnings;
}
