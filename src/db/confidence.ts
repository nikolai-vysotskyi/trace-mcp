/**
 * Edge confidence helper — maps the categorical `resolution_tier` to a
 * numeric score in [0, 1].
 *
 * trace-mcp already emits edges tagged by how they were resolved
 * (lsp_resolved > ast_resolved > ast_inferred > text_matched). CRG v2.3.2
 * showed value in attaching a continuous score on top: ranking can compare
 * across tiers, visualisations can fade weak edges, and impact analysis
 * can filter by minimum confidence without hardcoding a tier whitelist.
 *
 * The defaults below are intentionally close to the gap between the tiers
 * so the score still preserves the order: any lsp-resolved edge beats any
 * ast-resolved edge, etc. Plugins that have a stronger signal (e.g. spring
 * DI through `@Autowired` metadata vs a heuristic name match) can return a
 * higher number from this helper's range to break ties cleanly.
 *
 * IMPORTANT: keep `CONFIDENCE_BY_TIER` in sync with the per-tier backfill
 * in migration 25 and the `edges_confidence_from_tier` trigger in
 * src/db/schema.ts. The migration runs once on existing DBs; the trigger
 * normalises only the SQL-default value (0.95) on new inserts. Drift
 * between any of the three would produce inconsistent ranking after an
 * upgrade.
 *
 * Trigger contract (intentional, not a bug):
 *  - INSERT with confidence omitted → SQL default 0.95 → trigger fires when
 *    tier ≠ ast_resolved and snaps to canonical for the tier.
 *  - INSERT with an explicit non-0.95 confidence → trigger does NOT fire;
 *    plugins use this to break ties within a tier (e.g. spring `@Autowired`
 *    can return 0.97 vs a generic 0.95 ast_resolved heuristic).
 *  `normalizeConfidence` preserves explicit values verbatim (clamped to
 *  [0, 1]); only NaN/undefined fall back to the tier canonical.
 */
import type { EdgeResolution } from '../plugin-api/types.js';

export const CONFIDENCE_BY_TIER: Record<EdgeResolution, number> = {
  lsp_resolved: 1.0,
  ast_resolved: 0.95,
  ast_inferred: 0.7,
  text_matched: 0.4,
};

export function confidenceForTier(tier: EdgeResolution | string | undefined | null): number {
  if (!tier) return CONFIDENCE_BY_TIER.ast_resolved;
  const known = CONFIDENCE_BY_TIER[tier as EdgeResolution];
  return known !== undefined ? known : CONFIDENCE_BY_TIER.ast_resolved;
}

/**
 * Clamp an externally-supplied confidence into [0, 1] and snap NaN/non-finite
 * values to the resolution-tier default. Defensive — plugin code paths that
 * set confidence themselves should not be able to poison ranking with -1.7
 * or NaN even if a fixture goes wrong.
 */
export function normalizeConfidence(
  raw: number | undefined,
  tier: EdgeResolution | string | undefined | null,
): number {
  if (raw === undefined || raw === null || !Number.isFinite(raw)) {
    return confidenceForTier(tier);
  }
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}
