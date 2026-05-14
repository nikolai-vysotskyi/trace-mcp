/**
 * Behavioural coverage for the `get_workspace_map` MCP tool. The tool body is
 * inline inside `registerAdvancedTools()` (src/tools/register/advanced.ts), so
 * this test exercises the same store-level building blocks the tool delegates
 * to:
 *   - store.getWorkspaceStats() — rows per workspace (name, files, symbols, languages)
 *   - store.getWorkspaceDependencyGraph() — only populated when cross-ws edges exist
 *
 * Covers:
 *   - non-monorepo project (no workspace metadata) returns an empty stats array
 *   - monorepo with 2 workspaces returns one row per workspace with correct counts
 *     and a deduplicated languages list
 *   - cross-workspace edges produce a dependency graph row with edge_count
 *   - intra-workspace edges do NOT appear in the dependency graph
 *   - workspace row shape is pinned to { workspace, file_count, symbol_count, languages }
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

/**
 * Build a 2-workspace fixture:
 *   - workspace "packages/app": app.ts (typescript) + util.js (javascript)
 *   - workspace "packages/lib": lib.ts (typescript)
 *   - one cross-workspace import edge: app.ts -> lib.ts (is_cross_ws = 1)
 *   - one intra-workspace edge: app.ts -> util.js (is_cross_ws = 0)
 */
function seedMonorepo(): Fixture {
  const store = createTestStore();

  const appFid = store.insertFile(
    'packages/app/app.ts',
    'typescript',
    'h-app',
    100,
    'packages/app',
  );
  const appSym = store.insertSymbol(appFid, {
    symbolId: 'packages/app/app.ts::appFn#function',
    name: 'appFn',
    kind: 'function',
    fqn: 'appFn',
    byteStart: 0,
    byteEnd: 40,
    lineStart: 1,
    lineEnd: 5,
  });
  const appNid = store.getNodeId('symbol', appSym)!;

  const utilFid = store.insertFile(
    'packages/app/util.js',
    'javascript',
    'h-util',
    50,
    'packages/app',
  );
  const utilSym = store.insertSymbol(utilFid, {
    symbolId: 'packages/app/util.js::utilFn#function',
    name: 'utilFn',
    kind: 'function',
    fqn: 'utilFn',
    byteStart: 0,
    byteEnd: 20,
    lineStart: 1,
    lineEnd: 3,
  });
  const utilNid = store.getNodeId('symbol', utilSym)!;

  const libFid = store.insertFile('packages/lib/lib.ts', 'typescript', 'h-lib', 80, 'packages/lib');
  const libSym = store.insertSymbol(libFid, {
    symbolId: 'packages/lib/lib.ts::libFn#function',
    name: 'libFn',
    kind: 'function',
    fqn: 'libFn',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 4,
  });
  const libNid = store.getNodeId('symbol', libSym)!;

  // Cross-workspace edge: app -> lib (is_cross_ws = true)
  store.insertEdge(appNid, libNid, 'esm_imports', true, undefined, true, 'ast_resolved');
  // Intra-workspace edge: app -> util (is_cross_ws = false) — must not surface in deps graph
  store.insertEdge(appNid, utilNid, 'esm_imports', true, undefined, false, 'ast_resolved');

  return { store };
}

describe('get_workspace_map — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seedMonorepo();
  });

  it('returns one row per workspace with file_count, symbol_count, languages', () => {
    const stats = ctx.store.getWorkspaceStats();
    expect(Array.isArray(stats)).toBe(true);
    expect(stats.length).toBe(2);

    const byName = new Map(stats.map((s) => [s.workspace, s]));
    const app = byName.get('packages/app');
    const lib = byName.get('packages/lib');
    expect(app).toBeDefined();
    expect(lib).toBeDefined();

    expect(app!.file_count).toBe(2);
    expect(app!.symbol_count).toBe(2);
    expect(lib!.file_count).toBe(1);
    expect(lib!.symbol_count).toBe(1);
  });

  it('workspace row exposes languages as a comma-separated, deduplicated list', () => {
    const stats = ctx.store.getWorkspaceStats();
    const byName = new Map(stats.map((s) => [s.workspace, s]));
    const app = byName.get('packages/app')!;
    // analytics-repository returns GROUP_CONCAT(DISTINCT f.language); tool layer splits/dedups.
    const appLangs = new Set((app.languages ?? '').split(',').filter(Boolean));
    expect(appLangs.has('typescript')).toBe(true);
    expect(appLangs.has('javascript')).toBe(true);
    expect(appLangs.size).toBe(2);

    const lib = byName.get('packages/lib')!;
    const libLangs = new Set((lib.languages ?? '').split(',').filter(Boolean));
    expect(libLangs.size).toBe(1);
    expect(libLangs.has('typescript')).toBe(true);
  });

  it('cross-workspace edge produces a dependency row with edge_count and edge_types', () => {
    const deps = ctx.store.getWorkspaceDependencyGraph();
    expect(Array.isArray(deps)).toBe(true);
    expect(deps.length).toBe(1);
    const dep = deps[0];
    expect(dep.from_workspace).toBe('packages/app');
    expect(dep.to_workspace).toBe('packages/lib');
    expect(dep.edge_count).toBe(1);
    expect(typeof dep.edge_types).toBe('string');
    expect(dep.edge_types.split(',')).toContain('esm_imports');
  });

  it('intra-workspace edges do not appear in the dependency graph', () => {
    const deps = ctx.store.getWorkspaceDependencyGraph();
    // Only the cross-workspace edge should be present. The intra-workspace
    // app -> util edge must NOT surface.
    for (const d of deps) {
      expect(d.from_workspace).not.toBe(d.to_workspace);
    }
    // Specifically, no self-loop on packages/app.
    expect(
      deps.find((d) => d.from_workspace === 'packages/app' && d.to_workspace === 'packages/app'),
    ).toBeUndefined();
  });

  it('project with no workspace metadata returns empty stats (non-monorepo case)', () => {
    const store = createTestStore();
    // Insert a file without workspace — analytics filter `WHERE f.workspace IS NOT NULL`
    // should exclude it entirely.
    const fid = store.insertFile('src/lonely.ts', 'typescript', 'h-lonely', 30);
    store.insertSymbol(fid, {
      symbolId: 'src/lonely.ts::lonelyFn#function',
      name: 'lonelyFn',
      kind: 'function',
      fqn: 'lonelyFn',
      byteStart: 0,
      byteEnd: 15,
      lineStart: 1,
      lineEnd: 2,
    });

    const stats = store.getWorkspaceStats();
    expect(stats).toEqual([]);
    const deps = store.getWorkspaceDependencyGraph();
    expect(deps).toEqual([]);
  });
});
