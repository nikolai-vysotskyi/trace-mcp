/**
 * Regression guard for TRA-924: the edge resolvers (typescript-calls,
 * python-calls, typescript-types, python-types, python-heritage) used to
 * gate their source SELECT with a leading-wildcard
 * `metadata LIKE '%"callSites"%'` (etc.), which SQLite can't serve from an
 * index -- it ran the LIKE pattern matcher over every symbol row's metadata
 * blob (89% of daemon profile samples). This runs BEFORE the pipeline's
 * post-pass `ANALYZE` (src/indexer/pipeline.ts), so sqlite_stat1 is empty or
 * stale exactly when these queries fire -- these checks deliberately don't
 * run ANALYZE either, to match that condition.
 *
 * The fix replaced those predicates with `json_extract(metadata, '$.x') IS
 * NOT NULL` and added matching partial indexes (idx_symbols_call_sites,
 * idx_symbols_type_refs, idx_symbols_bases). Assert the resolvers' actual
 * query shapes now avoid a bare full-table scan of `symbols`, so a future
 * edit can't silently reintroduce the LIKE scan.
 */

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';

describe('metadata-existence partial indexes (TRA-924)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('fresh DB ships idx_symbols_call_sites, idx_symbols_type_refs, idx_symbols_bases', () => {
    const idxRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
    }[];
    const names = new Set(idxRows.map((r) => r.name));

    expect(names.has('idx_symbols_call_sites')).toBe(true);
    expect(names.has('idx_symbols_type_refs')).toBe(true);
    expect(names.has('idx_symbols_bases')).toBe(true);
  });

  function planLines(sql: string, params: unknown[] = []): string[] {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>;
    return plan.map((p) => p.detail);
  }

  // A bare "SCAN s" line (no "USING INDEX ..." suffix) means SQLite is
  // walking every row of the symbols table -- the exact shape the LIKE scan
  // produced. Any indexed access (SEARCH, or SCAN ... USING INDEX) avoids it.
  function hasBareTableScan(lines: string[]): boolean {
    return lines.some((l) => /^SCAN s$/.test(l));
  }

  it('resolveTypeScriptCallEdges / resolvePythonCallEdges predicate avoids a bare symbols scan', () => {
    const lines = planLines(`
      SELECT s.id FROM symbols s
        JOIN files f ON s.file_id = f.id
       WHERE f.language IN ('typescript','javascript','tsx','jsx','vue')
         AND s.metadata IS NOT NULL
         AND json_extract(s.metadata, '$.callSites') IS NOT NULL
    `);
    expect(lines.join(' | ')).toContain('idx_symbols_call_sites');
    expect(hasBareTableScan(lines)).toBe(false);
  });

  it('scoped call-site query (file_id IN) seeks idx_symbols_call_sites', () => {
    const lines = planLines(
      `
      SELECT s.id FROM symbols s
        JOIN files f ON s.file_id = f.id
       WHERE f.language = 'python'
         AND s.metadata IS NOT NULL
         AND json_extract(s.metadata, '$.callSites') IS NOT NULL
         AND s.file_id IN (?, ?, ?)
    `,
      [1, 2, 3],
    );
    expect(lines.join(' | ')).toContain('idx_symbols_call_sites');
    expect(hasBareTableScan(lines)).toBe(false);
  });

  it('resolveTypeScriptTypeEdges / resolvePythonTypeEdges predicate avoids a bare symbols scan', () => {
    const lines = planLines(`
      SELECT s.id FROM symbols s
        JOIN files f ON s.file_id = f.id
       WHERE f.language = 'python'
         AND s.metadata IS NOT NULL
         AND json_extract(s.metadata, '$.typeRefs') IS NOT NULL
    `);
    expect(lines.join(' | ')).toContain('idx_symbols_type_refs');
    expect(hasBareTableScan(lines)).toBe(false);
  });

  it('scoped python-heritage query (file_id IN) seeks idx_symbols_bases', () => {
    // The unscoped heritage query also filters `s.kind = 'class'`, which the
    // pre-existing idx_symbols_kind already made index-driven even under the
    // old LIKE predicate -- so idx_symbols_bases's contribution shows up in
    // the scoped (incremental-reindex) branch, where it out-competes
    // idx_symbols_kind for the combined file_id + metadata-presence filter.
    const lines = planLines(
      `
      SELECT s.id, s.name, s.metadata FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE f.language = 'python' AND s.kind = 'class'
             AND s.metadata IS NOT NULL AND json_extract(s.metadata, '$.bases') IS NOT NULL
             AND f.id IN (?, ?, ?)
    `,
      [1, 2, 3],
    );
    expect(lines.join(' | ')).toContain('idx_symbols_bases');
    expect(hasBareTableScan(lines)).toBe(false);
  });
});

// TRA-940 follow-up: src/tools/quality/antipatterns.ts had three more
// occurrences of the same `metadata LIKE '%"callSites"%'` pattern that
// TRA-924 didn't cover (it named only the 5 edge-resolver files). Fixed by
// reusing the same idx_symbols_call_sites partial index -- no new migration.
describe('antipatterns.ts callSites queries avoid a bare symbols scan (TRA-940)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function planLines(sql: string): string[] {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
    return plan.map((p) => p.detail);
  }

  function hasBareTableScan(lines: string[]): boolean {
    return lines.some((l) => /^SCAN s$/.test(l));
  }

  it('event-listener-leak callSites query seeks idx_symbols_call_sites', () => {
    const lines = planLines(`
      SELECT s.id, s.file_id, s.symbol_id, s.name, s.kind, s.parent_id, s.line_start, s.metadata,
             f.path as file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.metadata IS NOT NULL
        AND json_extract(s.metadata, '$.callSites') IS NOT NULL
        AND f.gitignored = 0
    `);
    expect(lines.join(' | ')).toContain('idx_symbols_call_sites');
    expect(hasBareTableScan(lines)).toBe(false);
  });

  it('memory-leak handler-candidates callSites query seeks idx_symbols_call_sites', () => {
    const lines = planLines(`
      SELECT s.id, s.file_id, s.symbol_id, s.name, s.line_start, s.metadata,
             f.path as file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.metadata IS NOT NULL
        AND json_extract(s.metadata, '$.callSites') IS NOT NULL
        AND f.gitignored = 0
    `);
    expect(lines.join(' | ')).toContain('idx_symbols_call_sites');
    expect(hasBareTableScan(lines)).toBe(false);
  });

  it('callSiteFileCount query seeks idx_symbols_call_sites', () => {
    const lines = planLines(`
      SELECT COUNT(DISTINCT s.file_id) AS n
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.metadata IS NOT NULL
        AND json_extract(s.metadata, '$.callSites') IS NOT NULL
        AND f.gitignored = 0
    `);
    expect(lines.join(' | ')).toContain('idx_symbols_call_sites');
    expect(hasBareTableScan(lines)).toBe(false);
  });
});
