/**
 * check_edit_safe — edit-safety preflight.
 *
 * Answers a different question than `assess_change_risk`: instead of a continuous
 * weighted risk score, it returns ONE discrete verdict naming the dominant reason
 * editing this symbol/file is risky, a ranked list of blockers, and a one-line
 * recommended action ("what must I preserve before I touch this").
 *
 * This is a THIN fusion — all the heavy graph work is delegated to
 * `getChangeImpact`, which already computes:
 *   - cross-file dependents + breaking changes (exported symbols with consumers)
 *   - the target's own test coverage and per-dependent complexity
 * We only re-shape those signals into an edit-oriented verdict here. The target's
 * own cyclomatic complexity (regression-proneness of the body being edited) is the
 * one extra signal not surfaced by getChangeImpact's dependent-centric view, so we
 * read it with a single direct query.
 *
 * NOTE: no runtime/traffic signal is ingested by this repo, so the
 * `runtime_critical` tier is intentionally omitted.
 */

import type { Store } from '../../db/store.js';
import { err, ok, validationError, type TraceMcpResult } from '../../errors.js';
import { getChangeImpact } from '../analysis/impact.js';

/** Cyclomatic complexity at/above which a body is treated as regression-prone. */
const COMPLEXITY_THRESHOLD = 15;

/**
 * Test-file path matcher (mirrors the indexer's test_covers resolver). A symbol
 * consumed only by test files is not a real contract consumer — tests are not
 * downstream callers whose signatures must be preserved.
 */
const TEST_PATH_RE =
  /\.(test|spec)\.[jt]sx?$|__tests__\/|(?:^|[/\\])test_[^/\\]+\.py$|(?:^|[/\\])[^/\\]+_test\.py$|conftest\.py$/;

export type EditSafeVerdict = 'safe_to_edit' | 'untested' | 'complexity_risk' | 'signature_impact';

export interface EditSafeBlocker {
  /** Which signal raised this blocker. */
  signal: 'signature_impact' | 'complexity_risk' | 'untested';
  /** Higher = more important to address first. */
  severity: 'high' | 'medium' | 'low';
  /** Human-readable explanation of the blocker. */
  detail: string;
}

export interface CheckEditSafeResult {
  target: { path: string; symbol_id?: string; symbol_name?: string; kind?: string };
  /** The single dominant verdict for editing this code. */
  verdict: EditSafeVerdict;
  /** One-line action the agent should take before/while editing. */
  recommended_action: string;
  /** Blockers ranked most-severe first. Empty when verdict is safe_to_edit. */
  blockers: EditSafeBlocker[];
  /** 0..1 — how many of the underlying signals were resolvable. */
  confidence: number;
  /** Compact view of the signals the verdict was derived from. */
  signals: {
    /** Number of exported symbols with cross-file consumers (contract to preserve). */
    breaking_consumers: number;
    /** Number of files depending on the target. */
    dependent_files: number;
    /** Max cyclomatic complexity of the target's own symbols. */
    target_complexity: number;
    /** Whether the target file has any test coverage. */
    target_has_tests: boolean;
  };
}

function round(v: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Max cyclomatic complexity among the target file's own symbols. */
function getTargetComplexity(store: Store, filePath: string): number {
  try {
    const row = store.db
      .prepare(`
        SELECT MAX(s.cyclomatic) AS max_cyc
        FROM symbols s JOIN files f ON s.file_id = f.id
        WHERE f.path = ?
      `)
      .get(filePath) as { max_cyc: number | null } | undefined;
    return row?.max_cyc ?? 0;
  } catch {
    return 0;
  }
}

/** Whether the target file has any test_covers edge (file- or symbol-level). */
function targetHasTests(store: Store, filePath: string): boolean {
  const file = store.getFile(filePath);
  if (!file) return false;
  try {
    const row = store.db
      .prepare(`
        SELECT 1 FROM edges e
        JOIN edge_types et ON e.edge_type_id = et.id
        JOIN nodes n ON e.target_node_id = n.id
        WHERE et.name = 'test_covers' AND (
          (n.node_type = 'file' AND n.ref_id = ?)
          OR (n.node_type = 'symbol' AND n.ref_id IN (SELECT id FROM symbols WHERE file_id = ?))
        )
        LIMIT 1
      `)
      .get(file.id, file.id);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Edit-safety preflight. Fuses change-impact (signature/dependent signals) with
 * the target's own complexity and test-coverage into a single verdict.
 */
export function checkEditSafe(
  store: Store,
  opts: { filePath?: string; symbolId?: string },
  cwd?: string,
): TraceMcpResult<CheckEditSafeResult> {
  if (!opts.filePath && !opts.symbolId) {
    return err(validationError('Provide either file_path or symbol_id'));
  }

  // Delegate all dependent / breaking-change analysis to the existing tool.
  const impactRes = getChangeImpact(
    store,
    { filePath: opts.filePath, symbolId: opts.symbolId },
    3,
    200,
    cwd,
  );
  if (impactRes.isErr()) return err(impactRes.error);
  const impact = impactRes.value;

  const targetPath = impact.target.path;
  // Drop breaking changes whose enumerated consumers are ALL test files — tests
  // are not contract consumers, so editing such a symbol carries no signature
  // impact. `consumerFiles` is the (capped) enumerated set; when at least one
  // non-test consumer is present, the contract is genuinely externally depended on.
  const breaking = (impact.breakingChanges ?? []).filter((b) =>
    b.consumerFiles.some((f) => !TEST_PATH_RE.test(f)),
  );
  const breakingConsumers = breaking.reduce(
    (s, b) => s + b.consumerFiles.filter((f) => !TEST_PATH_RE.test(f)).length,
    0,
  );
  const dependentFiles = impact.totalAffected;
  const complexity = getTargetComplexity(store, targetPath);
  const hasTests = targetHasTests(store, targetPath);

  // ── Build blockers from the fused signals ──
  const blockers: EditSafeBlocker[] = [];

  if (breaking.length > 0) {
    const top = breaking
      .slice(0, 3)
      .map((b) => `${b.symbolName} (${b.consumers} consumer${b.consumers === 1 ? '' : 's'})`)
      .join(', ');
    blockers.push({
      signal: 'signature_impact',
      severity: 'high',
      detail: `${breaking.length} exported symbol(s) with ${breakingConsumers} cross-file consumer(s) depend on the current contract: ${top}. Preserve these signatures.`,
    });
  }

  if (complexity >= COMPLEXITY_THRESHOLD) {
    blockers.push({
      signal: 'complexity_risk',
      severity: complexity >= COMPLEXITY_THRESHOLD * 2 ? 'high' : 'medium',
      detail: `High cyclomatic complexity (${complexity}) in the target body — regression-prone. Edit in small steps and add coverage for branches.`,
    });
  }

  if (!hasTests) {
    blockers.push({
      signal: 'untested',
      severity: 'medium',
      detail:
        'No test coverage on the target — a regression would go undetected. Add a failing test before editing.',
    });
  }

  // ── Pick the dominant verdict (signature impact > complexity > untested) ──
  let verdict: EditSafeVerdict;
  let recommendedAction: string;

  if (breaking.length > 0) {
    verdict = 'signature_impact';
    recommendedAction = `Preserve the public contract of ${breaking.length} exported symbol(s) (${breakingConsumers} consumer(s)); change behavior without altering signatures, or update all call sites.`;
  } else if (complexity >= COMPLEXITY_THRESHOLD) {
    verdict = 'complexity_risk';
    recommendedAction = `Refactor or edit defensively — target complexity is ${complexity}; add branch coverage before changing logic.`;
  } else if (!hasTests) {
    verdict = 'untested';
    recommendedAction =
      'Add a test reproducing current behavior before editing — the target has no coverage.';
  } else {
    verdict = 'safe_to_edit';
    recommendedAction =
      'Low edit risk — no cross-file contract, manageable complexity, and existing test coverage.';
  }

  // Rank blockers: high before medium before low.
  const sevRank = { high: 0, medium: 1, low: 2 } as const;
  blockers.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  // ── Confidence: fraction of signals that were resolvable ──
  // signature + complexity + coverage are always computable from the index (3).
  // Dependent traversal contributes a 4th when the symbol resolved with deps.
  const signalsResolved = 3 + (dependentFiles > 0 || breaking.length > 0 ? 1 : 0);
  const confidence = round(signalsResolved / 4);

  return ok({
    target: {
      path: targetPath,
      symbol_id: impact.target.symbolId,
      symbol_name: impact.target.symbolName,
      kind: impact.target.kind,
    },
    verdict,
    recommended_action: recommendedAction,
    blockers,
    confidence,
    signals: {
      breaking_consumers: breakingConsumers,
      dependent_files: dependentFiles,
      target_complexity: complexity,
      target_has_tests: hasTests,
    },
  });
}
