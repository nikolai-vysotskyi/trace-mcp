/**
 * Behavioural coverage for `exportGraph()`. Seeds files + symbols + an edge,
 * then verifies the GraphML/Cypher/Obsidian content shape, the max_nodes cap,
 * and the empty-store envelope (no throws, zero counts).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { exportGraph } from '../../../src/tools/analysis/export-graph.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

function seed(): Fixture {
  const store = createTestStore();
  const aId = store.insertFile('src/a.ts', 'typescript', 'h-a', 100);
  const bId = store.insertFile('src/b.ts', 'typescript', 'h-b', 100);

  store.insertSymbol(aId, {
    symbolId: 'src/a.ts::funcA#function',
    name: 'funcA',
    kind: 'function',
    fqn: 'funcA',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 3,
  });
  store.insertSymbol(bId, {
    symbolId: 'src/b.ts::ClassB#class',
    name: 'ClassB',
    kind: 'class',
    fqn: 'ClassB',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
  });

  const aNode = store.getNodeId('file', aId)!;
  const bNode = store.getNodeId('file', bId)!;
  store.insertEdge(aNode, bNode, 'esm_imports', true, undefined, false, 'ast_resolved');

  return { store };
}

describe('exportGraph() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it("format='graphml' returns valid GraphML XML with node/edge elements", () => {
    const result = exportGraph(ctx.store, 'graphml');
    expect(result.format).toBe('graphml');
    expect(typeof result.content).toBe('string');
    expect(result.content.startsWith('<?xml')).toBe(true);
    expect(result.content).toContain('<graphml');
    expect(result.content).toContain('<graph');
    expect(result.content).toContain('<node');
    expect(result.content).toContain('<edge');
    expect(result.node_count).toBeGreaterThan(0);
    expect(result.edge_count).toBeGreaterThanOrEqual(0);
  });

  it("format='cypher' returns CREATE statements + MATCH ... CREATE relationships", () => {
    const result = exportGraph(ctx.store, 'cypher');
    expect(result.format).toBe('cypher');
    expect(typeof result.content).toBe('string');
    // Cypher node + edge clauses use these exact tokens.
    expect(result.content).toContain('CREATE');
    expect(result.content.includes('MATCH') || result.edge_count === 0).toBe(true);
    expect(result.node_count).toBeGreaterThan(0);
  });

  it("format='obsidian' returns markdown vault content with [[wikilinks]]", () => {
    const result = exportGraph(ctx.store, 'obsidian');
    expect(result.format).toBe('obsidian');
    expect(typeof result.content).toBe('string');
    // File separator marker emitted per file note.
    expect(result.content).toContain('<!--FILE:');
    // Outgoing edges produce wikilinks. We have one esm_imports edge.
    expect(result.content).toMatch(/\[\[[^\]]+\|[^\]]+\]\]/);
  });

  it('max_nodes caps the node_count in the result', () => {
    // Add more files to push the node count up.
    for (let i = 0; i < 10; i++) {
      ctx.store.insertFile(`src/extra${i}.ts`, 'typescript', `h-e${i}`, 50);
    }

    const result = exportGraph(ctx.store, 'graphml', { max_nodes: 3 });
    expect(result.node_count).toBeLessThanOrEqual(3);
  });

  it('empty store returns an empty envelope, not a throw', () => {
    const empty = createTestStore();
    const result = exportGraph(empty, 'graphml');
    expect(result.format).toBe('graphml');
    expect(typeof result.content).toBe('string');
    expect(result.node_count).toBe(0);
    expect(result.edge_count).toBe(0);
  });

  it('output shape: { format, content, node_count, edge_count } for every format', () => {
    for (const fmt of ['graphml', 'cypher', 'obsidian'] as const) {
      const result = exportGraph(ctx.store, fmt);
      expect(result.format).toBe(fmt);
      expect(typeof result.content).toBe('string');
      expect(typeof result.node_count).toBe('number');
      expect(typeof result.edge_count).toBe('number');
    }
  });
});
