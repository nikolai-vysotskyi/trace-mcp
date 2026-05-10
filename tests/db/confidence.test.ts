/**
 * Tests for the edge-confidence numeric layer that sits on top of the
 * categorical resolution_tier column.
 *
 * Two contracts the rest of the codebase relies on:
 *   1. Tier order is preserved by the numeric score —
 *      lsp_resolved > ast_resolved > ast_inferred > text_matched.
 *      Ranking code that filters by `confidence >= 0.7` should pick up
 *      ast_resolved + lsp_resolved but not the heuristic tiers.
 *   2. normalizeConfidence is robust to garbage from plugin code paths —
 *      NaN, Infinity, negatives, > 1.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_BY_TIER,
  confidenceForTier,
  normalizeConfidence,
} from '../../src/db/confidence.js';
import { initializeDatabase } from '../../src/db/schema.js';

describe('confidenceForTier', () => {
  it('maps each known tier to the documented score', () => {
    expect(confidenceForTier('lsp_resolved')).toBe(1.0);
    expect(confidenceForTier('ast_resolved')).toBe(0.95);
    expect(confidenceForTier('ast_inferred')).toBe(0.7);
    expect(confidenceForTier('text_matched')).toBe(0.4);
  });

  it('preserves tier order', () => {
    expect(CONFIDENCE_BY_TIER.lsp_resolved).toBeGreaterThan(CONFIDENCE_BY_TIER.ast_resolved);
    expect(CONFIDENCE_BY_TIER.ast_resolved).toBeGreaterThan(CONFIDENCE_BY_TIER.ast_inferred);
    expect(CONFIDENCE_BY_TIER.ast_inferred).toBeGreaterThan(CONFIDENCE_BY_TIER.text_matched);
  });

  it('falls back to ast_resolved for unknown / undefined / null tiers', () => {
    expect(confidenceForTier(undefined)).toBe(0.95);
    expect(confidenceForTier(null)).toBe(0.95);
    expect(confidenceForTier('something_new')).toBe(0.95);
  });
});

describe('normalizeConfidence', () => {
  it('passes through valid scores in [0, 1]', () => {
    expect(normalizeConfidence(0, 'ast_resolved')).toBe(0);
    expect(normalizeConfidence(0.5, 'ast_resolved')).toBe(0.5);
    expect(normalizeConfidence(1, 'ast_resolved')).toBe(1);
  });

  it('clamps out-of-range values', () => {
    expect(normalizeConfidence(-0.3, 'ast_resolved')).toBe(0);
    expect(normalizeConfidence(1.5, 'ast_resolved')).toBe(1);
  });

  it('falls back to the tier default for NaN / Infinity / undefined', () => {
    expect(normalizeConfidence(undefined, 'lsp_resolved')).toBe(1.0);
    expect(normalizeConfidence(Number.NaN, 'ast_inferred')).toBe(0.7);
    expect(normalizeConfidence(Infinity, 'text_matched')).toBe(0.4);
  });
});

describe('edges_confidence_from_tier trigger contract', () => {
  // Bootstrap a real schema so we can exercise the SQL trigger end-to-end.
  // The contract this pins: the trigger normalises ONLY the SQL-default
  // confidence (0.95) when the tier disagrees; explicit non-default values
  // are preserved verbatim, by design (per src/db/confidence.ts header).
  function makeDb(): Database.Database {
    const db = initializeDatabase(':memory:');
    db.exec(`
      INSERT INTO files (id, path, indexed_at) VALUES (1, 'a.ts', '0'), (2, 'b.ts', '0');
      INSERT INTO nodes (id, node_type, ref_id) VALUES (1, 'file', 1), (2, 'file', 2);
    `);
    return db;
  }

  function insertEdge(
    db: Database.Database,
    tier: string,
    confidence?: number,
  ): { confidence: number; resolution_tier: string } {
    const edgeTypeId = (
      db.prepare("SELECT id FROM edge_types WHERE name = 'imports'").get() as { id: number }
    ).id;
    if (confidence === undefined) {
      db.prepare(
        `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolution_tier)
         VALUES (1, 2, ?, ?)`,
      ).run(edgeTypeId, tier);
    } else {
      db.prepare(
        `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolution_tier, confidence)
         VALUES (1, 2, ?, ?, ?)`,
      ).run(edgeTypeId, tier, confidence);
    }
    const row = db
      .prepare(
        'SELECT confidence, resolution_tier FROM edges WHERE source_node_id=1 AND target_node_id=2 ORDER BY id DESC LIMIT 1',
      )
      .get() as { confidence: number; resolution_tier: string };
    db.prepare('DELETE FROM edges').run();
    return row;
  }

  it('snaps SQL-default confidence to canonical for the tier', () => {
    const db = makeDb();
    expect(insertEdge(db, 'lsp_resolved').confidence).toBe(CONFIDENCE_BY_TIER.lsp_resolved);
    expect(insertEdge(db, 'ast_inferred').confidence).toBe(CONFIDENCE_BY_TIER.ast_inferred);
    expect(insertEdge(db, 'text_matched').confidence).toBe(CONFIDENCE_BY_TIER.text_matched);
  });

  it('leaves the SQL default in place when tier matches (ast_resolved)', () => {
    const db = makeDb();
    expect(insertEdge(db, 'ast_resolved').confidence).toBe(CONFIDENCE_BY_TIER.ast_resolved);
  });

  it('preserves explicit non-default plugin-supplied confidence verbatim', () => {
    // Plugin-supplied tuned value within a tier — trigger must NOT fire.
    const db = makeDb();
    expect(insertEdge(db, 'ast_inferred', 0.85).confidence).toBe(0.85);
    expect(insertEdge(db, 'lsp_resolved', 0.97).confidence).toBe(0.97);
    expect(insertEdge(db, 'text_matched', 0.5).confidence).toBe(0.5);
  });
});
