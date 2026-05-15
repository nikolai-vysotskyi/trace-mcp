/**
 * Behavioural coverage for `graphQuery()`. Seeds a small symbol graph with
 * `calls` edges, then drives the NL query → subgraph pipeline. Asserts the
 * output envelope (nodes/edges/mermaid), depth + max_nodes honouring, and
 * the empty / no-anchor contracts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { graphQuery } from '../../../src/tools/analysis/graph-query.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

/**
 * Topology:
 *   AuthService -> TokenStore -> Database (chain of `calls`)
 *   UserModel (isolated symbol)
 *
 * "How does AuthService flow to Database?" → 'path' intent, two anchors.
 * "What depends on TokenStore?" → 'dependents' intent, one anchor.
 */
function seed(): Fixture {
  const store = createTestStore();

  const mkSym = (file: string, name: string, hash: string) => {
    const fid = store.insertFile(file, 'typescript', hash, 100);
    const sid = `${file}::${name}#class`;
    const symRow = store.insertSymbol(fid, {
      symbolId: sid,
      name,
      kind: 'class',
      fqn: name,
      byteStart: 0,
      byteEnd: 50,
      lineStart: 1,
      lineEnd: 8,
    });
    return { sid, nid: store.getNodeId('symbol', symRow)! };
  };

  const auth = mkSym('src/AuthService.ts', 'AuthService', 'h-auth');
  const token = mkSym('src/TokenStore.ts', 'TokenStore', 'h-token');
  const db = mkSym('src/Database.ts', 'Database', 'h-db');
  mkSym('src/UserModel.ts', 'UserModel', 'h-user');

  store.insertEdge(auth.nid, token.nid, 'calls', true, undefined, false, 'ast_resolved');
  store.insertEdge(token.nid, db.nid, 'calls', true, undefined, false, 'ast_resolved');

  return { store };
}

describe('graphQuery() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('two-anchor NL query returns subgraph with nodes, edges, and mermaid', () => {
    const result = graphQuery(ctx.store, 'How does AuthService flow to Database?', { depth: 3 });
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(Array.isArray(out.nodes)).toBe(true);
    expect(Array.isArray(out.edges)).toBe(true);
    expect(typeof out.mermaid).toBe('string');
    const names = out.nodes.map((n) => n.name).sort();
    expect(names).toContain('AuthService');
    expect(names).toContain('Database');
    // Mermaid must be a non-empty diagram.
    expect(out.mermaid.length).toBeGreaterThan(0);
    expect(out.mermaid.toLowerCase()).toMatch(/graph|flowchart/);
  });

  it('output envelope: query, intent, anchors, nodes, edges, mermaid', () => {
    const result = graphQuery(ctx.store, 'What depends on TokenStore?');
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(typeof out.query).toBe('string');
    expect(typeof out.intent).toBe('string');
    expect(Array.isArray(out.anchors)).toBe(true);
    expect(out.anchors.length).toBeGreaterThan(0);
    expect(Array.isArray(out.nodes)).toBe(true);
    expect(Array.isArray(out.edges)).toBe(true);
    expect(typeof out.mermaid).toBe('string');
  });

  it('depth=3 reaches more (or equal) nodes than depth=1 on a chain', () => {
    const shallow = graphQuery(ctx.store, 'What depends on Database?', { depth: 1 });
    const deep = graphQuery(ctx.store, 'What depends on Database?', { depth: 3 });
    expect(shallow.isOk() && deep.isOk()).toBe(true);
    const shallowCount = shallow._unsafeUnwrap().nodes.length;
    const deepCount = deep._unsafeUnwrap().nodes.length;
    // depth=1 from Database (incoming) reaches TokenStore.
    // depth=3 reaches TokenStore + AuthService — strictly more.
    expect(deepCount).toBeGreaterThan(shallowCount);
  });

  it('max_nodes caps the returned node count', () => {
    const result = graphQuery(ctx.store, 'trace flow of AuthService', {
      depth: 5,
      max_nodes: 2,
    });
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.nodes.length).toBeLessThanOrEqual(2);
  });

  it('unresolvable anchor yields a NOT_FOUND-style error envelope', () => {
    const result = graphQuery(ctx.store, 'What depends on ThisSymbolDoesNotExist?');
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(typeof e.code).toBe('string');
    expect(e.code.length).toBeGreaterThan(0);
  });
});
