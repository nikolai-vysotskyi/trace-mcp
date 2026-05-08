/**
 * Integration tests for the edges.confidence column + auto-seeding trigger.
 *
 * Existing plugin INSERTs across the codebase don't set `confidence`
 * explicitly. The trigger fills it from `resolution_tier` so we don't have
 * to widen every INSERT signature on landing — but if the trigger ever
 * regresses, the silent-failure mode is "every edge has 0.95 regardless
 * of tier and ranking returns to bucket-by-bucket behaviour." These
 * tests catch that.
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';

function makeFixture() {
  const db = initializeDatabase(':memory:');
  // Seed minimal node + edge_type rows so we can insert edges.
  db.prepare("INSERT INTO nodes (node_type, ref_id) VALUES ('symbol', 1)").run();
  db.prepare("INSERT INTO nodes (node_type, ref_id) VALUES ('symbol', 2)").run();
  const etRow = db.prepare("SELECT id FROM edge_types WHERE name = 'calls'").get() as {
    id: number;
  };
  return { db, etId: etRow.id };
}

describe('edge confidence trigger', () => {
  it('lsp_resolved insert auto-promotes confidence to 1.0', () => {
    const { db, etId } = makeFixture();
    db.prepare(
      `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, resolution_tier)
       VALUES (1, 2, ?, 1, 'lsp_resolved')`,
    ).run(etId);
    const row = db.prepare('SELECT confidence FROM edges WHERE source_node_id = 1').get() as {
      confidence: number;
    };
    expect(row.confidence).toBe(1.0);
  });

  it('ast_inferred insert auto-demotes confidence to 0.7', () => {
    const { db, etId } = makeFixture();
    db.prepare(
      `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, resolution_tier)
       VALUES (1, 2, ?, 1, 'ast_inferred')`,
    ).run(etId);
    const row = db.prepare('SELECT confidence FROM edges WHERE source_node_id = 1').get() as {
      confidence: number;
    };
    expect(row.confidence).toBeCloseTo(0.7);
  });

  it('text_matched insert auto-demotes confidence to 0.4', () => {
    const { db, etId } = makeFixture();
    db.prepare(
      `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, resolution_tier)
       VALUES (1, 2, ?, 1, 'text_matched')`,
    ).run(etId);
    const row = db.prepare('SELECT confidence FROM edges WHERE source_node_id = 1').get() as {
      confidence: number;
    };
    expect(row.confidence).toBeCloseTo(0.4);
  });

  it('ast_resolved insert keeps the default 0.95', () => {
    const { db, etId } = makeFixture();
    db.prepare(
      `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, resolution_tier)
       VALUES (1, 2, ?, 1, 'ast_resolved')`,
    ).run(etId);
    const row = db.prepare('SELECT confidence FROM edges WHERE source_node_id = 1').get() as {
      confidence: number;
    };
    expect(row.confidence).toBe(0.95);
  });

  it('plugin-supplied confidence overrides the trigger seed', () => {
    const { db, etId } = makeFixture();
    db.prepare(
      `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, resolution_tier, confidence)
       VALUES (1, 2, ?, 1, 'lsp_resolved', 0.55)`,
    ).run(etId);
    const row = db.prepare('SELECT confidence FROM edges WHERE source_node_id = 1').get() as {
      confidence: number;
    };
    // 0.55 != 0.95, so the trigger WHEN clause refuses to fire.
    expect(row.confidence).toBe(0.55);
  });
});
