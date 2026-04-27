/**
 * Tests for Class Hierarchy Analysis (CHA) — polymorphic call resolution.
 *
 * Verifies that find_usages, get_call_graph, and get_change_impact correctly
 * follow method calls through the class hierarchy via CHA expansion.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import { expandMethodViaCha, } from '../../src/tools/shared/cha.js';
import { findReferences } from '../../src/tools/framework/references.js';
import { getCallGraph } from '../../src/tools/framework/call-graph.js';

function addSymbol(
  store: Store,
  opts: {
    filePath: string;
    name: string;
    kind: string;
    fqn?: string;
    parentSymbolId?: string;
    metadata?: Record<string, unknown>;
  },
): { fileId: number; symbolDbId: number; nodeId: number; symbolId: string } {
  const file = store.getFile(opts.filePath);
  let fileId: number;
  if (!file) {
    fileId = store.insertFile(opts.filePath, 'typescript', null, null);
  } else {
    fileId = file.id;
  }
  const symbolId = `${opts.filePath}::${opts.name}#${opts.kind}`;
  const symbolDbId = store.insertSymbol(fileId, {
    symbolId,
    name: opts.name,
    kind: opts.kind as any,
    fqn: opts.fqn,
    parentSymbolId: opts.parentSymbolId,
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 10,
    metadata: opts.metadata,
  });
  const nodeId = store.getNodeId('symbol', symbolDbId)!;
  return { fileId, symbolDbId, nodeId, symbolId };
}

describe('CHA — expandMethodViaCha', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    store.ensureEdgeType('calls', 'code', 'Function calls');
    store.ensureEdgeType('ts_extends', 'typescript', 'TypeScript extends');
    store.ensureEdgeType('ts_implements', 'typescript', 'TypeScript implements');
  });

  it('returns self only for non-method symbols', () => {
    const fn = addSymbol(store, { filePath: 'src/a.ts', name: 'helper', kind: 'function' });
    const sym = store.getSymbolById(fn.symbolDbId)!;
    const matches = expandMethodViaCha(store, sym);
    expect(matches).toHaveLength(1);
    expect(matches[0].relation).toBe('self');
  });

  it('returns self only for method without parent class', () => {
    const method = addSymbol(store, { filePath: 'src/a.ts', name: 'doStuff', kind: 'method' });
    const sym = store.getSymbolById(method.symbolDbId)!;
    const matches = expandMethodViaCha(store, sym);
    expect(matches).toHaveLength(1);
    expect(matches[0].relation).toBe('self');
  });

  it('finds ancestor method via extends metadata', () => {
    // BaseClass.verify_token + SubClass extends BaseClass + SubClass.verify_token
    const base = addSymbol(store, {
      filePath: 'src/base.ts',
      name: 'BaseClass',
      kind: 'class',
    });
    const baseMethod = addSymbol(store, {
      filePath: 'src/base.ts',
      name: 'verify_token',
      kind: 'method',
      parentSymbolId: base.symbolId,
    });
    const sub = addSymbol(store, {
      filePath: 'src/sub.ts',
      name: 'SubClass',
      kind: 'class',
      metadata: { extends: 'BaseClass' },
    });
    const subMethod = addSymbol(store, {
      filePath: 'src/sub.ts',
      name: 'verify_token',
      kind: 'method',
      parentSymbolId: sub.symbolId,
    });

    // Add heritage edge
    store.insertEdge(sub.nodeId, base.nodeId, 'ts_extends');

    const sym = store.getSymbolById(subMethod.symbolDbId)!;
    const matches = expandMethodViaCha(store, sym);

    expect(matches.length).toBeGreaterThanOrEqual(2);
    const relations = matches.map((m) => m.relation);
    expect(relations).toContain('self');
    expect(relations).toContain('ancestor_method');

    const ancestorMatch = matches.find((m) => m.relation === 'ancestor_method');
    expect(ancestorMatch!.symbol.name).toBe('verify_token');
    expect(ancestorMatch!.symbol.id).toBe(baseMethod.symbolDbId);
  });

  it('finds descendant method via class hierarchy', () => {
    // BaseClass.process() → SubClass extends BaseClass → SubClass.process()
    const base = addSymbol(store, {
      filePath: 'src/base.ts',
      name: 'BaseClass',
      kind: 'class',
    });
    const baseMethod = addSymbol(store, {
      filePath: 'src/base.ts',
      name: 'process',
      kind: 'method',
      parentSymbolId: base.symbolId,
    });
    const sub = addSymbol(store, {
      filePath: 'src/sub.ts',
      name: 'SubClass',
      kind: 'class',
      metadata: { extends: 'BaseClass' },
    });
    const subMethod = addSymbol(store, {
      filePath: 'src/sub.ts',
      name: 'process',
      kind: 'method',
      parentSymbolId: sub.symbolId,
    });

    store.insertEdge(sub.nodeId, base.nodeId, 'ts_extends');

    // Query from base class method → should find descendant override
    const sym = store.getSymbolById(baseMethod.symbolDbId)!;
    const matches = expandMethodViaCha(store, sym);

    expect(matches.length).toBeGreaterThanOrEqual(2);
    const descendantMatch = matches.find((m) => m.relation === 'descendant_method');
    expect(descendantMatch).toBeDefined();
    expect(descendantMatch!.symbol.id).toBe(subMethod.symbolDbId);
  });

  it('finds methods across interface implementation', () => {
    // IAuthProvider.verify() + HubAuthProvider implements IAuthProvider + HubAuthProvider.verify()
    const iface = addSymbol(store, {
      filePath: 'src/auth.ts',
      name: 'IAuthProvider',
      kind: 'interface',
    });
    const ifaceMethod = addSymbol(store, {
      filePath: 'src/auth.ts',
      name: 'verify',
      kind: 'method',
      parentSymbolId: iface.symbolId,
    });
    const impl = addSymbol(store, {
      filePath: 'src/hub.ts',
      name: 'HubAuthProvider',
      kind: 'class',
      metadata: { implements: ['IAuthProvider'] },
    });
    const implMethod = addSymbol(store, {
      filePath: 'src/hub.ts',
      name: 'verify',
      kind: 'method',
      parentSymbolId: impl.symbolId,
    });

    store.insertEdge(impl.nodeId, iface.nodeId, 'ts_implements');

    // Query the implementation → should find interface method as ancestor
    const sym = store.getSymbolById(implMethod.symbolDbId)!;
    const matches = expandMethodViaCha(store, sym);
    const ancestorMatch = matches.find((m) => m.relation === 'ancestor_method');
    expect(ancestorMatch).toBeDefined();
    expect(ancestorMatch!.symbol.id).toBe(ifaceMethod.symbolDbId);

    // Query the interface method → should find implementation as descendant
    const ifaceSym = store.getSymbolById(ifaceMethod.symbolDbId)!;
    const ifaceMatches = expandMethodViaCha(store, ifaceSym);
    const descendantMatch = ifaceMatches.find((m) => m.relation === 'descendant_method');
    expect(descendantMatch).toBeDefined();
    expect(descendantMatch!.symbol.id).toBe(implMethod.symbolDbId);
  });

  it('handles multi-level hierarchy', () => {
    // A.m() → B extends A → B.m() → C extends B → C.m()
    const a = addSymbol(store, { filePath: 'src/a.ts', name: 'A', kind: 'class' });
    const am = addSymbol(store, {
      filePath: 'src/a.ts',
      name: 'm',
      kind: 'method',
      parentSymbolId: a.symbolId,
    });
    const b = addSymbol(store, {
      filePath: 'src/b.ts',
      name: 'B',
      kind: 'class',
      metadata: { extends: 'A' },
    });
    const bm = addSymbol(store, {
      filePath: 'src/b.ts',
      name: 'm',
      kind: 'method',
      parentSymbolId: b.symbolId,
    });
    const c = addSymbol(store, {
      filePath: 'src/c.ts',
      name: 'C',
      kind: 'class',
      metadata: { extends: 'B' },
    });
    const cm = addSymbol(store, {
      filePath: 'src/c.ts',
      name: 'm',
      kind: 'method',
      parentSymbolId: c.symbolId,
    });

    store.insertEdge(b.nodeId, a.nodeId, 'ts_extends');
    store.insertEdge(c.nodeId, b.nodeId, 'ts_extends');

    // From B.m() → should see A.m() (ancestor) and C.m() (descendant)
    const sym = store.getSymbolById(bm.symbolDbId)!;
    const matches = expandMethodViaCha(store, sym);
    expect(matches.length).toBeGreaterThanOrEqual(3);

    const names = new Set(matches.map((m) => `${m.relation}:${m.symbol.id}`));
    expect(names.has(`self:${bm.symbolDbId}`)).toBe(true);
    expect(names.has(`ancestor_method:${am.symbolDbId}`)).toBe(true);
    expect(names.has(`descendant_method:${cm.symbolDbId}`)).toBe(true);
  });
});

describe('CHA — find_usages integration', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    store.ensureEdgeType('calls', 'code', 'Function calls');
    store.ensureEdgeType('ts_extends', 'typescript', 'TypeScript extends');
  });

  it('finds callers of base class method when querying override (the core issue)', () => {
    // Setup: OAuthProvider.verify_token() + HubAuthProvider extends OAuthProvider + HubAuthProvider.verify_token()
    const base = addSymbol(store, {
      filePath: 'src/oauth.ts',
      name: 'OAuthProvider',
      kind: 'class',
    });
    const baseMethod = addSymbol(store, {
      filePath: 'src/oauth.ts',
      name: 'verify_token',
      kind: 'method',
      parentSymbolId: base.symbolId,
    });
    const sub = addSymbol(store, {
      filePath: 'src/hub.ts',
      name: 'HubAuthProvider',
      kind: 'class',
      metadata: { extends: 'OAuthProvider' },
    });
    const subMethod = addSymbol(store, {
      filePath: 'src/hub.ts',
      name: 'verify_token',
      kind: 'method',
      parentSymbolId: sub.symbolId,
    });

    store.insertEdge(sub.nodeId, base.nodeId, 'ts_extends');

    // Caller references OAuthProvider.verify_token (base class)
    const caller = addSymbol(store, {
      filePath: 'src/api_proxy.ts',
      name: 'proxyRequest',
      kind: 'function',
    });
    store.insertEdge(caller.nodeId, baseMethod.nodeId, 'calls');

    // Without CHA: querying HubAuthProvider.verify_token would find 0 references
    // With CHA: should find the caller via base class method
    const result = findReferences(store, { symbolId: subMethod.symbolId });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val.references.length).toBeGreaterThanOrEqual(1);

    const callerRef = val.references.find((r) => r.symbol?.name === 'proxyRequest');
    expect(callerRef).toBeDefined();
    expect(callerRef!.edge_type).toBe('calls');

    // Should report CHA expansion
    expect(val.cha_expansion).toBeDefined();
    expect(val.cha_expansion!.length).toBeGreaterThan(0);
  });

  it('finds callers of override when querying base class method', () => {
    const base = addSymbol(store, {
      filePath: 'src/base.ts',
      name: 'Base',
      kind: 'class',
    });
    const baseMethod = addSymbol(store, {
      filePath: 'src/base.ts',
      name: 'handle',
      kind: 'method',
      parentSymbolId: base.symbolId,
    });
    const sub = addSymbol(store, {
      filePath: 'src/sub.ts',
      name: 'Sub',
      kind: 'class',
      metadata: { extends: 'Base' },
    });
    const subMethod = addSymbol(store, {
      filePath: 'src/sub.ts',
      name: 'handle',
      kind: 'method',
      parentSymbolId: sub.symbolId,
    });

    store.insertEdge(sub.nodeId, base.nodeId, 'ts_extends');

    // Caller references Sub.handle (override)
    const caller = addSymbol(store, {
      filePath: 'src/app.ts',
      name: 'main',
      kind: 'function',
    });
    store.insertEdge(caller.nodeId, subMethod.nodeId, 'calls');

    // Querying Base.handle → should find caller of Sub.handle via CHA
    const result = findReferences(store, { symbolId: baseMethod.symbolId });
    expect(result.isOk()).toBe(true);
    const val = result._unsafeUnwrap();
    expect(val.references.length).toBeGreaterThanOrEqual(1);
    expect(val.references.some((r) => r.symbol?.name === 'main')).toBe(true);
  });
});

describe('CHA — get_call_graph integration', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    store.ensureEdgeType('calls', 'code', 'Function calls');
    store.ensureEdgeType('ts_extends', 'typescript', 'TypeScript extends');
  });

  it('includes callers of base class method in override call graph', () => {
    const base = addSymbol(store, {
      filePath: 'src/base.ts',
      name: 'Animal',
      kind: 'class',
    });
    const baseMethod = addSymbol(store, {
      filePath: 'src/base.ts',
      name: 'speak',
      kind: 'method',
      parentSymbolId: base.symbolId,
    });
    const sub = addSymbol(store, {
      filePath: 'src/dog.ts',
      name: 'Dog',
      kind: 'class',
      metadata: { extends: 'Animal' },
    });
    const subMethod = addSymbol(store, {
      filePath: 'src/dog.ts',
      name: 'speak',
      kind: 'method',
      parentSymbolId: sub.symbolId,
    });

    store.insertEdge(sub.nodeId, base.nodeId, 'ts_extends');

    // Caller calls Animal.speak (base class)
    const caller = addSymbol(store, {
      filePath: 'src/app.ts',
      name: 'makeNoise',
      kind: 'function',
    });
    store.insertEdge(caller.nodeId, baseMethod.nodeId, 'calls');

    // Call graph for Dog.speak → should include makeNoise as caller via CHA
    const result = getCallGraph(store, { symbolId: subMethod.symbolId });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root.name).toBe('speak');
    expect(graph.root.called_by).toBeDefined();
    expect(graph.root.called_by!.some((n) => n.name === 'makeNoise')).toBe(true);
  });

  it('includes callees of base class method in override call graph', () => {
    const base = addSymbol(store, {
      filePath: 'src/base.ts',
      name: 'Processor',
      kind: 'class',
    });
    const baseMethod = addSymbol(store, {
      filePath: 'src/base.ts',
      name: 'run',
      kind: 'method',
      parentSymbolId: base.symbolId,
    });
    const sub = addSymbol(store, {
      filePath: 'src/impl.ts',
      name: 'ConcreteProcessor',
      kind: 'class',
      metadata: { extends: 'Processor' },
    });
    const subMethod = addSymbol(store, {
      filePath: 'src/impl.ts',
      name: 'run',
      kind: 'method',
      parentSymbolId: sub.symbolId,
    });

    store.insertEdge(sub.nodeId, base.nodeId, 'ts_extends');

    // Base method calls a helper
    const helper = addSymbol(store, {
      filePath: 'src/utils.ts',
      name: 'validate',
      kind: 'function',
    });
    store.insertEdge(baseMethod.nodeId, helper.nodeId, 'calls');

    // Call graph for ConcreteProcessor.run → should include validate as callee via CHA
    const result = getCallGraph(store, { symbolId: subMethod.symbolId });
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.root.calls).toBeDefined();
    expect(graph.root.calls!.some((n) => n.name === 'validate')).toBe(true);
  });
});
