/**
 * Tests for the dependency-graph exporters.
 *
 * Each format has a small structural contract that downstream tools rely on:
 *   - graphml: well-formed XML, declares the keys we use, edges have
 *     edge_type + confidence
 *   - cypher: every node CREATE precedes every edge CREATE; relationship
 *     names are ALL_CAPS_UNDERSCORE
 *   - obsidian: one note per file with the FILE separator marker so the
 *     output can be split into a vault
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { exportGraph } from '../../src/tools/analysis/export-graph.js';

function fixture(): Store {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  // Two files + one symbol per file + an edge between them.
  const aFile = store.insertFile('src/auth/Service.ts', 'typescript', 'h-a', 100);
  const bFile = store.insertFile('src/payments/Gateway.ts', 'typescript', 'h-b', 100);
  store.insertSymbol(aFile, {
    symbolId: 'src/auth/Service.ts::Service#class',
    name: 'Service',
    kind: 'class',
    fqn: 'auth.Service',
    byteStart: 0,
    byteEnd: 1,
  });
  store.insertSymbol(bFile, {
    symbolId: 'src/payments/Gateway.ts::Gateway#class',
    name: 'Gateway',
    kind: 'class',
    fqn: 'payments.Gateway',
    byteStart: 0,
    byteEnd: 1,
  });
  store.ensureEdgeType('calls', 'core', 'Call edge');

  const aNode = store.getNodeId(
    'symbol',
    store.getSymbolBySymbolId('src/auth/Service.ts::Service#class')!.id,
  )!;
  const bNode = store.getNodeId(
    'symbol',
    store.getSymbolBySymbolId('src/payments/Gateway.ts::Gateway#class')!.id,
  )!;
  store.insertEdge(aNode, bNode, 'calls');
  return store;
}

describe('exportGraph — graphml', () => {
  it('returns well-formed XML with the expected keys', () => {
    const r = exportGraph(fixture(), 'graphml');
    expect(r.format).toBe('graphml');
    expect(r.content.startsWith('<?xml version="1.0"')).toBe(true);
    expect(r.content).toContain('<graphml');
    expect(r.content).toContain('attr.name="edge_type"');
    expect(r.content).toContain('attr.name="confidence"');
    expect(r.content).toMatch(/<edge\s+source="[^"]+"\s+target="[^"]+">/);
    expect(r.content).toContain('</graphml>');
  });

  it('escapes XML special characters in node ids', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    store.insertFile('src/<dangerous>.ts', 'typescript', 'h', 100);
    const r = exportGraph(store, 'graphml');
    expect(r.content).not.toContain('<dangerous>'); // raw must NOT appear
    expect(r.content).toContain('&lt;dangerous&gt;');
  });

  it('reports node + edge counts', () => {
    const r = exportGraph(fixture(), 'graphml');
    expect(r.node_count).toBeGreaterThanOrEqual(2);
    expect(r.edge_count).toBe(1);
  });
});

describe('exportGraph — cypher', () => {
  it('emits CREATE statements with valid relationship names', () => {
    const r = exportGraph(fixture(), 'cypher');
    expect(r.format).toBe('cypher');
    expect(r.content).toMatch(/CREATE \(:Symbol \{ id: 'src\/auth\/Service\.ts/);
    expect(r.content).toMatch(/\[:CALLS \{ confidence:/);
    // Relationship names must be ALL_CAPS_UNDERSCORE — Neo4j requirement.
    const relMatches = r.content.match(/\[:[^\s]+/g) ?? [];
    for (const m of relMatches) {
      const rel = m.slice(2);
      expect(rel).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it('escapes single quotes in id strings', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    store.insertFile("src/o'reilly.ts", 'typescript', 'h', 100);
    const r = exportGraph(store, 'cypher');
    expect(r.content).toContain("o\\'reilly");
  });
});

describe('exportGraph — obsidian', () => {
  it('emits a FILE separator per file note', () => {
    const r = exportGraph(fixture(), 'obsidian');
    expect(r.format).toBe('obsidian');
    const separators = (r.content.match(/<!--FILE: /g) ?? []).length;
    expect(separators).toBe(2);
  });

  it('uses [[wikilink]] format for outgoing edges', () => {
    const r = exportGraph(fixture(), 'obsidian');
    expect(r.content).toMatch(/\[\[[^\]]+\|[^\]]+\]\]/);
  });

  it('lists symbols under each file note', () => {
    const r = exportGraph(fixture(), 'obsidian');
    expect(r.content).toContain('## Symbols');
    expect(r.content).toContain('`Service`');
    expect(r.content).toContain('`Gateway`');
  });
});
