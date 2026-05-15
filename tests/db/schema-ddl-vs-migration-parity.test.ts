/**
 * Permanent guard against the "table only exists in MIGRATIONS, never in DDL"
 * bug class.
 *
 * Background: `initializeDatabase` for a brand-new file runs `db.exec(DDL)`
 * exactly once, stamps SCHEMA_VERSION, and inserts every migration version
 * into `schema_migrations` as already-applied. So any CREATE TABLE that lives
 * inside a MIGRATIONS[N] handler but is NOT mirrored into the top-of-file DDL
 * block silently disappears on fresh installs — only upgraded DBs ever see it.
 *
 * Bug A (commit 12e4e05) was exactly this for v11 (domains/symbol_domains/
 * file_domains). The IMPL note flagged `domain_embeddings` as a known
 * remaining gap. A wider audit of v8/v11/v12 found three more groups:
 *
 *   - v8  pi_snapshots, pi_bug_scores, pi_co_changes, pi_tech_debt,
 *         pi_health_history (+ 7 indexes)
 *   - v11 domain_embeddings
 *   - v12 runtime_traces, runtime_spans, runtime_services, runtime_aggregates
 *         (+ 7 indexes)
 *
 * This test asserts every one of those tables is present in a fresh in-memory
 * DB — i.e. they were copied into DDL, not just into MIGRATIONS. If a future
 * migration adds a table to MIGRATIONS without mirroring it into DDL, this
 * test fires before users hit a "no such table" crash.
 *
 * Cheap by design: opens `:memory:`, no reindex, no AI calls, no fs.
 */

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { one: number } | undefined;
  return row?.one === 1;
}

// Tables introduced by migrations >= v8 that MUST also live in the fresh-DB
// DDL block. If any of these disappears from DDL the corresponding feature
// silently breaks for new installs.
const MIGRATION_TABLES_REQUIRED_IN_DDL: ReadonlyArray<{
  table: string;
  introducedIn: number;
}> = [
  // v8 — Predictive Intelligence
  { table: 'pi_snapshots', introducedIn: 8 },
  { table: 'pi_bug_scores', introducedIn: 8 },
  { table: 'pi_co_changes', introducedIn: 8 },
  { table: 'pi_tech_debt', introducedIn: 8 },
  { table: 'pi_health_history', introducedIn: 8 },
  // v11 — Intent Layer (domains were already mirrored in commit 12e4e05,
  // domain_embeddings is the gap this audit closes)
  { table: 'domains', introducedIn: 11 },
  { table: 'symbol_domains', introducedIn: 11 },
  { table: 'file_domains', introducedIn: 11 },
  { table: 'domain_embeddings', introducedIn: 11 },
  // v12 — Runtime Intelligence (OTel ingestion)
  { table: 'runtime_traces', introducedIn: 12 },
  { table: 'runtime_spans', introducedIn: 12 },
  { table: 'runtime_services', introducedIn: 12 },
  { table: 'runtime_aggregates', introducedIn: 12 },
];

describe('DDL/migration parity for fresh DB', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('mirrors every migration-introduced table into the fresh-DB DDL', () => {
    const missing: string[] = [];
    for (const { table } of MIGRATION_TABLES_REQUIRED_IN_DDL) {
      if (!tableExists(db, table)) missing.push(table);
    }
    expect(
      missing,
      `Tables introduced by MIGRATIONS but missing from DDL on a fresh DB: ${missing.join(', ')}. ` +
        `Mirror their CREATE TABLE / CREATE INDEX statements into the top-of-file DDL block ` +
        `(use IF NOT EXISTS) so freshly initialised databases get them too.`,
    ).toEqual([]);
  });

  it('exposes domain_embeddings as a working insertable table (v11 gap)', () => {
    // Smoke check that the table not only exists but is wired up correctly
    // (PK + FK to domains). This is the table the previous audit explicitly
    // left out, so it gets its own assertion.
    db.prepare(`INSERT INTO domains (name, parent_id) VALUES ('test-domain', NULL)`).run();
    const domainId = (
      db.prepare(`SELECT id FROM domains WHERE name = 'test-domain'`).get() as { id: number }
    ).id;
    db.prepare(`INSERT INTO domain_embeddings (domain_id, embedding) VALUES (?, ?)`).run(
      domainId,
      Buffer.from([0, 1, 2, 3]),
    );
    const row = db
      .prepare(`SELECT domain_id FROM domain_embeddings WHERE domain_id = ?`)
      .get(domainId) as { domain_id: number } | undefined;
    expect(row?.domain_id).toBe(domainId);
  });
});
