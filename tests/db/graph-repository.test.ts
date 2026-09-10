import { describe, expect, it } from 'vitest';
import { GraphRepository } from '../../src/db/repositories/graph-repository.js';
import { createTestStore } from '../test-utils.js';

describe('GraphRepository — node operations', () => {
  it('creates nodes and looks them up by (nodeType, refId) and nodeId', () => {
    const store = createTestStore();
    const repo = store.graph;

    const fileNodeId = repo.createNode('file', 101);
    const symNodeId = repo.createNode('symbol', 202);

    expect(fileNodeId).toBeGreaterThan(0);
    expect(symNodeId).toBeGreaterThan(fileNodeId);

    // getNodeId
    expect(repo.getNodeId('file', 101)).toBe(fileNodeId);
    expect(repo.getNodeId('symbol', 202)).toBe(symNodeId);
    expect(repo.getNodeId('file', 999)).toBeUndefined();
    expect(repo.getNodeId('nonexistent', 101)).toBeUndefined();

    // getNodeRef
    expect(repo.getNodeRef(fileNodeId)).toEqual({ nodeType: 'file', refId: 101 });
    expect(repo.getNodeRef(symNodeId)).toEqual({ nodeType: 'symbol', refId: 202 });
    expect(repo.getNodeRef(99999)).toBeUndefined();

    // getNodeByNodeId
    expect(repo.getNodeByNodeId(fileNodeId)).toEqual({ node_type: 'file', ref_id: 101 });
    expect(repo.getNodeByNodeId(symNodeId)).toEqual({ node_type: 'symbol', ref_id: 202 });
    expect(repo.getNodeByNodeId(99999)).toBeUndefined();
  });

  it('createNode is idempotent for the same (nodeType, refId)', () => {
    const store = createTestStore();
    const repo = store.graph;

    const id1 = repo.createNode('file', 42);
    const id2 = repo.createNode('file', 42);

    expect(id1).toBe(id2);
  });
});

describe('GraphRepository — edge insertions and types', () => {
  it('returns err on unknown edge type', () => {
    const store = createTestStore();
    const repo = store.graph;

    const n1 = repo.createNode('file', 1);
    const n2 = repo.createNode('file', 2);

    const result = repo.insertEdge(n1, n2, 'completely_unknown_edge_type');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('Unknown edge type: completely_unknown_edge_type');
    }
  });

  it('returns err when database constraint fails (foreign key violation)', () => {
    const store = createTestStore();
    const repo = store.graph;

    // 99999 and 88888 do not exist in nodes table
    const result = repo.insertEdge(99999, 88888, 'imports');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('FOREIGN KEY constraint failed');
    }
  });

  it('inserts edges with defaults and custom parameters', () => {
    const store = createTestStore();
    const repo = store.graph;

    const n1 = repo.createNode('file', 1);
    const n2 = repo.createNode('file', 2);
    const n3 = repo.createNode('file', 3);

    // Default parameters
    const r1 = repo.insertEdge(n1, n2, 'imports');
    expect(r1.isOk()).toBe(true);
    const edgeId1 = r1._unsafeUnwrap();
    expect(edgeId1).toBeGreaterThan(0);

    // Custom parameters
    const metadata = { line: 15, dynamic: true };
    const r2 = repo.insertEdge(n1, n3, 'references', false, metadata, true, 'lsp_resolved');
    expect(r2.isOk()).toBe(true);

    const outgoing = repo.getOutgoingEdges(n1);
    expect(outgoing).toHaveLength(2);

    const defaultEdge = outgoing.find((e) => e.target_node_id === n2);
    expect(defaultEdge).toBeDefined();
    expect(defaultEdge!.edge_type_name).toBe('imports');
    expect(defaultEdge!.resolved).toBe(1);
    expect(defaultEdge!.metadata).toBeNull();
    expect(defaultEdge!.is_cross_ws).toBe(0);
    expect(defaultEdge!.resolution_tier).toBe('ast_resolved');

    const customEdge = outgoing.find((e) => e.target_node_id === n3);
    expect(customEdge).toBeDefined();
    expect(customEdge!.edge_type_name).toBe('references');
    expect(customEdge!.resolved).toBe(0);
    expect(JSON.parse(customEdge!.metadata!)).toEqual(metadata);
    expect(customEdge!.is_cross_ws).toBe(1);
    expect(customEdge!.resolution_tier).toBe('lsp_resolved');
  });

  it('updates metadata, resolved status, and tier on conflict', () => {
    const store = createTestStore();
    const repo = store.graph;

    const n1 = repo.createNode('file', 1);
    const n2 = repo.createNode('file', 2);

    repo.insertEdge(n1, n2, 'imports', true, { stage: 1 }, false, 'ast_resolved');

    // Re-insert same source, target, edge_type with updated metadata and resolved = false
    const r2 = repo.insertEdge(n1, n2, 'imports', false, { stage: 2 }, false, 'ast_inferred');
    expect(r2.isOk()).toBe(true);

    const edges = repo.getEdgesByType('imports');
    const matched = edges.filter((e) => e.source_node_id === n1 && e.target_node_id === n2);
    expect(matched).toHaveLength(1);
    expect(matched[0].resolved).toBe(0);
    expect(matched[0].resolution_tier).toBe('ast_inferred');
    expect(JSON.parse(matched[0].metadata!)).toEqual({ stage: 2 });
  });

  it('ensures edge types, retrieves edge types list, and looks up edge type name by ID', () => {
    const store = createTestStore();
    const repo = store.graph;

    repo.ensureEdgeType('custom_test_edge', 'dependency', 'A custom test edge');
    // Calling again is idempotent
    repo.ensureEdgeType('custom_test_edge', 'dependency', 'A custom test edge');

    const allTypes = repo.getEdgeTypes();
    expect(allTypes.length).toBeGreaterThan(0);
    // Checked sorting by name ascending
    for (let i = 1; i < allTypes.length; i++) {
      expect(allTypes[i - 1].name.localeCompare(allTypes[i].name)).toBeLessThanOrEqual(0);
    }

    const customType = allTypes.find((t) => t.name === 'custom_test_edge');
    expect(customType).toBeDefined();
    expect(customType!.category).toBe('dependency');
    expect(customType!.description).toBe('A custom test edge');

    // Test COALESCE(description, '') with NULL description
    store.db
      .prepare(
        'INSERT INTO edge_types (name, category, directed, description) VALUES (?, ?, 1, NULL)',
      )
      .run('null_desc_edge', 'custom');
    const allTypesAfterNull = repo.getEdgeTypes();
    const nullType = allTypesAfterNull.find((t) => t.name === 'null_desc_edge');
    expect(nullType).toBeDefined();
    expect(nullType!.description).toBe('');

    // getEdgeTypeName
    const customRow = store.db
      .prepare('SELECT id FROM edge_types WHERE name = ?')
      .get('custom_test_edge') as { id: number };
    expect(repo.getEdgeTypeName(customRow.id)).toBe('custom_test_edge');
    expect(repo.getEdgeTypeName(99999)).toBeUndefined();
  });

  it('handles getEdgesByType for existent and nonexistent types', () => {
    const store = createTestStore();
    const repo = store.graph;

    expect(repo.getEdgesByType('non_existent_type')).toEqual([]);

    const n1 = repo.createNode('file', 1);
    const n2 = repo.createNode('file', 2);
    repo.insertEdge(n1, n2, 'imports');

    const edges = repo.getEdgesByType('imports');
    expect(edges.some((e) => e.source_node_id === n1 && e.target_node_id === n2)).toBe(true);
  });
});

describe('GraphRepository — edge inspection and traversal', () => {
  it('returns incoming and outgoing edges for a node', () => {
    const store = createTestStore();
    const repo = store.graph;

    const n1 = repo.createNode('file', 1);
    const n2 = repo.createNode('file', 2);
    const n3 = repo.createNode('file', 3);

    repo.insertEdge(n1, n2, 'imports');
    repo.insertEdge(n3, n2, 'references');

    const outgoingN1 = repo.getOutgoingEdges(n1);
    expect(outgoingN1).toHaveLength(1);
    expect(outgoingN1[0].target_node_id).toBe(n2);
    expect(outgoingN1[0].edge_type_name).toBe('imports');

    const incomingN2 = repo.getIncomingEdges(n2);
    expect(incomingN2).toHaveLength(2);
    const sources = incomingN2.map((e) => e.source_node_id).sort();
    expect(sources).toEqual([n1, n3].sort());
    expect(incomingN2.find((e) => e.source_node_id === n1)!.edge_type_name).toBe('imports');
    expect(incomingN2.find((e) => e.source_node_id === n3)!.edge_type_name).toBe('references');

    expect(repo.getIncomingEdges(n1)).toHaveLength(0);
    expect(repo.getOutgoingEdges(n2)).toHaveLength(0);
  });

  it('traverses edges outgoing and incoming with depth limit and handles cycles', () => {
    const store = createTestStore();
    const repo = store.graph;

    // Linear chain: n1 -> n2 -> n3 -> n4
    const n1 = repo.createNode('symbol', 1);
    const n2 = repo.createNode('symbol', 2);
    const n3 = repo.createNode('symbol', 3);
    const n4 = repo.createNode('symbol', 4);

    repo.insertEdge(n1, n2, 'calls');
    repo.insertEdge(n2, n3, 'calls');
    repo.insertEdge(n3, n4, 'calls');

    // Outgoing depth 1: only n1 -> n2
    const outDepth1 = repo.traverseEdges(n1, 'outgoing', 1);
    expect(outDepth1).toHaveLength(1);
    expect(outDepth1[0].source_node_id).toBe(n1);
    expect(outDepth1[0].target_node_id).toBe(n2);

    // Outgoing depth 2: n1 -> n2 and n2 -> n3
    const outDepth2 = repo.traverseEdges(n1, 'outgoing', 2);
    expect(outDepth2).toHaveLength(2);
    expect(outDepth2.map((e) => `${e.source_node_id}->${e.target_node_id}`).sort()).toEqual([
      `${n1}->${n2}`,
      `${n2}->${n3}`,
    ]);

    // Outgoing depth 3: all 3 hops
    const outDepth3 = repo.traverseEdges(n1, 'outgoing', 3);
    expect(outDepth3).toHaveLength(3);

    // Incoming depth 1 from n4: only n3 -> n4
    const inDepth1 = repo.traverseEdges(n4, 'incoming', 1);
    expect(inDepth1).toHaveLength(1);
    expect(inDepth1[0].source_node_id).toBe(n3);
    expect(inDepth1[0].target_node_id).toBe(n4);

    // Incoming depth 2 from n4: n3 -> n4 and n2 -> n3
    const inDepth2 = repo.traverseEdges(n4, 'incoming', 2);
    expect(inDepth2).toHaveLength(2);

    // Cycle handling: add n4 -> n1
    repo.insertEdge(n4, n1, 'calls');
    const cycleOut = repo.traverseEdges(n1, 'outgoing', 5);
    // Distinct edges in the 4-edge cycle
    expect(cycleOut).toHaveLength(4);
  });
});

describe('GraphRepository — file and node deletion', () => {
  it('deleteEdgesForFileNodes removes edges for both file and symbol nodes in file', () => {
    const store = createTestStore();
    const repo = store.graph;

    const file1 = store.insertFile('src/a.ts', 'typescript', 'h1', 100);
    const file2 = store.insertFile('src/b.ts', 'typescript', 'h2', 100);
    const file3 = store.insertFile('src/c.ts', 'typescript', 'h3', 100);

    const sym1 = store.insertSymbol(file1, {
      name: 'fnA',
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
    });
    const sym2 = store.insertSymbol(file2, {
      name: 'fnB',
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
    });
    const sym3 = store.insertSymbol(file3, {
      name: 'fnC',
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
    });

    const fileNode1 = repo.getNodeId('file', file1)!;
    const fileNode2 = repo.getNodeId('file', file2)!;
    const fileNode3 = repo.getNodeId('file', file3)!;
    const symNode1 = repo.getNodeId('symbol', sym1)!;
    const symNode2 = repo.getNodeId('symbol', sym2)!;
    const symNode3 = repo.getNodeId('symbol', sym3)!;

    // Connect file1 and sym1 to others
    repo.insertEdge(fileNode1, fileNode2, 'imports');
    repo.insertEdge(fileNode3, fileNode1, 'imports');
    repo.insertEdge(symNode1, symNode2, 'calls');
    repo.insertEdge(symNode3, symNode1, 'calls');

    // File2 to file3 edge (should remain)
    repo.insertEdge(fileNode2, fileNode3, 'imports');
    repo.insertEdge(symNode2, symNode3, 'calls');

    repo.deleteEdgesForFileNodes(file1);

    // All edges touching fileNode1 or symNode1 should be gone
    expect(repo.getOutgoingEdges(fileNode1)).toHaveLength(0);
    expect(repo.getIncomingEdges(fileNode1)).toHaveLength(0);
    expect(repo.getOutgoingEdges(symNode1)).toHaveLength(0);
    expect(repo.getIncomingEdges(symNode1)).toHaveLength(0);

    // Unrelated edges between file2 and file3 remain
    expect(repo.getOutgoingEdges(fileNode2)).toHaveLength(1);
    expect(repo.getOutgoingEdges(symNode2)).toHaveLength(1);
  });

  it('deleteOutgoingImportEdges deletes only outgoing import edges from file node', () => {
    const store = createTestStore();
    const repo = store.graph;

    const file1 = store.insertFile('src/a.ts', 'typescript', 'h1', 100);
    const file2 = store.insertFile('src/b.ts', 'typescript', 'h2', 100);
    const file3 = store.insertFile('src/c.ts', 'typescript', 'h3', 100);

    const fNode1 = repo.getNodeId('file', file1)!;
    const fNode2 = repo.getNodeId('file', file2)!;
    const fNode3 = repo.getNodeId('file', file3)!;

    // Outgoing import edge from fNode1
    repo.insertEdge(fNode1, fNode2, 'imports');
    // Incoming import edge to fNode1
    repo.insertEdge(fNode3, fNode1, 'imports');
    // Outgoing non-import edge from fNode1
    repo.insertEdge(fNode1, fNode3, 'references');

    repo.deleteOutgoingImportEdges(file1);

    const outgoing = repo.getOutgoingEdges(fNode1);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].edge_type_name).toBe('references');

    const incoming = repo.getIncomingEdges(fNode1);
    expect(incoming).toHaveLength(1);
    expect(incoming[0].edge_type_name).toBe('imports');
  });

  it('deleteOutgoingEdgesForFileNodes removes outgoing edges but preserves incoming', () => {
    const store = createTestStore();
    const repo = store.graph;

    const file1 = store.insertFile('src/a.ts', 'typescript', 'h1', 100);
    const file2 = store.insertFile('src/b.ts', 'typescript', 'h2', 100);
    const sym1 = store.insertSymbol(file1, {
      name: 'symA',
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
    });
    const sym2 = store.insertSymbol(file2, {
      name: 'symB',
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
    });

    const fNode1 = repo.getNodeId('file', file1)!;
    const fNode2 = repo.getNodeId('file', file2)!;
    const sNode1 = repo.getNodeId('symbol', sym1)!;
    const sNode2 = repo.getNodeId('symbol', sym2)!;

    // Outgoing edges from file1
    repo.insertEdge(fNode1, fNode2, 'imports');
    repo.insertEdge(sNode1, sNode2, 'calls');

    // Incoming edges to file1
    repo.insertEdge(fNode2, fNode1, 'references');
    repo.insertEdge(sNode2, sNode1, 'references');

    repo.deleteOutgoingEdgesForFileNodes(file1);

    expect(repo.getOutgoingEdges(fNode1)).toHaveLength(0);
    expect(repo.getOutgoingEdges(sNode1)).toHaveLength(0);

    expect(repo.getIncomingEdges(fNode1)).toHaveLength(1);
    expect(repo.getIncomingEdges(sNode1)).toHaveLength(1);
  });
});

describe('GraphRepository — batch operations and chunking', () => {
  it('getNodeIdsBatch handles empty arrays, mappings, and chunking > 900 items', () => {
    const store = createTestStore();
    const repo = store.graph;

    expect(repo.getNodeIdsBatch('file', [])).toEqual(new Map());

    // Create 950 nodes to test the CHUNK = 900 boundary
    const TOTAL = 950;
    const refIds: number[] = [];
    const createdMap = new Map<number, number>();

    for (let i = 1; i <= TOTAL; i++) {
      refIds.push(i);
      const nodeId = repo.createNode('file', i);
      createdMap.set(i, nodeId);
    }

    const batchResult = repo.getNodeIdsBatch('file', refIds);
    expect(batchResult.size).toBe(TOTAL);
    for (let i = 1; i <= TOTAL; i++) {
      expect(batchResult.get(i)).toBe(createdMap.get(i));
    }

    // Nodes of a different type are excluded
    const symResult = repo.getNodeIdsBatch('symbol', refIds);
    expect(symResult.size).toBe(0);
  });

  it('getNodeRefsBatch handles empty arrays, mappings, and chunking > 900 items', () => {
    const store = createTestStore();
    const repo = store.graph;

    expect(repo.getNodeRefsBatch([])).toEqual(new Map());

    const TOTAL = 950;
    const nodeIds: number[] = [];

    for (let i = 1; i <= TOTAL; i++) {
      const type = i % 2 === 0 ? 'file' : 'symbol';
      const nodeId = repo.createNode(type, i * 10);
      nodeIds.push(nodeId);
    }

    const batchResult = repo.getNodeRefsBatch(nodeIds);
    expect(batchResult.size).toBe(TOTAL);

    for (let i = 1; i <= TOTAL; i++) {
      const nodeId = nodeIds[i - 1];
      const type = i % 2 === 0 ? 'file' : 'symbol';
      expect(batchResult.get(nodeId)).toEqual({
        nodeType: type,
        refId: i * 10,
      });
    }
  });

  it('getEdgesForNodesBatch annotates pivot_node_id, caches statements, and chunks > 450 items', () => {
    const store = createTestStore();
    const repo = store.graph;

    expect(repo.getEdgesForNodesBatch([])).toEqual([]);

    // Create a chain of nodes and edges
    const TOTAL = 500;
    const nodeIds: number[] = [];
    for (let i = 1; i <= TOTAL; i++) {
      nodeIds.push(repo.createNode('file', i));
    }

    for (let i = 0; i < TOTAL - 1; i++) {
      repo.insertEdge(nodeIds[i], nodeIds[i + 1], 'imports');
    }

    // 1. Single node batch where it is only target
    const targetOnly = repo.getEdgesForNodesBatch([nodeIds[1]]);
    // nodeIds[1] has 1 incoming (0->1) and 1 outgoing (1->2)
    expect(targetOnly).toHaveLength(2);
    const inEdge = targetOnly.find((e) => e.source_node_id === nodeIds[0]);
    expect(inEdge?.pivot_node_id).toBe(nodeIds[1]);
    const outEdge = targetOnly.find((e) => e.target_node_id === nodeIds[2]);
    expect(outEdge?.pivot_node_id).toBe(nodeIds[1]);

    // 2. Both source and target in nodeIds: pivot_node_id prioritizes source
    const bothNodes = repo.getEdgesForNodesBatch([nodeIds[0], nodeIds[1]]);
    const edge01 = bothNodes.find(
      (e) => e.source_node_id === nodeIds[0] && e.target_node_id === nodeIds[1],
    );
    expect(edge01).toBeDefined();
    expect(edge01!.pivot_node_id).toBe(nodeIds[0]);

    // 3. Test chunking with 500 items (CHUNK = 450)
    const allEdges = repo.getEdgesForNodesBatch(nodeIds);
    expect(allEdges.length).toBeGreaterThanOrEqual(TOTAL - 1);

    // 4. Test repeated calls to verify edgesForNodesCache statement reuse
    const allEdgesRepeated = repo.getEdgesForNodesBatch(nodeIds);
    expect(allEdgesRepeated.length).toBe(allEdges.length);
  });
});

describe('Store delegation to GraphRepository', () => {
  it('delegates node and edge operations from Store directly to GraphRepository', () => {
    const store = createTestStore();
    const nodeId1 = store.createNode('file', 50);
    const nodeId2 = store.createNode('file', 60);

    expect(store.getNodeId('file', 50)).toBe(nodeId1);
    expect(store.getNodeRef(nodeId1)).toEqual({ nodeType: 'file', refId: 50 });
    expect(store.getNodeByNodeId(nodeId1)).toEqual({ node_type: 'file', ref_id: 50 });

    const edgeRes = store.insertEdge(nodeId1, nodeId2, 'imports');
    expect(edgeRes.isOk()).toBe(true);

    expect(store.getOutgoingEdges(nodeId1)).toHaveLength(1);
    expect(store.getIncomingEdges(nodeId2)).toHaveLength(1);
    expect(store.getEdgesByType('imports')).toHaveLength(1);
    expect(store.traverseEdges(nodeId1, 'outgoing', 1)).toHaveLength(1);

    store.ensureEdgeType('store_delegated_type', 'test', 'desc');
    expect(store.getEdgeTypes().some((t) => t.name === 'store_delegated_type')).toBe(true);

    const typeId = (
      store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get('store_delegated_type') as {
        id: number;
      }
    ).id;
    expect(store.getEdgeTypeName(typeId)).toBe('store_delegated_type');

    expect(store.getNodeIdsBatch('file', [50]).get(50)).toBe(nodeId1);
    expect(store.getNodeRefsBatch([nodeId1]).get(nodeId1)).toEqual({ nodeType: 'file', refId: 50 });
    expect(store.getEdgesForNodesBatch([nodeId1])).toHaveLength(1);

    store.deleteOutgoingImportEdges(50);
    expect(store.getOutgoingEdges(nodeId1)).toHaveLength(0);

    store.insertEdge(nodeId1, nodeId2, 'imports');
    store.deleteOutgoingEdgesForFileNodes(50);
    expect(store.getOutgoingEdges(nodeId1)).toHaveLength(0);

    store.insertEdge(nodeId1, nodeId2, 'imports');
    store.deleteEdgesForFileNodes(50);
    expect(store.getOutgoingEdges(nodeId1)).toHaveLength(0);
  });
});
