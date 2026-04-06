/**
 * Runtime Aggregator — computes hourly rollups from raw spans.
 * Stores pre-computed stats (call count, latency percentiles) per node.
 */

import type Database from 'better-sqlite3';
import { logger } from '../logger.js';

interface AggregateResult {
  bucketsUpdated: number;
  nodesAffected: number;
}

export class RuntimeAggregator {
  private readonly aggregateStmt: Database.Statement;
  private readonly upsertStmt: Database.Statement;
  private readonly getDurations: Database.Statement;

  constructor(private db: Database.Database) {
    this.aggregateStmt = db.prepare(`
      SELECT
        mapped_node_id as node_id,
        strftime('%Y-%m-%dT%H', started_at) as bucket,
        COUNT(*) as call_count,
        SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) as error_count,
        SUM(duration_us) as total_duration_us,
        MIN(duration_us) as min_duration_us,
        MAX(duration_us) as max_duration_us
      FROM runtime_spans
      WHERE mapped_node_id IS NOT NULL
        AND started_at >= ?
      GROUP BY mapped_node_id, bucket
      LIMIT 50000
    `);

    this.upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO runtime_aggregates
        (node_id, bucket, call_count, error_count, total_duration_us, min_duration_us, max_duration_us, percentiles)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getDurations = db.prepare(`
      SELECT duration_us FROM runtime_spans
      WHERE mapped_node_id = ? AND strftime('%Y-%m-%dT%H', started_at) = ?
      ORDER BY duration_us
    `);
  }

  /** Recompute aggregates for spans since a given time. */
  aggregate(since?: string): AggregateResult {
    const sinceStr = since ?? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // default: last 2h

    // Step 1: Basic aggregates via SQL
    const rows = this.aggregateStmt.all(sinceStr) as Array<{
      node_id: number;
      bucket: string;
      call_count: number;
      error_count: number;
      total_duration_us: number;
      min_duration_us: number;
      max_duration_us: number;
    }>;

    if (rows.length === 0) return { bucketsUpdated: 0, nodesAffected: 0 };

    const nodesAffected = new Set<number>();

    this.db.transaction(() => {
      for (const row of rows) {
        // Compute percentiles
        const durations = this.getDurations.all(row.node_id, row.bucket) as Array<{ duration_us: number }>;
        const sorted = durations.map((d) => d.duration_us);
        const percentiles = [
          { p: 50, v: percentile(sorted, 0.50) },
          { p: 95, v: percentile(sorted, 0.95) },
          { p: 99, v: percentile(sorted, 0.99) },
        ];

        this.upsertStmt.run(
          row.node_id,
          row.bucket,
          row.call_count,
          row.error_count,
          row.total_duration_us,
          row.min_duration_us,
          row.max_duration_us,
          JSON.stringify(percentiles),
        );

        nodesAffected.add(row.node_id);
      }
    })();

    logger.debug(
      { bucketsUpdated: rows.length, nodesAffected: nodesAffected.size },
      'Runtime aggregates computed',
    );

    return { bucketsUpdated: rows.length, nodesAffected: nodesAffected.size };
  }
}

/** Nearest-rank percentile on a sorted array */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
