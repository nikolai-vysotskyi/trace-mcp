/**
 * Targeted repair operations for an indexed SQLite database. Pair with
 * {@link verifyIndex} (in verify.ts) to know what to repair.
 *
 * Repair modes:
 *   - drop-orphans : DELETE orphan rows from symbol_embeddings (ones whose
 *                    symbol_id no longer exists). Cheapest fix; preserves the
 *                    rest of the embedding store.
 *   - drop-vec     : DROP the symbol_embeddings + embedding_meta tables.
 *                    Search falls back to BM25-only; embed_repo rebuilds them.
 *   - rebuild-fts  : DROP and recreate symbols_fts, then bulk-load it from
 *                    `symbols`. Used when FTS5 row count drifted from the
 *                    source table.
 *
 * Mirrors mempalace's `repair --mode <…>` family (#1310, #1342, #1357,
 * #1364, #1287). Destructive — every mode is gated behind explicit user
 * intent at the MCP / CLI surface.
 */
import type Database from 'better-sqlite3';

export type RepairMode = 'drop-orphans' | 'drop-vec' | 'rebuild-fts';

export interface RepairResult {
  mode: RepairMode;
  ok: boolean;
  detail: string;
  /** Rows deleted / rebuilt — varies by mode. */
  affected: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1`)
    .get(name);
  return r !== undefined;
}

function dropOrphans(db: Database.Database): RepairResult {
  if (!tableExists(db, 'symbol_embeddings')) {
    return {
      mode: 'drop-orphans',
      ok: true,
      detail: 'No symbol_embeddings table — nothing to drop',
      affected: 0,
    };
  }
  const tx = db.transaction(() => {
    const info = db
      .prepare(`DELETE FROM symbol_embeddings WHERE symbol_id NOT IN (SELECT id FROM symbols)`)
      .run();
    return info.changes;
  });
  const affected = tx();
  return {
    mode: 'drop-orphans',
    ok: true,
    detail: `Deleted ${affected} orphan embedding row(s)`,
    affected,
  };
}

function dropVec(db: Database.Database): RepairResult {
  let affected = 0;
  const tx = db.transaction(() => {
    if (tableExists(db, 'symbol_embeddings')) {
      const r = db.prepare('SELECT COUNT(*) AS c FROM symbol_embeddings').get() as
        | { c: number }
        | undefined;
      affected = r?.c ?? 0;
      db.exec('DROP TABLE symbol_embeddings');
    }
    if (tableExists(db, 'embedding_meta')) {
      db.exec('DROP TABLE embedding_meta');
    }
  });
  tx();
  return {
    mode: 'drop-vec',
    ok: true,
    detail: `Dropped vector store (${affected} embeddings discarded). Run embed_repo to rebuild.`,
    affected,
  };
}

function rebuildFts(db: Database.Database): RepairResult {
  if (!tableExists(db, 'symbols')) {
    return {
      mode: 'rebuild-fts',
      ok: false,
      detail: 'symbols table missing — nothing to rebuild from',
      affected: 0,
    };
  }
  let affected = 0;
  const tx = db.transaction(() => {
    if (tableExists(db, 'symbols_fts')) {
      db.exec('DROP TABLE symbols_fts');
    }
    // The canonical FTS schema lives in src/db/schema.ts. Rebuild it via the
    // exact DDL so the column order matches.
    db.exec(`
      CREATE VIRTUAL TABLE symbols_fts USING fts5(
        name,
        fqn,
        signature,
        summary,
        content='symbols',
        content_rowid='id'
      )
    `);
    const info = db
      .prepare(
        `INSERT INTO symbols_fts (rowid, name, fqn, signature, summary)
         SELECT id, name, fqn, signature, summary FROM symbols`,
      )
      .run();
    affected = info.changes;
  });
  tx();
  return {
    mode: 'rebuild-fts',
    ok: true,
    detail: `Rebuilt symbols_fts (${affected} rows reloaded)`,
    affected,
  };
}

/**
 * Apply a repair mode to the given database. Each mode is wrapped in a
 * SQLite transaction so a partial failure leaves the DB unchanged.
 */
export function repairIndex(db: Database.Database, mode: RepairMode): RepairResult {
  switch (mode) {
    case 'drop-orphans':
      return dropOrphans(db);
    case 'drop-vec':
      return dropVec(db);
    case 'rebuild-fts':
      return rebuildFts(db);
    default: {
      // exhaustiveness — TypeScript flags any missed mode
      const _never: never = mode;
      throw new Error(`Unknown repair mode: ${String(_never)}`);
    }
  }
}
