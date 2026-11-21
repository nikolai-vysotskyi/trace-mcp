/**
 * TRA-3135: a framework plugin's resolveEdges() can time out or throw after
 * Pass 1 already deleted the file's previous outgoing edges. Before this
 * fix, a timeout returned ok([]) — indistinguishable from "this plugin
 * legitimately found zero edges" — so the deleted edge was never restored.
 *
 * This test proves the full repair loop on a real IndexingPipeline + real
 * SQLite store: a forced resolveEdges failure loses the edge immediately
 * (expected — Pass 1 already deleted it), but the TRA-1017
 * postprocess-incomplete mark stays set, and the very next pipeline run
 * (once the plugin works again) re-extracts and re-resolves the file,
 * restoring the edge and clearing the mark.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { ok } from '../../src/errors.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import type { FrameworkPlugin, ResolveContext } from '../../src/plugin-api/types.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

/** Minimal real plugin: links the symbol in a.ts to the symbol in b.ts. */
class FlakyPlugin implements FrameworkPlugin {
  manifest = { name: 'flaky', version: '1.0.0', priority: 10 };
  shouldFail = false;

  detect(): boolean {
    return true;
  }

  registerSchema() {
    return { edgeTypes: [{ name: 'flaky_edge', category: 'calls' }] };
  }

  resolveEdges(ctx: ResolveContext) {
    if (this.shouldFail) throw new Error('simulated resolver failure (TRA-3135)');

    const files = ctx.getAllFiles();
    const a = files.find((f) => f.path === 'src/a.ts');
    const b = files.find((f) => f.path === 'src/b.ts');
    if (!a || !b) return ok([]);

    const [symA] = ctx.getSymbolsByFile(a.id);
    const [symB] = ctx.getSymbolsByFile(b.id);
    if (!symA || !symB) return ok([]);

    return ok([
      {
        sourceNodeType: 'symbol',
        sourceRefId: symA.id,
        targetNodeType: 'symbol',
        targetRefId: symB.id,
        edgeType: 'flaky_edge',
      },
    ]);
  }
}

function makeSetup(rootDir: string, plugin: FlakyPlugin) {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  registry.registerFrameworkPlugin(plugin);

  const config: TraceMcpConfig = {
    root: rootDir,
    include: ['src/**/*.ts'],
    exclude: [],
    plugins: [],
  };

  const pipeline = new IndexingPipeline(store, registry, config, rootDir);
  return { store, pipeline };
}

describe('framework resolver failure does not permanently lose edges (TRA-3135)', () => {
  let rootDir: string;
  let store: ReturnType<typeof createTestStore>;
  let pipeline: IndexingPipeline;
  let plugin: FlakyPlugin;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra3135-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    fs.writeFileSync(path.join(rootDir, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
    fs.writeFileSync(path.join(rootDir, 'src', 'b.ts'), 'export function beta() { return 2; }\n');
    plugin = new FlakyPlugin();
    ({ store, pipeline } = makeSetup(rootDir, plugin));
  });

  afterEach(async () => {
    await pipeline.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('restores an edge lost to a resolver failure on the next successful run', async () => {
    await pipeline.indexAll();
    expect(store.getEdgesByType('flaky_edge')).toHaveLength(1);

    const internals = pipeline as unknown as { isPostprocessIncomplete(): boolean };

    // Content-only edit (same symbol names) — Pass 1 deletes a.ts's outgoing
    // edges before Pass 2 runs; this forced failure stops Pass 2 from
    // replacing them.
    plugin.shouldFail = true;
    fs.writeFileSync(
      path.join(rootDir, 'src', 'a.ts'),
      'export function alpha() { return 999; }\n',
    );
    await pipeline.indexFiles(['src/a.ts']);

    // The edge is gone right after the failed run (Pass 1 already deleted
    // it) — but the index must know it owes a repair, not call this "done".
    expect(store.getEdgesByType('flaky_edge')).toHaveLength(0);
    expect(internals.isPostprocessIncomplete()).toBe(true);

    // Plugin recovers. A scoped run can repair its own files but — by
    // design (TRA-1017) — never clears the incomplete mark on its own,
    // since it never re-verifies the whole graph; only the next full pass
    // does. It sees `wasIncomplete`, force-re-extracts a.ts via the durable
    // repair scope even though its hash is unchanged since the failed run,
    // re-resolves everything, and — now that the resolver succeeds — clears
    // the mark.
    plugin.shouldFail = false;
    await pipeline.indexAll();

    expect(store.getEdgesByType('flaky_edge')).toHaveLength(1);
    expect(internals.isPostprocessIncomplete()).toBe(false);
  });
});
