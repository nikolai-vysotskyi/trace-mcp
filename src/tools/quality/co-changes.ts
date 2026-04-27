/**
 * Git Co-Change Analysis — identifies files that frequently change together
 * by parsing git log history and computing temporal coupling metrics.
 *
 * Performance: Single `git log` call → O(commits * avg_files_per_commit) parsing.
 * DB writes batched in a single transaction.
 */
import { execSync } from 'node:child_process';
import type { Store } from '../../db/store.js';
import { ok, type TraceMcpResult } from '../../errors.js';
import { logger } from '../../logger.js';

interface CoChangeEntry {
  file: string;
  count: number;
  confidence: number;
  lastCoChange: string | null;
}

interface CoChangeResult {
  file: string;
  coChanges: CoChangeEntry[];
  windowDays: number;
}

interface CoChangeOptions {
  file: string;
  minConfidence?: number;
  minCount?: number;
  windowDays?: number;
  limit?: number;
}

/**
 * Collect co-change data from git log and persist to the database.
 * Called during indexing or on-demand via the tool.
 *
 * Uses a single `git log` invocation, then O(n) parsing — no N+1.
 */
export function collectCoChanges(
  rootPath: string,
  windowDays = 180,
): Map<string, Map<string, { count: number; lastDate: string }>> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - windowDays);
  const since = sinceDate.toISOString().split('T')[0];

  let gitOutput: string;
  try {
    gitOutput = execSync(
      `git log --name-only --pretty=format:"COMMIT:%H:%aI" --since="${since}" --diff-filter=AMRD`,
      { cwd: rootPath, maxBuffer: 50 * 1024 * 1024, encoding: 'utf-8', timeout: 30_000 },
    );
  } catch (e) {
    logger.warn({ error: e }, 'Failed to read git log for co-change analysis');
    return new Map();
  }

  // Parse git output into commits → file sets
  const commits: Array<{ hash: string; date: string; files: string[] }> = [];
  let current: { hash: string; date: string; files: string[] } | null = null;

  for (const line of gitOutput.split('\n')) {
    if (line.startsWith('COMMIT:')) {
      if (current && current.files.length > 0) commits.push(current);
      const parts = line.slice(7).split(':');
      // Format: COMMIT:hash:date — date may contain colons (ISO format)
      const hash = parts[0];
      const date = parts.slice(1).join(':');
      current = { hash, date, files: [] };
    } else if (line.trim() && current) {
      current.files.push(line.trim());
    }
  }
  if (current && current.files.length > 0) commits.push(current);

  // Build co-change pairs: for each commit, pair all files together
  // Track per-file total change counts for confidence calculation
  const fileTotals = new Map<string, number>();
  const pairs = new Map<string, Map<string, { count: number; lastDate: string }>>();

  for (const commit of commits) {
    // Limit: skip merge commits with huge file lists (likely releases)
    if (commit.files.length > 50) continue;

    for (const file of commit.files) {
      fileTotals.set(file, (fileTotals.get(file) ?? 0) + 1);
    }

    // Build all unordered pairs
    const files = commit.files.sort(); // canonical order
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i];
        const b = files[j];
        if (!pairs.has(a)) pairs.set(a, new Map());
        const inner = pairs.get(a)!;
        const existing = inner.get(b);
        if (existing) {
          existing.count++;
          if (commit.date > existing.lastDate) existing.lastDate = commit.date;
        } else {
          inner.set(b, { count: 1, lastDate: commit.date });
        }
      }
    }
  }

  return pairs;
}

/**
 * Persist co-change data to the co_changes table.
 * Runs in a single transaction — batch INSERT OR REPLACE.
 */
export function persistCoChanges(
  store: Store,
  pairs: Map<string, Map<string, { count: number; lastDate: string }>>,
  rootPath: string,
  windowDays = 180,
): number {
  // Compute file totals from pairs data
  const fileTotals = new Map<string, number>();
  for (const [a, bMap] of pairs) {
    for (const [b, data] of bMap) {
      fileTotals.set(a, (fileTotals.get(a) ?? 0) + data.count);
      fileTotals.set(b, (fileTotals.get(b) ?? 0) + data.count);
    }
  }

  let count = 0;
  store.db.transaction(() => {
    // Clear existing co-changes for this window
    store.db.prepare('DELETE FROM co_changes WHERE window_days = ?').run(windowDays);

    const insert = store.db.prepare(`
      INSERT INTO co_changes (file_a, file_b, co_change_count, total_changes_a, total_changes_b, confidence, last_co_change, window_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [a, bMap] of pairs) {
      for (const [b, data] of bMap) {
        if (data.count < 2) continue; // skip noise

        const totalA = fileTotals.get(a) ?? data.count;
        const totalB = fileTotals.get(b) ?? data.count;
        const confidence = data.count / Math.min(totalA, totalB);

        insert.run(a, b, data.count, totalA, totalB, confidence, data.lastDate, windowDays);
        count++;
      }
    }
  })();

  return count;
}

/**
 * Query co-changes for a specific file.
 */
export function getCoChanges(store: Store, opts: CoChangeOptions): TraceMcpResult<CoChangeResult> {
  const { file, minConfidence = 0.3, minCount = 3, windowDays = 180, limit = 20 } = opts;

  const rows = store.db
    .prepare(`
    SELECT
      CASE WHEN file_a = ? THEN file_b ELSE file_a END AS co_file,
      co_change_count,
      CASE WHEN file_a = ? THEN total_changes_b ELSE total_changes_a END AS co_file_total,
      confidence,
      last_co_change
    FROM co_changes
    WHERE (file_a = ? OR file_b = ?)
      AND confidence >= ?
      AND co_change_count >= ?
      AND window_days = ?
    ORDER BY confidence DESC, co_change_count DESC
    LIMIT ?
  `)
    .all(file, file, file, file, minConfidence, minCount, windowDays, limit) as Array<{
    co_file: string;
    co_change_count: number;
    co_file_total: number;
    confidence: number;
    last_co_change: string | null;
  }>;

  return ok({
    file,
    coChanges: rows.map((r) => ({
      file: r.co_file,
      count: r.co_change_count,
      confidence: r.confidence,
      lastCoChange: r.last_co_change,
    })),
    windowDays,
  });
}
