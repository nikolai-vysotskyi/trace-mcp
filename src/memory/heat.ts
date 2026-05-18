/**
 * Decision heat / time-decay scoring.
 *
 * Heat is a recall-weighted score that decays exponentially with age since the
 * last recall hit. Frequently-recalled decisions stay hot; ignored ones fade.
 * Brand-new decisions get a small "freshness floor" so a freshly captured row
 * is not drowned by old decisions captured a year ago.
 *
 *   heat(d) = hit_count * exp(-(now - last_hit_at) / halfLifeDays)
 *           + recencyFloor(created_at)
 *
 *   recencyFloor(c) = exp(-(now - c) / freshnessDays)
 *
 * All time deltas are measured in days. Results are clamped to [0, HEAT_CEILING]
 * so a celebrity decision recalled thousands of times cannot suppress the rest
 * of the corpus.
 */
export interface HeatParams {
  now: Date;
  /** Half-life of hit-driven heat, in days. Default 14. */
  halfLifeDays?: number;
  /** Window during which a new uncalled decision keeps a freshness boost. Default 7. */
  freshnessDays?: number;
}

export interface HeatInput {
  hit_count: number;
  last_hit_at?: string | null;
  created_at: string;
}

/** Upper clamp — prevents one runaway decision from suppressing the rest. */
export const HEAT_CEILING = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse an ISO timestamp and return milliseconds since epoch.
 * Returns null when the input is missing or unparseable so callers can decide
 * how to degrade (typically: drop the hit term, keep the floor).
 */
function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Compute a non-negative heat score for a decision. Safe with null
 * `last_hit_at` (no hit term), future `created_at` from clock skew (floor
 * clamped at 1), and zero/negative hit_count (term collapses to 0).
 */
export function computeHeat(d: HeatInput, params: HeatParams): number {
  const halfLifeDays = Math.max(params.halfLifeDays ?? 14, 1e-6);
  const freshnessDays = Math.max(params.freshnessDays ?? 7, 1e-6);
  const nowMs = params.now.getTime();

  // ── Hit term ────────────────────────────────────────────────────────
  let hitTerm = 0;
  const lastHitMs = parseIsoMs(d.last_hit_at);
  const hits = Math.max(0, d.hit_count | 0);
  if (lastHitMs !== null && hits > 0) {
    const ageDays = Math.max(0, (nowMs - lastHitMs) / DAY_MS);
    hitTerm = hits * Math.exp(-ageDays / halfLifeDays);
  }

  // ── Recency floor ───────────────────────────────────────────────────
  let floor = 0;
  const createdMs = parseIsoMs(d.created_at);
  if (createdMs !== null) {
    // Clock skew tolerance: future created_at clamps to age 0 → floor = 1.
    const ageDays = Math.max(0, (nowMs - createdMs) / DAY_MS);
    floor = Math.exp(-ageDays / freshnessDays);
  }

  const heat = hitTerm + floor;
  if (heat <= 0) return 0;
  return heat > HEAT_CEILING ? HEAT_CEILING : heat;
}
