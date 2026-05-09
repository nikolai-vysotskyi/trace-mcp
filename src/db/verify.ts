/**
 * Index verification and repair.
 *
 * mempalace's recovery surface (`repair --mode max-seq-id`,
 * `repair --mode from-sqlite`, integrity preflight, HNSW quarantine — see
 * mempalace #1342, #1357, #1364, #1310) exists because hosted vector indexes
 * tear in inventive ways that ordinary `reindex --force` doesn't always fix.
 *
 * trace-mcp doesn't run HNSW (we use flat sqlite blobs in
 * `symbol_embeddings`), so the failure modes are different. The most common
 * ones we want to detect cheaply, before they explode in the middle of
 * search:
 *   - SQLite page corruption          → PRAGMA integrity_check
 *   - Foreign-key drift                → PRAGMA foreign_key_check
 *   - Embedding dim mismatches         → row-level Float32 length probe
 *   - Orphan vector rows                → embeddings whose symbol_id is gone
 *   - Empty / missing required tables   → expected-table presence check
 *   - FTS5 ↔ symbols drift              → row-count delta on symbols_fts
 *
 * The verifier never writes — it just produces a structured report. Pair it
 * with {@link repairIndex} (in `repair.ts`) for the destructive side. Read-
 * only by design so it's safe to call from CI / pre-flight checks.
 */
import type Database from 'better-sqlite3';

export type VerifyCheckStatus = 'ok' | 'warn' | 'error';

export interface VerifyCheck {
  name: string;
  status: VerifyCheckStatus;
  detail: string;
  /** Optional row-count or delta surfaced for the human reader. */
  count?: number;
  /** Suggested repair mode to clear this check (when applicable). */
  suggested_repair?: string;
}

export interface VerifyReport {
  ok: boolean;
  /** Highest severity surfaced. */
  status: VerifyCheckStatus;
  checks: VerifyCheck[];
}

const REQUIRED_TABLES = [
  'files',
  'symbols',
  'nodes',
  'edges',
  'edge_types',
  'symbols_fts',
] as const;

interface IntegrityRow {
  integrity_check: string;
}

interface FkViolationRow {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

function rowExists(db: Database.Database, sql: string): boolean {
  try {
    const r = db.prepare(sql).get();
    return r !== undefined;
  } catch {
    return false;
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return rowExists(
    db,
    `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = '${name.replace(/'/g, "''")}'`,
  );
}

function tableRowCount(db: Database.Database, name: string): number {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number };
    return r?.c ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Read-only structural verification of an indexed SQLite database. Never
 * writes. The optional `expectedDim` is the embedding dimension recorded in
 * `embedding_meta` — when set, every row in `symbol_embeddings` is probed
 * for a matching length.
 */
export function verifyIndex(db: Database.Database): VerifyReport {
  const checks: VerifyCheck[] = [];

  // ── 1. SQLite integrity_check ─────────────────────────────────────────
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as IntegrityRow[];
    if (rows.length === 1 && rows[0].integrity_check === 'ok') {
      checks.push({ name: 'sqlite_integrity', status: 'ok', detail: 'PRAGMA integrity_check: ok' });
    } else {
      checks.push({
        name: 'sqlite_integrity',
        status: 'error',
        detail: `PRAGMA integrity_check returned ${rows.length} issues: ${rows
          .slice(0, 3)
          .map((r) => r.integrity_check)
          .join('; ')}${rows.length > 3 ? '; …' : ''}`,
        suggested_repair: 'reindex --force',
      });
    }
  } catch (e) {
    checks.push({
      name: 'sqlite_integrity',
      status: 'error',
      detail: `PRAGMA integrity_check failed: ${e instanceof Error ? e.message : String(e)}`,
      suggested_repair: 'reindex --force',
    });
  }

  // ── 2. Foreign-key check ──────────────────────────────────────────────
  try {
    db.pragma('foreign_keys = ON');
    const violations = db.prepare('PRAGMA foreign_key_check').all() as FkViolationRow[];
    if (violations.length === 0) {
      checks.push({ name: 'foreign_keys', status: 'ok', detail: 'No foreign-key violations' });
    } else {
      checks.push({
        name: 'foreign_keys',
        status: 'error',
        detail: `${violations.length} foreign-key violation(s): ${violations
          .slice(0, 3)
          .map((v) => `${v.table}#${v.rowid} → ${v.parent}`)
          .join(', ')}${violations.length > 3 ? ', …' : ''}`,
        count: violations.length,
        suggested_repair: 'drop-orphans',
      });
    }
  } catch (e) {
    checks.push({
      name: 'foreign_keys',
      status: 'warn',
      detail: `foreign_key_check probe failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // ── 3. Required tables ────────────────────────────────────────────────
  const missing: string[] = [];
  for (const t of REQUIRED_TABLES) {
    if (!tableExists(db, t)) missing.push(t);
  }
  if (missing.length === 0) {
    checks.push({
      name: 'required_tables',
      status: 'ok',
      detail: `All ${REQUIRED_TABLES.length} required tables present`,
    });
  } else {
    checks.push({
      name: 'required_tables',
      status: 'error',
      detail: `Missing tables: ${missing.join(', ')}`,
      suggested_repair: 'reindex --force',
    });
  }

  // ── 4. FTS5 integrity probe ───────────────────────────────────────────
  // symbols_fts uses external-content (content='symbols'), so COUNT(*) on it
  // always matches the source table — it isn't a useful drift signal. The
  // FTS5 'integrity-check' command, on the other hand, walks the inverted
  // index and reports physical corruption.
  if (tableExists(db, 'symbols_fts')) {
    try {
      db.prepare(`INSERT INTO symbols_fts(symbols_fts) VALUES ('integrity-check')`).run();
      checks.push({
        name: 'fts_integrity',
        status: 'ok',
        detail: 'symbols_fts integrity-check passed',
      });
    } catch (e) {
      checks.push({
        name: 'fts_integrity',
        status: 'warn',
        detail: `symbols_fts integrity-check failed: ${e instanceof Error ? e.message : String(e)}`,
        suggested_repair: 'rebuild-fts',
      });
    }
  }

  // ── 5. Embedding dimension consistency ────────────────────────────────
  if (tableExists(db, 'symbol_embeddings') && tableExists(db, 'embedding_meta')) {
    let expectedDim: number | null = null;
    try {
      const meta = db.prepare('SELECT dim FROM embedding_meta WHERE id = 1').get() as
        | { dim: number }
        | undefined;
      expectedDim = meta?.dim ?? null;
    } catch {
      expectedDim = null;
    }
    const total = tableRowCount(db, 'symbol_embeddings');
    if (total === 0) {
      checks.push({ name: 'embedding_dim', status: 'ok', detail: 'No embeddings yet' });
    } else if (expectedDim === null) {
      checks.push({
        name: 'embedding_dim',
        status: 'warn',
        detail: `${total} embeddings but no embedding_meta.dim — dimension cannot be verified`,
        count: total,
        suggested_repair: 'drop-vec',
      });
    } else {
      const expectedBytes = expectedDim * 4; // Float32
      const stmt = db.prepare(
        'SELECT COUNT(*) AS c FROM symbol_embeddings WHERE LENGTH(embedding) != ?',
      );
      const r = stmt.get(expectedBytes) as { c: number };
      const wrong = r?.c ?? 0;
      if (wrong === 0) {
        checks.push({
          name: 'embedding_dim',
          status: 'ok',
          detail: `${total} embeddings × ${expectedDim}d match`,
        });
      } else {
        checks.push({
          name: 'embedding_dim',
          status: 'error',
          detail: `${wrong} of ${total} embeddings have a wrong byte length (expected ${expectedBytes} for ${expectedDim}d)`,
          count: wrong,
          suggested_repair: 'drop-vec',
        });
      }
    }
  }

  // ── 6. Orphan embeddings ──────────────────────────────────────────────
  if (tableExists(db, 'symbol_embeddings') && tableExists(db, 'symbols')) {
    try {
      const r = db
        .prepare(
          'SELECT COUNT(*) AS c FROM symbol_embeddings e LEFT JOIN symbols s ON s.id = e.symbol_id WHERE s.id IS NULL',
        )
        .get() as { c: number };
      const orphans = r?.c ?? 0;
      if (orphans === 0) {
        checks.push({ name: 'orphan_embeddings', status: 'ok', detail: 'No orphan embeddings' });
      } else {
        checks.push({
          name: 'orphan_embeddings',
          status: 'warn',
          detail: `${orphans} embedding row(s) reference deleted symbols`,
          count: orphans,
          suggested_repair: 'drop-orphans',
        });
      }
    } catch (e) {
      checks.push({
        name: 'orphan_embeddings',
        status: 'warn',
        detail: `Orphan probe failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  const status: VerifyCheckStatus = checks.some((c) => c.status === 'error')
    ? 'error'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';
  return { ok: status === 'ok', status, checks };
}
