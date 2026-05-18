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
import { describe, expect, it } from 'vitest';
import {
  applyBudgetDefaults,
  buildClampWarnings,
  computeBudgetLevel,
} from '../../src/server/budget-defaults.js';

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

describe('buildClampWarnings — depth clamping visibility', () => {
  it('emits a clamp warning for get_call_graph when user-requested depth is capped', () => {
    // Simulate the same flow the gate runs: snapshot params, then apply.
    const original: Record<string, unknown> = { depth: 5 };
    const params = { ...original };
    const applied = applyBudgetDefaults('get_call_graph', params, 'critical');
    const warnings = buildClampWarnings('get_call_graph', original, applied, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/clamped from 5 to 1/);
    expect(warnings[0]).toContain('token_budget');
  });

  it('emits a clamp warning for get_type_hierarchy when max_depth is capped', () => {
    const original: Record<string, unknown> = { max_depth: 10 };
    const params = { ...original };
    const applied = applyBudgetDefaults('get_type_hierarchy', params, 'critical');
    const warnings = buildClampWarnings('get_type_hierarchy', original, applied, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/max_depth clamped from 10 to 3/);
  });

  it('emits a clamp warning for get_change_impact at critical', () => {
    const original: Record<string, unknown> = { depth: 5 };
    const params = { ...original };
    const applied = applyBudgetDefaults('get_change_impact', params, 'critical');
    const warnings = buildClampWarnings('get_change_impact', original, applied, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/depth clamped from 5 to 2/);
  });

  it('does NOT emit a clamp warning when user did not pass the param (default cap)', () => {
    // User did not supply `depth`. Budget default still forces it, but that's
    // the documented default, not a clamp of a user request — no warning.
    const original: Record<string, unknown> = {};
    const params: Record<string, unknown> = {};
    const applied = applyBudgetDefaults('get_call_graph', params, 'critical');
    expect(applied).toHaveLength(1);
    const warnings = buildClampWarnings('get_call_graph', original, applied, {});
    expect(warnings).toHaveLength(0);
  });

  it('does NOT emit a clamp warning when user requested a value at or below the cap', () => {
    const original: Record<string, unknown> = { depth: 1 };
    const params = { ...original };
    const applied = applyBudgetDefaults('get_call_graph', params, 'critical');
    // applyBudgetDefaults returns [] in this case; double-check.
    expect(applied).toHaveLength(0);
    const warnings = buildClampWarnings('get_call_graph', original, applied, {});
    expect(warnings).toHaveLength(0);
  });

  it('returns an empty array when nothing was clamped and no truncation', () => {
    const warnings = buildClampWarnings('get_call_graph', {}, [], {});
    expect(warnings).toEqual([]);
  });
});

describe('buildClampWarnings — traverse_graph truncation mirroring', () => {
  it('mirrors truncated_by_depth into _warnings with the requested max_depth', () => {
    const warnings = buildClampWarnings('traverse_graph', { max_depth: 2 }, [], {
      truncated_by_depth: true,
      truncated_by_nodes: false,
      truncated_by_budget: false,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/truncated at max_depth=2/);
    expect(warnings[0]).toContain('max_depth: <higher>');
  });

  it('mirrors truncated_by_nodes into _warnings with the requested max_nodes', () => {
    const warnings = buildClampWarnings('traverse_graph', { max_nodes: 50 }, [], {
      truncated_by_nodes: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/truncated at 50 nodes/);
    expect(warnings[0]).toContain('max_nodes: <higher>');
  });

  it('mirrors truncated_by_budget into _warnings with the requested token_budget', () => {
    const warnings = buildClampWarnings('traverse_graph', { token_budget: 1000 }, [], {
      truncated_by_budget: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/token_budget=1000/);
  });

  it('emits multiple warnings when more than one truncation cause fires', () => {
    const warnings = buildClampWarnings('traverse_graph', { max_depth: 3, max_nodes: 10 }, [], {
      truncated_by_depth: true,
      truncated_by_nodes: true,
      truncated_by_budget: true,
    });
    expect(warnings).toHaveLength(3);
  });

  it('does NOT emit truncation warnings for non-traverse_graph tools', () => {
    // Other tools don't return `truncated_by_*` fields; even if they did
    // (collision with some future tool), we only mirror for traverse_graph.
    const warnings = buildClampWarnings('get_call_graph', {}, [], {
      truncated_by_depth: true,
      truncated_by_nodes: true,
    });
    expect(warnings).toEqual([]);
  });

  it('falls back to documented defaults when user did not pass truncation-related params', () => {
    const warnings = buildClampWarnings('traverse_graph', {}, [], {
      truncated_by_depth: true,
      truncated_by_nodes: true,
      truncated_by_budget: true,
    });
    expect(warnings.some((w) => w.includes('max_depth=3'))).toBe(true);
    expect(warnings.some((w) => w.includes('100 nodes'))).toBe(true);
    expect(warnings.some((w) => w.includes('token_budget=4000'))).toBe(true);
  });

  it('returns no warnings when traverse_graph response indicates no truncation', () => {
    const warnings = buildClampWarnings(
      'traverse_graph',
      { max_depth: 3, max_nodes: 100, token_budget: 4000 },
      [],
      { truncated_by_depth: false, truncated_by_nodes: false, truncated_by_budget: false },
    );
    expect(warnings).toEqual([]);
  });
});
