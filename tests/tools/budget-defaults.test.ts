/**
 * Tests for budget-driven auto-defaults.
 *
 * Coverage:
 *  - Level computation thresholds (none/info/warning/critical)
 *  - Auto-default firing only at warning+ for warning rules
 *  - Critical rule overrides warning rule (stricter cap wins)
 *  - User-set explicit values that are already conservative are respected
 *  - User-set explicit values that are MORE expensive get capped
 *  - Tools with no rules return empty
 *  - Returned `applied` records carry param + forced value + reason
 */
import { describe, it, expect } from 'vitest';
import { applyBudgetDefaults, computeBudgetLevel } from '../../src/server/budget-defaults.js';

describe('computeBudgetLevel', () => {
  it.each([
    [0, 0, 'none'],
    [10, 10_000, 'none'],
    [15, 0, 'info'],
    [0, 50_000, 'info'],
    [30, 0, 'warning'],
    [0, 100_000, 'warning'],
    [50, 0, 'critical'],
    [0, 200_000, 'critical'],
    [60, 250_000, 'critical'],
  ])('calls=%i tokens=%i → %s', (calls, tokens, expected) => {
    expect(computeBudgetLevel(calls, tokens)).toBe(expected);
  });
});

describe('applyBudgetDefaults', () => {
  it('returns [] for none/info levels', () => {
    expect(applyBudgetDefaults('get_project_map', {}, 'none')).toEqual([]);
    expect(applyBudgetDefaults('get_project_map', {}, 'info')).toEqual([]);
  });

  it('returns [] for unknown tool', () => {
    expect(applyBudgetDefaults('some_other_tool', {}, 'critical')).toEqual([]);
  });

  it('forces summary_only=true on get_project_map at warning', () => {
    const params: Record<string, unknown> = {};
    const applied = applyBudgetDefaults('get_project_map', params, 'warning');
    expect(params.summary_only).toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0].param).toBe('summary_only');
    expect(applied[0].forced_value).toBe(true);
    expect(applied[0].reason).toContain('warning');
  });

  it('respects user-set summary_only=true (no-op)', () => {
    const params: Record<string, unknown> = { summary_only: true };
    const applied = applyBudgetDefaults('get_project_map', params, 'critical');
    expect(applied).toHaveLength(0);
  });

  it('caps get_call_graph depth from 5 → 2 at warning', () => {
    const params: Record<string, unknown> = { depth: 5 };
    const applied = applyBudgetDefaults('get_call_graph', params, 'warning');
    expect(params.depth).toBe(2);
    expect(applied[0].forced_value).toBe(2);
  });

  it('caps get_call_graph depth from 5 → 1 at critical', () => {
    const params: Record<string, unknown> = { depth: 5 };
    const applied = applyBudgetDefaults('get_call_graph', params, 'critical');
    expect(params.depth).toBe(1);
    expect(applied[0].forced_value).toBe(1);
  });

  it('does NOT cap get_call_graph depth=1 at critical (already conservative)', () => {
    const params: Record<string, unknown> = { depth: 1 };
    const applied = applyBudgetDefaults('get_call_graph', params, 'critical');
    expect(params.depth).toBe(1);
    expect(applied).toHaveLength(0);
  });

  it('caps get_type_hierarchy max_depth from 10 → 5 at warning', () => {
    const params: Record<string, unknown> = { max_depth: 10 };
    const applied = applyBudgetDefaults('get_type_hierarchy', params, 'warning');
    expect(params.max_depth).toBe(5);
    expect(applied[0].param).toBe('max_depth');
  });

  it('caps get_type_hierarchy max_depth from 10 → 3 at critical', () => {
    const params: Record<string, unknown> = { max_depth: 10 };
    const _applied = applyBudgetDefaults('get_type_hierarchy', params, 'critical');
    expect(params.max_depth).toBe(3);
  });

  it('caps get_dependency_diagram depth at warning + critical', () => {
    const warn: Record<string, unknown> = { depth: 4 };
    expect(applyBudgetDefaults('get_dependency_diagram', warn, 'warning')[0].forced_value).toBe(2);
    expect(warn.depth).toBe(2);

    const crit: Record<string, unknown> = { depth: 4 };
    expect(applyBudgetDefaults('get_dependency_diagram', crit, 'critical')[0].forced_value).toBe(1);
    expect(crit.depth).toBe(1);
  });

  it('warning-only rule does not fire at info level', () => {
    const params: Record<string, unknown> = {};
    const applied = applyBudgetDefaults('get_project_map', params, 'info');
    expect(params.summary_only).toBeUndefined();
    expect(applied).toHaveLength(0);
  });

  it('critical-only rule on get_change_impact fires only at critical', () => {
    const warn: Record<string, unknown> = { depth: 5 };
    expect(applyBudgetDefaults('get_change_impact', warn, 'warning')).toHaveLength(0);
    expect(warn.depth).toBe(5);

    const crit: Record<string, unknown> = { depth: 5 };
    expect(applyBudgetDefaults('get_change_impact', crit, 'critical')[0].forced_value).toBe(2);
  });

  it('applies stricter (critical) cap when both rules would match', () => {
    // At critical, get_call_graph has both warning(2) and critical(1) rules.
    // The critical rule should win: depth → 1.
    const params: Record<string, unknown> = { depth: 10 };
    const applied = applyBudgetDefaults('get_call_graph', params, 'critical');
    expect(params.depth).toBe(1);
    // Only one entry — the warning rule should not double-apply
    expect(applied).toHaveLength(1);
  });
});
