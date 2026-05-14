/**
 * Ranking pins (E10) — user-supplied importance weights that boost or demote
 * specific symbols / files in PageRank-driven ranking.
 *
 * Storage: SQLite table `ranking_pins` keyed by (scope, target_id). The
 * `target_id` is either a `file path` (scope=file) or a `symbol_id`
 * (scope=symbol). Weights ∈ [0.1, 3.0]; values < 1 demote. TTL via
 * `expires_at` (unix ms). Total active rows capped at 50.
 *
 * This module exposes a tiny CRUD surface used by `getPageRank` to multiply
 * pinned-file scores after the algorithm settles. We deliberately apply
 * pins POST-rank rather than seed them into the prior because:
 *   1. It composes cleanly with downstream rerankers — anyone consuming
 *      pagerank output sees a stable order.
 *   2. It avoids re-converging PageRank on every pin/unpin.
 *   3. Tests can assert a deterministic boost relative to the unpinned
 *      baseline without depending on algorithm convergence.
 *
 * Caching note (N1): an earlier revision kept a 30s module-level cache of
 * the pins table, invalidated only via `upsertPin` / `deletePin`. That left
 * stale weights cached for up to 30 seconds whenever anything bypassed the
 * helpers — direct INSERT/DELETE/UPDATE against `ranking_pins`, bulk
 * migrations, importers, or test fixtures. The table caps at 50 rows and
 * every read is a single indexed SELECT; caching it was a premature
 * optimisation. The cache has been removed entirely — every lookup hits
 * SQLite. PageRank already does O(V²) work, so a 50-row SELECT per call is
 * statistical noise. `invalidatePinsCache` is kept as a no-op for backward
 * compatibility with existing callers (it is referenced from tests).
 */

import type Database from 'better-sqlite3';

export const PIN_WEIGHT_MIN = 0.1;
export const PIN_WEIGHT_MAX = 3.0;
export const PIN_WEIGHT_DEFAULT = 2.0;
export const PIN_MAX_ACTIVE = 50;

export interface RankingPinRow {
  scope: 'symbol' | 'file';
  target_id: string;
  weight: number;
  expires_at: number | null;
  created_by: string;
  created_at: number;
}

/**
 * No-op retained for backward compatibility. The in-process cache that this
 * used to invalidate has been removed; every read now hits SQLite directly.
 * Existing call sites (notably `upsertPin` / `deletePin` and tests) continue
 * to call this safely.
 */
export function invalidatePinsCache(): void {
  /* no-op — see file header */
}

function nowMs(): number {
  return Date.now();
}

function pruneExpired(db: Database.Database): void {
  db.prepare('DELETE FROM ranking_pins WHERE expires_at IS NOT NULL AND expires_at < ?').run(
    nowMs(),
  );
}

/** Look up the pin weight for a file path. Returns 1.0 (no boost) if unpinned. */
export function getFilePinWeight(db: Database.Database, filePath: string): number {
  pruneExpired(db);
  const row = db
    .prepare("SELECT weight FROM ranking_pins WHERE scope = 'file' AND target_id = ?")
    .get(filePath) as { weight: number } | undefined;
  return row?.weight ?? 1.0;
}

/**
 * Variant of getFilePinWeight that distinguishes "unpinned" from "pinned at 1.0".
 * Returns undefined when the file has no explicit pin — used by getPageRank to
 * decide whether to fall back to symbol-pin propagation. Pinned-at-exactly-1.0
 * is intentionally exposed as a real value so a user's explicit "reset" wins
 * over symbol propagation.
 */
export function getFilePinWeightExplicit(
  db: Database.Database,
  filePath: string,
): number | undefined {
  pruneExpired(db);
  const row = db
    .prepare("SELECT weight FROM ranking_pins WHERE scope = 'file' AND target_id = ?")
    .get(filePath) as { weight: number } | undefined;
  return row?.weight;
}

/** Look up the pin weight for a symbol_id. Returns 1.0 (no boost) if unpinned. */
export function getSymbolPinWeight(db: Database.Database, symbolId: string): number {
  pruneExpired(db);
  const row = db
    .prepare("SELECT weight FROM ranking_pins WHERE scope = 'symbol' AND target_id = ?")
    .get(symbolId) as { weight: number } | undefined;
  return row?.weight ?? 1.0;
}

/**
 * E10 — propagation: aggregate symbol-scope pin weights up to their containing
 * files so a pinned symbol also boosts the file it lives in. Returns a map of
 * `file_path -> max(symbol pin weight)`. Files with no pinned symbols are
 * absent from the map (caller treats absence as 1.0).
 *
 * Why max and not sum/product? A user pinning a single critical symbol expects
 * the boost they asked for, not a sum that explodes when multiple symbols in
 * the same file happen to be pinned. Max keeps the contract intuitive and
 * bounded by PIN_WEIGHT_MAX.
 */
export function getSymbolPinWeightsByFile(db: Database.Database): Map<string, number> {
  // Prune expired pins first so the join doesn't surface stale weights.
  pruneExpired(db);
  const rows = db
    .prepare(
      `SELECT f.path AS path, MAX(p.weight) AS weight
       FROM ranking_pins p
       JOIN symbols s ON s.symbol_id = p.target_id
       JOIN files f ON f.id = s.file_id
       WHERE p.scope = 'symbol'
       GROUP BY f.path`,
    )
    .all() as Array<{ path: string; weight: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.path, r.weight);
  return out;
}

/** Count currently active pins (post-expiry-prune). */
export function countActivePins(db: Database.Database): number {
  pruneExpired(db);
  return (db.prepare('SELECT COUNT(*) as cnt FROM ranking_pins').get() as { cnt: number }).cnt;
}

export interface UpsertPinResult {
  ok: boolean;
  reason?: string;
  row?: RankingPinRow;
}

export function upsertPin(
  db: Database.Database,
  input: {
    scope: 'symbol' | 'file';
    target_id: string;
    weight?: number;
    expires_in_ms?: number;
    created_by?: 'user' | 'agent';
  },
): UpsertPinResult {
  const weight = input.weight ?? PIN_WEIGHT_DEFAULT;
  if (!Number.isFinite(weight) || weight < PIN_WEIGHT_MIN || weight > PIN_WEIGHT_MAX) {
    return {
      ok: false,
      reason: `weight must be in [${PIN_WEIGHT_MIN}, ${PIN_WEIGHT_MAX}] (got ${weight})`,
    };
  }
  if (!input.target_id) {
    return { ok: false, reason: 'target_id is required' };
  }
  // Cap check — exclude an existing row at the same key so updates aren't
  // counted as new pins.
  const existing = db
    .prepare('SELECT 1 FROM ranking_pins WHERE scope = ? AND target_id = ?')
    .get(input.scope, input.target_id);
  if (!existing) {
    const active = countActivePins(db);
    if (active >= PIN_MAX_ACTIVE) {
      return {
        ok: false,
        reason: `pin cap reached (${PIN_MAX_ACTIVE}); call list_pins / unpin first`,
      };
    }
  }
  const now = nowMs();
  const expiresAt = input.expires_in_ms ? now + input.expires_in_ms : null;
  db.prepare(
    `INSERT INTO ranking_pins (scope, target_id, weight, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, target_id) DO UPDATE SET
       weight = excluded.weight,
       expires_at = excluded.expires_at,
       created_by = excluded.created_by`,
  ).run(input.scope, input.target_id, weight, expiresAt, input.created_by ?? 'user', now);
  const row = db
    .prepare(
      'SELECT scope, target_id, weight, expires_at, created_by, created_at FROM ranking_pins WHERE scope = ? AND target_id = ?',
    )
    .get(input.scope, input.target_id) as RankingPinRow | undefined;
  return { ok: true, row };
}

export interface DeletePinResult {
  ok: boolean;
  deleted: number;
}

export function deletePin(
  db: Database.Database,
  input: { scope?: 'symbol' | 'file'; target_id: string },
): DeletePinResult {
  let info;
  if (input.scope) {
    info = db
      .prepare('DELETE FROM ranking_pins WHERE scope = ? AND target_id = ?')
      .run(input.scope, input.target_id);
  } else {
    info = db.prepare('DELETE FROM ranking_pins WHERE target_id = ?').run(input.target_id);
  }
  return { ok: info.changes > 0, deleted: info.changes };
}

export function listPins(db: Database.Database): RankingPinRow[] {
  pruneExpired(db);
  return db
    .prepare(
      'SELECT scope, target_id, weight, expires_at, created_by, created_at FROM ranking_pins ORDER BY created_at DESC',
    )
    .all() as RankingPinRow[];
}
