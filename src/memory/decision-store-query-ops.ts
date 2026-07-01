/**
 * Decision read-path — extracted from `DecisionStore` (Task: god-class
 * decomposition). Owns the read/query surface over the `decisions` table:
 *
 *   - `queryDecisions` — the main filtered query (project/service/type/symbol/
 *     file/tag/branch/review-status/FTS + recency|created_at|heat ordering).
 *   - heat: `recordHits` (write path), `getHeat`, `getHottest`.
 *   - `getTimeline` — chronological decision timeline.
 *   - `getStats` — aggregate counts by type/source.
 *
 * All of these read only `this.db` plus the pure heat helpers. `getHeat`
 * needs a single-row lookup, injected as a `getDecision` callback so this
 * module never imports the store (no import cycle).
 *
 * `DecisionStore` holds one `QueryOperations` instance and delegates its
 * public read methods to it verbatim — the public API and behavior are
 * unchanged, only the implementation moved.
 */

import type Database from 'better-sqlite3';
import { computeHeat, heatDecayMultiplier } from './heat.js';
import type { DecisionRow, DecisionQuery, DecisionTimelineEntry } from './decision-types.js';

/** The slice of `DecisionStore` that the read-path needs. Injected so this
 *  module never imports the store (which would close an import cycle). */
export interface QueryHost {
  getDecision(id: number): DecisionRow | undefined;
}

export class QueryOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly host: QueryHost,
  ) {}

  queryDecisions(query: DecisionQuery): DecisionRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.project_root) {
      conditions.push('d.project_root = ?');
      params.push(query.project_root);
    }
    if (query.service_name) {
      conditions.push('d.service_name = ?');
      params.push(query.service_name);
    }
    if (query.type) {
      conditions.push('d.type = ?');
      params.push(query.type);
    }
    if (query.symbol_id) {
      conditions.push('d.symbol_id = ?');
      params.push(query.symbol_id);
    }
    if (query.file_path) {
      conditions.push('d.file_path = ?');
      params.push(query.file_path);
    }
    if (query.tag) {
      conditions.push("d.tags LIKE '%' || ? || '%'");
      params.push(query.tag);
    }
    // git_branch filter:
    //   undefined  → no filter (back-compat)
    //   'all'      → no filter
    //   null       → only branch-agnostic rows
    //   <string>   → that branch + branch-agnostic rows
    if (query.git_branch !== undefined && query.git_branch !== 'all') {
      if (query.git_branch === null) {
        conditions.push('d.git_branch IS NULL');
      } else {
        conditions.push('(d.git_branch = ? OR d.git_branch IS NULL)');
        params.push(query.git_branch);
      }
    }
    if (!query.include_invalidated) {
      if (query.as_of) {
        conditions.push('d.valid_from <= ? AND (d.valid_until IS NULL OR d.valid_until > ?)');
        params.push(query.as_of, query.as_of);
      } else {
        conditions.push('d.valid_until IS NULL');
      }
    }

    // Memoir-style review filter:
    //   review_status given       → restrict to that exact status
    //   include_pending = true    → return NULL + 'approved' + 'pending'
    //   neither                   → default: NULL + 'approved' (hide pending/rejected)
    if (query.review_status) {
      conditions.push('d.review_status = ?');
      params.push(query.review_status);
    } else if (query.include_pending) {
      conditions.push("(d.review_status IS NULL OR d.review_status IN ('approved','pending'))");
    } else {
      conditions.push("(d.review_status IS NULL OR d.review_status = 'approved')");
    }

    // FTS search — join with FTS table
    if (query.search) {
      conditions.push('d.id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?)');
      params.push(query.search);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const orderBy = query.order_by ?? 'recency';

    // Heat ordering is computed in JS because SQLite has no portable exp().
    // Fetch up to limit*3 rows (capped at 500) under the same WHERE,
    // compute heat per row, sort, then slice. Keeps the deterministic
    // pre-filter cheap and avoids loading the whole table.
    if (orderBy === 'heat') {
      const HEAT_FETCH_CAP = 500;
      const fetchCount = Math.min(Math.max(limit * 3, limit), HEAT_FETCH_CAP);
      const sql = `SELECT d.* FROM decisions d ${where} ORDER BY d.valid_from DESC LIMIT ?`;
      params.push(fetchCount);
      const rows = this.db.prepare(sql).all(...params) as DecisionRow[];
      const now = new Date();
      const heatParams = {
        now,
        halfLifeDays: query.heat_half_life_days,
        freshnessDays: query.heat_freshness_days,
      };
      // Stable sort: heat DESC, tie-break by valid_from DESC (newer first).
      // Search-time temporal decay (Task 11) multiplies the base heat by a
      // recency boost / staleness dampening factor — reranking only, never
      // mutating stored state. Neutral (1.0×) for mid-age rows.
      const scored = rows.map((r) => ({
        row: r,
        heat:
          computeHeat(
            {
              hit_count: r.hit_count ?? 0,
              last_hit_at: r.last_hit_at,
              created_at: r.created_at,
            },
            heatParams,
          ) *
          heatDecayMultiplier({ created_at: r.created_at, last_hit_at: r.last_hit_at }, { now }),
      }));
      scored.sort((a, b) => {
        if (b.heat !== a.heat) return b.heat - a.heat;
        return a.row.valid_from < b.row.valid_from
          ? 1
          : a.row.valid_from > b.row.valid_from
            ? -1
            : 0;
      });
      return scored.slice(offset, offset + limit).map((s) => s.row);
    }

    const orderClause =
      orderBy === 'created_at' ? 'ORDER BY d.created_at DESC' : 'ORDER BY d.valid_from DESC';
    const sql = `SELECT d.* FROM decisions d ${where} ${orderClause} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as DecisionRow[];
  }

  // ── HEAT / TIME-DECAY ─────────────────────────────────────────────────

  /**
   * Record one or more recall hits. Increments `hit_count` and stamps
   * `last_hit_at` to now() for every existing id in a single transaction.
   * Missing ids are silently ignored — callers don't care, and the
   * UPDATE's `WHERE id = ?` natively no-ops. Safe to call fire-and-forget.
   */
  recordHits(decisionIds: number[]): void {
    if (decisionIds.length === 0) return;
    const nowIso = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE decisions
         SET hit_count = hit_count + 1,
             last_hit_at = ?
       WHERE id = ?`,
    );
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(nowIso, id);
    });
    tx(decisionIds);
  }

  /**
   * Compute the heat score for a single decision. Returns 0 when the
   * decision does not exist, so callers can treat this as a safe accessor.
   */
  getHeat(id: number, params?: { halfLifeDays?: number; freshnessDays?: number }): number {
    const row = this.host.getDecision(id);
    if (!row) return 0;
    return computeHeat(
      {
        hit_count: row.hit_count ?? 0,
        last_hit_at: row.last_hit_at,
        created_at: row.created_at,
      },
      {
        now: new Date(),
        halfLifeDays: params?.halfLifeDays,
        freshnessDays: params?.freshnessDays,
      },
    );
  }

  /**
   * Return the hottest N decisions (highest heat first). Filters mirror the
   * common query knobs: project_root, service_name, git_branch. Only active
   * (non-invalidated) and visible (NULL/approved) rows are considered.
   */
  getHottest(opts: {
    project_root?: string;
    service_name?: string;
    git_branch?: string;
    limit?: number;
    halfLifeDays?: number;
    freshnessDays?: number;
  }): DecisionRow[] {
    const limit = opts.limit ?? 10;
    const conditions: string[] = ['valid_until IS NULL'];
    const params: unknown[] = [];

    if (opts.project_root) {
      conditions.push('project_root = ?');
      params.push(opts.project_root);
    }
    if (opts.service_name) {
      conditions.push('service_name = ?');
      params.push(opts.service_name);
    }
    if (opts.git_branch !== undefined) {
      conditions.push('(git_branch = ? OR git_branch IS NULL)');
      params.push(opts.git_branch);
    }
    conditions.push("(review_status IS NULL OR review_status = 'approved')");

    const HEAT_FETCH_CAP = 500;
    const fetchCount = Math.min(Math.max(limit * 3, limit), HEAT_FETCH_CAP);
    const sql = `SELECT * FROM decisions WHERE ${conditions.join(' AND ')} ORDER BY valid_from DESC LIMIT ?`;
    params.push(fetchCount);
    const rows = this.db.prepare(sql).all(...params) as DecisionRow[];
    const now = new Date();
    const scored = rows.map((r) => ({
      row: r,
      heat: computeHeat(
        {
          hit_count: r.hit_count ?? 0,
          last_hit_at: r.last_hit_at,
          created_at: r.created_at,
        },
        {
          now,
          halfLifeDays: opts.halfLifeDays,
          freshnessDays: opts.freshnessDays,
        },
      ),
    }));
    scored.sort((a, b) => b.heat - a.heat);
    return scored.slice(0, limit).map((s) => s.row);
  }

  // ── TIMELINE ───────────────────────────────────────────────────────

  getTimeline(opts: {
    project_root?: string;
    symbol_id?: string;
    file_path?: string;
    limit?: number;
  }): DecisionTimelineEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.project_root) {
      conditions.push('project_root = ?');
      params.push(opts.project_root);
    }
    if (opts.symbol_id) {
      conditions.push('symbol_id = ?');
      params.push(opts.symbol_id);
    }
    if (opts.file_path) {
      conditions.push('file_path = ?');
      params.push(opts.file_path);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;

    const sql = `
      SELECT id, title, type, valid_from, valid_until,
             CASE WHEN valid_until IS NULL THEN 1 ELSE 0 END as is_active
      FROM decisions ${where}
      ORDER BY valid_from ASC
      LIMIT ?
    `;
    params.push(limit);

    return this.db.prepare(sql).all(...params) as DecisionTimelineEntry[];
  }

  // ── STATS ──────────────────────────────────────────────────────────

  getStats(projectRoot?: string): {
    total: number;
    active: number;
    invalidated: number;
    by_type: Record<string, number>;
    by_source: Record<string, number>;
  } {
    const filter = projectRoot ? ' WHERE project_root = ?' : '';
    const params = projectRoot ? [projectRoot] : [];

    const total = (
      this.db.prepare(`SELECT COUNT(*) as c FROM decisions${filter}`).get(...params) as {
        c: number;
      }
    ).c;
    const active = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM decisions${filter}${filter ? ' AND' : ' WHERE'} valid_until IS NULL`,
        )
        .get(...params) as { c: number }
    ).c;

    const typeRows = this.db
      .prepare(`SELECT type, COUNT(*) as c FROM decisions${filter} GROUP BY type`)
      .all(...params) as Array<{ type: string; c: number }>;
    const by_type: Record<string, number> = {};
    for (const r of typeRows) by_type[r.type] = r.c;

    const sourceRows = this.db
      .prepare(`SELECT source, COUNT(*) as c FROM decisions${filter} GROUP BY source`)
      .all(...params) as Array<{ source: string; c: number }>;
    const by_source: Record<string, number> = {};
    for (const r of sourceRows) by_source[r.source] = r.c;

    return { total, active, invalidated: total - active, by_type, by_source };
  }
}
