/**
 * Adaptive token budget — dynamically scales token budgets based on session state.
 *
 * Instead of static defaults, this module computes an appropriate budget
 * based on how many tokens have already been consumed in the session.
 * As the session progresses and token usage grows, budgets shrink to
 * preserve remaining context window capacity.
 */

interface SessionBudgetState {
  /** Total tool calls made this session */
  totalCalls: number;
  /** Total raw tokens consumed (estimated) */
  totalRawTokens: number;
}

interface AdaptiveBudgetResult {
  /** Recommended token budget */
  budget: number;
  /** Whether budget was reduced from default */
  reduced: boolean;
  /** Explanation of the scaling decision */
  reason: string;
}

/** Default budgets per tool category */
const DEFAULT_BUDGETS: Record<string, number> = {
  get_task_context: 8000,
  get_feature_context: 4000,
  get_context_bundle: 8000,
  pack_context: 50000,
};

/** Minimum budgets — never go below these */
const MIN_BUDGETS: Record<string, number> = {
  get_task_context: 2000,
  get_feature_context: 1000,
  get_context_bundle: 2000,
  pack_context: 10000,
};

/**
 * Compute an adaptive token budget based on session state.
 *
 * Scaling strategy:
 *  - Under 50K raw tokens: full default budget (no reduction)
 *  - 50K–100K: 75% of default
 *  - 100K–200K: 50% of default
 *  - Over 200K: minimum budget
 */
export function computeAdaptiveBudget(
  toolName: string,
  state: SessionBudgetState,
  userBudget?: number,
): AdaptiveBudgetResult {
  // If user explicitly set a budget, respect it
  if (userBudget != null) {
    return { budget: userBudget, reduced: false, reason: 'User-specified budget' };
  }

  const defaultBudget = DEFAULT_BUDGETS[toolName] ?? 8000;
  const minBudget = MIN_BUDGETS[toolName] ?? 2000;
  const tokens = state.totalRawTokens;

  let scale: number;
  let reason: string;

  if (tokens < 50_000) {
    scale = 1.0;
    reason = 'Early session — full budget';
  } else if (tokens < 100_000) {
    scale = 0.75;
    reason = `Mid session (~${Math.round(tokens / 1000)}K tokens used) — budget reduced to 75%`;
  } else if (tokens < 200_000) {
    scale = 0.5;
    reason = `High usage (~${Math.round(tokens / 1000)}K tokens) — budget reduced to 50%`;
  } else {
    scale = 0;
    reason = `Critical usage (~${Math.round(tokens / 1000)}K tokens) — minimum budget`;
  }

  const computed = Math.max(minBudget, Math.round(defaultBudget * scale));

  return {
    budget: computed,
    reduced: computed < defaultBudget,
    reason,
  };
}
