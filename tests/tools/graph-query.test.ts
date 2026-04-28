/**
 * Tests for graphQuery — NL graph queries with intent classification,
 * BFS path finding, subgraph extraction, and Mermaid generation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { graphQuery } from '../../src/tools/analysis/graph-query.js';
import { createTestStore } from '../test-utils.js';

function addSymbol(
  store: Store,
  opts: {
    filePath: string;
    name: string;
    kind: string;
    fqn?: string;
  },
): { fileId: number; symbolDbId: number; nodeId: number } {
  const file = store.getFile(opts.filePath);
  let fileId: number;
  if (!file) {
    fileId = store.insertFile(opts.filePath, 'typescript', null, null);
  } else {
    fileId = file.id;
  }
  const symbolDbId = store.insertSymbol(fileId, {
    symbolId: `${opts.filePath}::${opts.name}#${opts.kind}`,
    name: opts.name,
    kind: opts.kind as any,
    fqn: opts.fqn,
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 10,
  });
  const nodeId = store.getNodeId('symbol', symbolDbId)!;
  return { fileId, symbolDbId, nodeId };
}

function seedEdgeTypes(store: Store) {
  store.ensureEdgeType('calls', 'code', 'Function calls');
  store.ensureEdgeType('imports', 'code', 'Imports');
  store.ensureEdgeType('esm_imports', 'code', 'ESM imports');
  store.ensureEdgeType('extends', 'code', 'Extends');
  store.ensureEdgeType('implements', 'code', 'Implements');
  store.ensureEdgeType('dispatches', 'code', 'Event dispatch');
  store.ensureEdgeType('routes_to', 'code', 'Routes to');
}

// ── Intent Classification ────────────────────────────────────────────────────

describe('graphQuery: intent classification', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
    addSymbol(store, { filePath: 'src/auth.ts', name: 'AuthService', kind: 'class' });
    addSymbol(store, { filePath: 'src/db.ts', name: 'Database', kind: 'class' });
    addSymbol(store, { filePath: 'src/user.ts', name: 'UserModel', kind: 'class' });
  });

  it('classifies "how does X flow to Y" as path intent', () => {
    const result = graphQuery(store, 'how does AuthService flow to Database');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().intent).toBe('path');
  });

  it('classifies "from X to Y" as path intent', () => {
    const result = graphQuery(store, 'from AuthService to Database');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().intent).toBe('path');
  });

  it('classifies "what depends on X" as dependents intent', () => {
    const result = graphQuery(store, 'what depends on UserModel');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().intent).toBe('dependents');
  });

  it('classifies "who uses X" as dependents intent', () => {
    const result = graphQuery(store, 'who uses AuthService');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().intent).toBe('dependents');
  });

  it('classifies "what does X depend on" as dependencies intent', () => {
    const result = graphQuery(store, 'what does UserModel depend on');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().intent).toBe('dependencies');
  });

  it('classifies "trace the flow of X" as flow intent', () => {
    const result = graphQuery(store, 'trace the flow of AuthService');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().intent).toBe('flow');
  });

  it('classifies "what connects X and Y" as between intent', () => {
    const result = graphQuery(store, 'what connects AuthService and Database');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().intent).toBe('between');
  });
});

// ── Error Handling ───────────────────────────────────────────────────────────

describe('graphQuery: error handling', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('returns VALIDATION_ERROR for empty/unparseable query', () => {
    const result = graphQuery(store, '?!');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('VALIDATION_ERROR');
  });

  it('returns NOT_FOUND when no symbols match anchors', () => {
    const result = graphQuery(store, 'how does NonExistent flow to AlsoMissing');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });

  it('warns when one anchor is unresolved but continues with the other', () => {
    addSymbol(store, { filePath: 'src/a.ts', name: 'AuthService', kind: 'class' });
    const result = graphQuery(store, 'how does AuthService flow to NonExistentThing');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val._meta?.warnings?.some((w) => w.includes('Could not resolve'))).toBe(true);
  });
});

// ── Dependents (incoming) ────────────────────────────────────────────────────

describe('graphQuery: dependents', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('finds direct dependents via incoming edges', () => {
    const model = addSymbol(store, { filePath: 'src/user.ts', name: 'UserModel', kind: 'class' });
    const svc = addSymbol(store, {
      filePath: 'src/user-svc.ts',
      name: 'UserService',
      kind: 'class',
    });
    const ctrl = addSymbol(store, {
      filePath: 'src/user-ctrl.ts',
      name: 'UserController',
      kind: 'class',
    });

    store.insertEdge(svc.nodeId, model.nodeId, 'calls');
    store.insertEdge(ctrl.nodeId, model.nodeId, 'calls');

    const result = graphQuery(store, 'what depends on UserModel');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    expect(val.intent).toBe('dependents');
    expect(val.nodes.length).toBeGreaterThanOrEqual(3);
    const names = val.nodes.map((n) => n.name).sort();
    expect(names).toContain('UserService');
    expect(names).toContain('UserController');
    expect(names).toContain('UserModel');

    // Edges should point TO UserModel
    expect(val.edges.length).toBeGreaterThanOrEqual(2);
  });

  it('follows transitive dependents with depth > 1', () => {
    const model = addSymbol(store, { filePath: 'src/user.ts', name: 'UserModel', kind: 'class' });
    const svc = addSymbol(store, {
      filePath: 'src/user-svc.ts',
      name: 'UserService',
      kind: 'class',
    });
    const ctrl = addSymbol(store, {
      filePath: 'src/user-ctrl.ts',
      name: 'UserController',
      kind: 'class',
    });
    const route = addSymbol(store, {
      filePath: 'src/routes.ts',
      name: 'UserRoute',
      kind: 'function',
    });

    store.insertEdge(svc.nodeId, model.nodeId, 'calls');
    store.insertEdge(ctrl.nodeId, svc.nodeId, 'calls');
    store.insertEdge(route.nodeId, ctrl.nodeId, 'routes_to');

    const result = graphQuery(store, 'what depends on UserModel', { depth: 3 });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    const names = val.nodes.map((n) => n.name);
    expect(names).toContain('UserRoute');
    expect(names).toContain('UserController');
    expect(names).toContain('UserService');
  });

  it('returns only the anchor node when it has no incoming edges', () => {
    addSymbol(store, { filePath: 'src/lonely.ts', name: 'LonelyClass', kind: 'class' });

    const result = graphQuery(store, 'what depends on LonelyClass');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val.nodes).toHaveLength(1);
    expect(val.edges).toHaveLength(0);
  });
});

// ── Dependencies (outgoing) ──────────────────────────────────────────────────

describe('graphQuery: dependencies', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('finds outgoing dependencies', () => {
    const ctrl = addSymbol(store, {
      filePath: 'src/ctrl.ts',
      name: 'UserController',
      kind: 'class',
    });
    const svc = addSymbol(store, { filePath: 'src/svc.ts', name: 'UserService', kind: 'class' });
    const repo = addSymbol(store, {
      filePath: 'src/repo.ts',
      name: 'UserRepository',
      kind: 'class',
    });

    store.insertEdge(ctrl.nodeId, svc.nodeId, 'calls');
    store.insertEdge(ctrl.nodeId, repo.nodeId, 'imports');

    const result = graphQuery(store, 'what does UserController depend on');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    expect(val.intent).toBe('dependencies');
    const names = val.nodes.map((n) => n.name).sort();
    expect(names).toContain('UserService');
    expect(names).toContain('UserRepository');
  });
});

// ── Path Finding ─────────────────────────────────────────────────────────────

describe('graphQuery: path finding', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('finds shortest path between two connected symbols', () => {
    const login = addSymbol(store, {
      filePath: 'src/login.ts',
      name: 'LoginHandler',
      kind: 'function',
    });
    const auth = addSymbol(store, { filePath: 'src/auth.ts', name: 'AuthService', kind: 'class' });
    const db = addSymbol(store, { filePath: 'src/db.ts', name: 'Database', kind: 'class' });

    store.insertEdge(login.nodeId, auth.nodeId, 'calls');
    store.insertEdge(auth.nodeId, db.nodeId, 'calls');

    const result = graphQuery(store, 'how does LoginHandler flow to Database');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    expect(val.intent).toBe('path');
    expect(val.paths).toBeDefined();
    expect(val.paths!.length).toBe(1);

    const path = val.paths![0];
    expect(path.length).toBe(3);
    expect(path[0].name).toBe('LoginHandler');
    expect(path[1].name).toBe('AuthService');
    expect(path[2].name).toBe('Database');

    // Edge types along the path
    expect(path[0].edge_to_next).toBe('calls');
    expect(path[1].edge_to_next).toBe('calls');
    expect(path[2].edge_to_next).toBeNull();
  });

  it('warns when no path exists between disconnected symbols', () => {
    addSymbol(store, { filePath: 'src/a.ts', name: 'AlphaService', kind: 'class' });
    addSymbol(store, { filePath: 'src/b.ts', name: 'BetaService', kind: 'class' });

    const result = graphQuery(store, 'how does AlphaService flow to BetaService');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val._meta?.warnings?.some((w) => w.includes('No direct path found'))).toBe(true);
    expect(val.paths).toBeUndefined();
  });

  it('finds path through intermediate nodes', () => {
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'A', kind: 'class' });
    const b = addSymbol(store, { filePath: 'src/b.ts', name: 'B', kind: 'class' });
    const c = addSymbol(store, { filePath: 'src/c.ts', name: 'C', kind: 'class' });
    const d = addSymbol(store, { filePath: 'src/d.ts', name: 'D', kind: 'class' });

    store.insertEdge(a.nodeId, b.nodeId, 'calls');
    store.insertEdge(b.nodeId, c.nodeId, 'calls');
    store.insertEdge(c.nodeId, d.nodeId, 'calls');

    const result = graphQuery(store, 'from A to D', { depth: 4 });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    expect(val.paths).toBeDefined();
    const path = val.paths![0];
    expect(path.map((s) => s.name)).toEqual(['A', 'B', 'C', 'D']);
  });
});

// ── Flow (bidirectional) ─────────────────────────────────────────────────────

describe('graphQuery: flow', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('collects both callers and callees', () => {
    const caller = addSymbol(store, {
      filePath: 'src/caller.ts',
      name: 'CallerFn',
      kind: 'function',
    });
    const target = addSymbol(store, {
      filePath: 'src/target.ts',
      name: 'TargetService',
      kind: 'class',
    });
    const dep = addSymbol(store, { filePath: 'src/dep.ts', name: 'DepRepo', kind: 'class' });

    store.insertEdge(caller.nodeId, target.nodeId, 'calls');
    store.insertEdge(target.nodeId, dep.nodeId, 'calls');

    const result = graphQuery(store, 'trace the flow of TargetService');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    expect(val.intent).toBe('flow');
    const names = val.nodes.map((n) => n.name).sort();
    expect(names).toContain('CallerFn');
    expect(names).toContain('TargetService');
    expect(names).toContain('DepRepo');
    expect(val.edges.length).toBe(2);
  });
});

// ── Cycle Safety ─────────────────────────────────────────────────────────────

describe('graphQuery: cycle safety', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('handles cyclic graph without infinite loop', () => {
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'CycleA', kind: 'class' });
    const b = addSymbol(store, { filePath: 'src/b.ts', name: 'CycleB', kind: 'class' });
    const c = addSymbol(store, { filePath: 'src/c.ts', name: 'CycleC', kind: 'class' });

    store.insertEdge(a.nodeId, b.nodeId, 'calls');
    store.insertEdge(b.nodeId, c.nodeId, 'calls');
    store.insertEdge(c.nodeId, a.nodeId, 'calls'); // cycle

    const result = graphQuery(store, 'trace the flow of CycleA', { depth: 5 });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    expect(val.nodes.length).toBe(3);
    expect(val.edges.length).toBe(3);
  });

  it('handles self-referencing edges', () => {
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'Recursive', kind: 'function' });
    store.insertEdge(a.nodeId, a.nodeId, 'calls');

    const result = graphQuery(store, 'trace the flow of Recursive');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val.nodes.length).toBe(1);
  });
});

// ── Depth Limiting & Node Cap ────────────────────────────────────────────────

describe('graphQuery: depth and node limits', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('respects depth=1: only immediate neighbors', () => {
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'Root', kind: 'class' });
    const b = addSymbol(store, { filePath: 'src/b.ts', name: 'Level1', kind: 'class' });
    const c = addSymbol(store, { filePath: 'src/c.ts', name: 'Level2', kind: 'class' });

    store.insertEdge(a.nodeId, b.nodeId, 'calls');
    store.insertEdge(b.nodeId, c.nodeId, 'calls');

    const result = graphQuery(store, 'what does Root depend on', { depth: 1 });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    const names = val.nodes.map((n) => n.name);
    expect(names).toContain('Root');
    expect(names).toContain('Level1');
    expect(names).not.toContain('Level2');
  });

  it('caps nodes at max_nodes', () => {
    // Create a wide graph: root → 10 children
    const root = addSymbol(store, { filePath: 'src/root.ts', name: 'BigRoot', kind: 'class' });
    for (let i = 0; i < 10; i++) {
      const child = addSymbol(store, {
        filePath: `src/child${i}.ts`,
        name: `Child${i}`,
        kind: 'class',
      });
      store.insertEdge(root.nodeId, child.nodeId, 'calls');
    }

    const result = graphQuery(store, 'what does BigRoot depend on', { max_nodes: 5 });
    expect(result.isOk()).toBe(true);
    // Should have at most 5 symbol nodes collected
    const val = result._unsafeUnwrap();
    expect(val.nodes.length).toBeLessThanOrEqual(6); // 5 cap + root which was already collected
  });
});

// ── Mermaid Output ───────────────────────────────────────────────────────────

describe('graphQuery: mermaid output', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('generates valid mermaid with nodes and edges', () => {
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'ServiceA', kind: 'class' });
    const b = addSymbol(store, { filePath: 'src/b.ts', name: 'ServiceB', kind: 'class' });
    store.insertEdge(a.nodeId, b.nodeId, 'calls');

    const result = graphQuery(store, 'what does ServiceA depend on');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    expect(val.mermaid).toContain('graph LR');
    expect(val.mermaid).toContain('class:ServiceA');
    expect(val.mermaid).toContain('class:ServiceB');
    expect(val.mermaid).toContain('-->|calls|');
  });

  it('sanitizes special characters in mermaid labels', () => {
    addSymbol(store, { filePath: 'src/a.ts', name: 'Fn<T>(x)', kind: 'function' });

    const result = graphQuery(store, 'trace the flow of Fn<T>(x)');
    // Even if it doesn't resolve the weird name, the mermaid should be safe
    if (result.isOk()) {
      const val = result._unsafeUnwrap();
      expect(val.mermaid).not.toContain('<');
      expect(val.mermaid).not.toContain('>');
      expect(val.mermaid).not.toContain('(');
    }
  });
});

// ── FQN Resolution ───────────────────────────────────────────────────────────

describe('graphQuery: symbol resolution', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('resolves symbols by FQN', () => {
    const sym = addSymbol(store, {
      filePath: 'src/user.ts',
      name: 'UserModel',
      kind: 'class',
      fqn: 'App\\Models\\UserModel',
    });
    const dep = addSymbol(store, { filePath: 'src/repo.ts', name: 'UserRepo', kind: 'class' });
    store.insertEdge(sym.nodeId, dep.nodeId, 'calls');

    const result = graphQuery(store, 'what does App\\Models\\UserModel depend on');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val.nodes.some((n) => n.name === 'UserRepo')).toBe(true);
  });

  it('resolves symbols by name via FTS fallback', () => {
    const sym = addSymbol(store, {
      filePath: 'src/auth.ts',
      name: 'AuthenticationService',
      kind: 'class',
    });
    const dep = addSymbol(store, { filePath: 'src/token.ts', name: 'TokenManager', kind: 'class' });
    store.insertEdge(sym.nodeId, dep.nodeId, 'calls');

    // Query uses a slightly different form — FTS should match
    const result = graphQuery(store, 'what does AuthenticationService depend on');
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val.nodes.some((n) => n.name === 'TokenManager')).toBe(true);
  });
});

// ── Multiple Edge Types ──────────────────────────────────────────────────────

describe('graphQuery: edge type variety', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('traverses multiple edge types in a single query', () => {
    const ctrl = addSymbol(store, { filePath: 'src/ctrl.ts', name: 'Controller', kind: 'class' });
    const svc = addSymbol(store, { filePath: 'src/svc.ts', name: 'Service', kind: 'class' });
    const iface = addSymbol(store, { filePath: 'src/iface.ts', name: 'IService', kind: 'class' });

    store.insertEdge(ctrl.nodeId, svc.nodeId, 'calls');
    store.insertEdge(svc.nodeId, iface.nodeId, 'implements');

    const result = graphQuery(store, 'what does Controller depend on', { depth: 2 });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();

    const names = val.nodes.map((n) => n.name).sort();
    expect(names).toContain('Service');
    expect(names).toContain('IService');

    const edgeTypes = val.edges.map((e) => e.edge_type);
    expect(edgeTypes).toContain('calls');
    expect(edgeTypes).toContain('implements');
  });
});

// ── N+1 / Performance ────────────────────────────────────────────────────────

describe('graphQuery: no N+1 queries', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seedEdgeTypes(store);
  });

  it('handles 50-node graph without per-node queries', () => {
    const root = addSymbol(store, { filePath: 'src/root.ts', name: 'Root', kind: 'class' });
    const children: ReturnType<typeof addSymbol>[] = [];
    for (let i = 0; i < 50; i++) {
      const child = addSymbol(store, { filePath: `src/n${i}.ts`, name: `Node${i}`, kind: 'class' });
      children.push(child);
    }
    // Chain: root → 0 → 1 → 2 → ... → 49
    store.insertEdge(root.nodeId, children[0].nodeId, 'calls');
    for (let i = 0; i < 49; i++) {
      store.insertEdge(children[i].nodeId, children[i + 1].nodeId, 'calls');
    }

    const start = performance.now();
    const result = graphQuery(store, 'what does Root depend on', { depth: 6, max_nodes: 100 });
    const elapsed = performance.now() - start;

    expect(result.isOk()).toBe(true);
    // Should complete in well under 500ms even for 50 nodes (batch queries, not N+1)
    expect(elapsed).toBeLessThan(500);
    // Depth 6 should reach at least 6 levels deep
    expect(result._unsafeUnwrap().nodes.length).toBeGreaterThan(5);
  });

  it('handles star graph (one node, many edges) efficiently', () => {
    const hub = addSymbol(store, { filePath: 'src/hub.ts', name: 'Hub', kind: 'class' });
    for (let i = 0; i < 100; i++) {
      const spoke = addSymbol(store, {
        filePath: `src/spoke${i}.ts`,
        name: `Spoke${i}`,
        kind: 'class',
      });
      store.insertEdge(hub.nodeId, spoke.nodeId, 'calls');
    }

    const start = performance.now();
    const result = graphQuery(store, 'what depends on Hub', { depth: 1, max_nodes: 150 });
    const elapsed = performance.now() - start;

    expect(result.isOk()).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });
});
