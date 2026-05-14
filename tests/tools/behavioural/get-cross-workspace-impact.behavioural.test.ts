/**
 * Behavioural coverage for the `get_cross_workspace_impact` MCP tool. The
 * tool body is inline in `registerAdvancedTools()` and aggregates three
 * store primitives:
 *   - store.getWorkspaceExports(workspace) → public_api consumed by other workspaces
 *   - store.getCrossWorkspaceEdges() → filtered by source/target workspace
 *
 * Covers:
 *   - workspace exposes its public API (symbols targeted by cross-ws edges)
 *   - consumed_by lists downstream workspaces with their imported symbol set
 *   - depends_on lists upstream workspaces with their imported symbol set
 *   - a workspace with no consumers AND no providers returns empty maps
 *   - asking for an unknown workspace name returns empty arrays — never throws
 *   - cross_workspace_edges count is the total of edges touching the workspace
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

/**
 * 3-workspace fixture:
 *
 *   packages/api  (provider)
 *     api.ts ── apiFn  ← imported by packages/web (cross-ws)
 *
 *   packages/web  (consumer-only)
 *     web.ts ── webFn  → packages/api::apiFn (cross-ws)
 *                       → packages/shared::sharedFn (cross-ws)
 *
 *   packages/shared (provider-only)
 *     shared.ts ── sharedFn  ← imported by packages/web (cross-ws)
 *
 *   packages/isolated (no edges)
 *     iso.ts ── isoFn
 */
function seed(): Fixture {
  const store = createTestStore();

  const apiFid = store.insertFile('packages/api/api.ts', 'typescript', 'h-api', 80, 'packages/api');
  const apiSym = store.insertSymbol(apiFid, {
    symbolId: 'packages/api/api.ts::apiFn#function',
    name: 'apiFn',
    kind: 'function',
    fqn: 'apiFn',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 4,
  });
  const apiNid = store.getNodeId('symbol', apiSym)!;

  const webFid = store.insertFile('packages/web/web.ts', 'typescript', 'h-web', 90, 'packages/web');
  const webSym = store.insertSymbol(webFid, {
    symbolId: 'packages/web/web.ts::webFn#function',
    name: 'webFn',
    kind: 'function',
    fqn: 'webFn',
    byteStart: 0,
    byteEnd: 40,
    lineStart: 1,
    lineEnd: 5,
  });
  const webNid = store.getNodeId('symbol', webSym)!;

  const sharedFid = store.insertFile(
    'packages/shared/shared.ts',
    'typescript',
    'h-shared',
    70,
    'packages/shared',
  );
  const sharedSym = store.insertSymbol(sharedFid, {
    symbolId: 'packages/shared/shared.ts::sharedFn#function',
    name: 'sharedFn',
    kind: 'function',
    fqn: 'sharedFn',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 4,
  });
  const sharedNid = store.getNodeId('symbol', sharedSym)!;

  const isoFid = store.insertFile(
    'packages/isolated/iso.ts',
    'typescript',
    'h-iso',
    40,
    'packages/isolated',
  );
  store.insertSymbol(isoFid, {
    symbolId: 'packages/isolated/iso.ts::isoFn#function',
    name: 'isoFn',
    kind: 'function',
    fqn: 'isoFn',
    byteStart: 0,
    byteEnd: 15,
    lineStart: 1,
    lineEnd: 2,
  });

  // web -> api (cross-ws)
  store.insertEdge(webNid, apiNid, 'esm_imports', true, undefined, true, 'ast_resolved');
  // web -> shared (cross-ws)
  store.insertEdge(webNid, sharedNid, 'esm_imports', true, undefined, true, 'ast_resolved');

  return { store };
}

/**
 * Reproduce the tool's aggregation logic verbatim (the tool body is inline in
 * register/advanced.ts, so we can't import it directly). If the inline logic
 * drifts, these tests still pin the store-level contract.
 */
function computeImpact(store: Store, workspace: string) {
  const exports = store.getWorkspaceExports(workspace);
  const crossEdges = store
    .getCrossWorkspaceEdges()
    .filter((e) => e.source_workspace === workspace || e.target_workspace === workspace);

  // `consumed_by` = workspaces that import OUR exports (we are the target).
  // Key by the importer (source_workspace); record which of OUR exports
  // (target_symbol) they pulled.
  const consumers = new Map<string, Set<string>>();
  for (const edge of crossEdges) {
    if (edge.target_workspace === workspace && edge.source_workspace) {
      const key = edge.source_workspace;
      if (!consumers.has(key)) consumers.set(key, new Set());
      if (edge.target_symbol) consumers.get(key)!.add(edge.target_symbol);
    }
  }

  // `depends_on` = workspaces WE import from (we are the source). Key by
  // the workspace we depend on (target_workspace); record which of their
  // exports (target_symbol) we reference.
  const providers = new Map<string, Set<string>>();
  for (const edge of crossEdges) {
    if (edge.source_workspace === workspace && edge.target_workspace) {
      const key = edge.target_workspace;
      if (!providers.has(key)) providers.set(key, new Set());
      if (edge.target_symbol) providers.get(key)!.add(edge.target_symbol);
    }
  }

  return {
    workspace,
    public_api: exports.map((s) => ({
      name: s.name,
      kind: s.kind,
      fqn: s.fqn,
      file: s.file_path,
    })),
    consumed_by: Object.fromEntries(
      [...consumers.entries()].map(([ws, symbols]) => [
        ws,
        { symbols: [...symbols], count: symbols.size },
      ]),
    ),
    depends_on: Object.fromEntries(
      [...providers.entries()].map(([ws, symbols]) => [
        ws,
        { symbols: [...symbols], count: symbols.size },
      ]),
    ),
    cross_workspace_edges: crossEdges.length,
  };
}

describe('get_cross_workspace_impact — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('provider workspace exposes its public_api and lists consumers in consumed_by', () => {
    const impact = computeImpact(ctx.store, 'packages/api');
    expect(impact.workspace).toBe('packages/api');

    // api exports apiFn — it is the target of a cross-ws edge from web.
    expect(impact.public_api.length).toBe(1);
    expect(impact.public_api[0].name).toBe('apiFn');
    expect(impact.public_api[0].file).toBe('packages/api/api.ts');

    // api is a target of a cross-ws edge from web → web consumes api.
    // consumed_by is keyed by the importer (packages/web) and lists the
    // exports of THIS workspace that get pulled (apiFn).
    expect(Object.keys(impact.consumed_by)).toEqual(['packages/web']);
    expect(impact.consumed_by['packages/web'].symbols).toContain('apiFn');

    // api never imports another workspace → depends_on is empty.
    expect(impact.depends_on).toEqual({});
  });

  it('consumer workspace lists its providers in depends_on; consumed_by stays empty when it is purely a consumer', () => {
    const impact = computeImpact(ctx.store, 'packages/web');
    expect(impact.workspace).toBe('packages/web');

    // web exports nothing cross-ws (it is never a target).
    expect(impact.public_api).toEqual([]);

    // web is purely a consumer (never a target) → consumed_by is empty.
    expect(impact.consumed_by).toEqual({});

    // web is the SOURCE of two cross-ws edges → depends_on enumerates the
    // providers (packages/api, packages/shared) keyed by the workspace we
    // pull from, with the imported symbols recorded.
    expect(new Set(Object.keys(impact.depends_on))).toEqual(
      new Set(['packages/api', 'packages/shared']),
    );
    expect(impact.depends_on['packages/api'].symbols).toContain('apiFn');
    expect(impact.depends_on['packages/shared'].symbols).toContain('sharedFn');
  });

  it('cross_workspace_edges counts every edge touching the workspace', () => {
    const web = computeImpact(ctx.store, 'packages/web');
    // web is the source of 2 cross-ws edges.
    expect(web.cross_workspace_edges).toBe(2);

    const api = computeImpact(ctx.store, 'packages/api');
    // api is the target of 1 cross-ws edge.
    expect(api.cross_workspace_edges).toBe(1);
  });

  it('workspace with no edges returns empty arrays for every field — no throw', () => {
    const impact = computeImpact(ctx.store, 'packages/isolated');
    expect(impact.public_api).toEqual([]);
    expect(impact.consumed_by).toEqual({});
    expect(impact.depends_on).toEqual({});
    expect(impact.cross_workspace_edges).toBe(0);
  });

  it('unknown workspace name returns empty envelope — never throws', () => {
    const impact = computeImpact(ctx.store, 'packages/does-not-exist');
    expect(impact.workspace).toBe('packages/does-not-exist');
    expect(impact.public_api).toEqual([]);
    expect(impact.consumed_by).toEqual({});
    expect(impact.depends_on).toEqual({});
    expect(impact.cross_workspace_edges).toBe(0);
  });
});
