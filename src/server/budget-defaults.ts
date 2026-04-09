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
