import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { getCallGraph } from '../../src/tools/framework/call-graph.js';
import { createTestStore } from '../test-utils.js';

describe('TypeScript constructor parameter property calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ts-param-prop-'));
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const config: TraceMcpConfig = {
    root,
    include: ['src/**/*.ts'],
    exclude: [],
    plugins: [],
  };
  const pipeline = new IndexingPipeline(store, registry, config, root);

  afterEach(async () => {
    await pipeline.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves calls through promoted fields across files and excludes ordinary constructor parameters', async () => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src', 'store.ts'),
      'export class TopologyStore { upsertSubproject() {} getSubprojectsByProject() {} }',
    );
    fs.writeFileSync(
      path.join(root, 'src', 'manager.ts'),
      `import { TopologyStore } from './store.js';
       export class Manager {
         constructor(private readonly topoStore: TopologyStore, public otherStore: TopologyStore,
                     readonly thirdStore: TopologyStore, ordinary: TopologyStore) {}
         add() { this.topoStore.upsertSubproject(); }
         discover() { this.topoStore.getSubprojectsByProject(); this.ordinary.upsertSubproject(); }
         fromPublic() { this.otherStore.getSubprojectsByProject(); }
         fromReadonly() { this.thirdStore.upsertSubproject(); }
       }`,
    );

    await pipeline.indexAll();
    for (const [method, caller] of [
      ['upsertSubproject', ['add', 'fromReadonly']],
      ['getSubprojectsByProject', ['discover', 'fromPublic']],
    ]) {
      const result = getCallGraph(store, {
        symbolId: `src/store.ts::TopologyStore::${method}#method`,
      });
      expect(result.isOk()).toBe(true);
      expect(
        result
          ._unsafeUnwrap()
          .root.called_by?.map((s) => s.name)
          .sort(),
      ).toEqual(caller.sort());
    }
  });
});
