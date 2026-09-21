import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { EdgeResolver } from '../../src/indexer/edge-resolver.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { ok } from '../../src/errors.js';
import type {
  FrameworkPlugin,
  ProjectContext,
  ResolveContext,
} from '../../src/plugin-api/types.js';
import { _resetYieldCountForTests, getYieldCount } from '../../src/utils/event-loop.js';

/**
 * TRA-922: the framework edge pass must breathe between projects.
 *
 * The field report: the daemon's main thread sat inside synchronous
 * better-sqlite3 long enough that the TCP accept queue on :3741 never
 * drained — sessions hung in SYN_SENT and each fell back to full local
 * indexing. The framework pass (`EdgeResolver.resolveEdges`: root plugins
 * + one plugin loop per workspace) ran as a single uninterrupted
 * synchronous span: `executeFrameworkResolveEdges` awaits nothing but
 * microtasks for sync plugins, so no pending I/O (/health, MCP requests)
 * was serviced until every project's plugins had resolved AND stored.
 *
 * The guard below is deterministic, not timing-based. A `setImmediate`
 * queued before the pass can only fire mid-pass if the pass yields to the
 * event loop between plugin executions. Pre-fix the whole pass completes
 * on microtasks alone and the flag is still false when the later plugins
 * run; post-fix it is true. Deleting the yields fails this test.
 */
describe('EdgeResolver.resolveEdges yields between passes (TRA-922)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tra922-resolver-'));
  for (const ws of ['ws1', 'ws2']) {
    fs.mkdirSync(path.join(tmpRoot, ws), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, ws, 'package.json'),
      JSON.stringify({ name: ws, dependencies: { express: '^4.0.0' } }),
    );
  }
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  function fakePlugin(
    name: string,
    calls: string[],
    detect: (ctx: ProjectContext) => boolean,
    onResolve?: () => void,
  ): FrameworkPlugin {
    return {
      manifest: { name, version: '0.0.0-test', priority: 100 },
      detect,
      registerSchema: () => ({}),
      resolveEdges: () => {
        calls.push(name);
        onResolve?.();
        return ok([]);
      },
    };
  }

  const emptyCtx: ResolveContext = {
    rootPath: tmpRoot,
    getAllFiles: () => [],
    getSymbolsByFile: () => [],
    getSymbolByFqn: () => undefined,
    getNodeId: () => undefined,
    createNodeIfNeeded: () => 0,
    readFile: () => undefined,
  };

  function makeState(registry: PluginRegistry): PipelineState {
    const db = initializeDatabase(':memory:');
    return {
      store: new Store(db),
      registry,
      config: TraceMcpConfigSchema.parse({ root: tmpRoot }),
      rootPath: tmpRoot,
      workspaces: [
        { name: 'ws1', path: 'ws1' },
        { name: 'ws2', path: 'ws2' },
      ],
      isIncremental: false,
      changedFileIds: new Set(),
      pendingImports: new Map(),
      fileContentCache: new Map(),
      gitignore: undefined,
    };
  }

  it('a queued macrotask runs mid-pass, and plugin order is preserved', async () => {
    const calls: string[] = [];
    let breathedBeforeSecondWorkspace = false;
    let wsRuns = 0;
    const registry = new PluginRegistry();
    registry.registerFrameworkPlugin(fakePlugin('root-a', calls, () => true));
    registry.registerFrameworkPlugin(fakePlugin('root-b', calls, () => true));
    // Workspace-only: invisible at root, active in every workspace.
    registry.registerFrameworkPlugin(
      fakePlugin(
        'ws-only',
        calls,
        (ctx) => ctx.rootPath !== tmpRoot,
        () => {
          wsRuns++;
          if (wsRuns === 1) breathedBeforeSecondWorkspace = breathed;
        },
      ),
    );

    const resolver = new EdgeResolver(makeState(registry));
    const rootCtx: ProjectContext = {
      rootPath: tmpRoot,
      detectedVersions: [],
      allDependencies: [],
      configFiles: [],
    };

    let breathed = false;
    setImmediate(() => {
      breathed = true;
    });
    _resetYieldCountForTests();
    await resolver.resolveEdges(rootCtx, emptyCtx);

    // Order is unchanged by the yields: roots first, then one pass per
    // workspace, sequentially.
    expect(calls).toEqual(['root-a', 'root-b', 'ws-only', 'ws-only']);
    // The setImmediate queued before the pass fired before the first
    // workspace pass ran — the loop breathed between root and workspace
    // passes. Without the TRA-922 yields this is false.
    expect(breathedBeforeSecondWorkspace).toBe(true);
    // One fair turn per plugin pass (4) plus one per workspace boundary (2).
    expect(getYieldCount()).toBeGreaterThanOrEqual(4);
  });
});
