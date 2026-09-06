/**
 * C# cross-file import resolution E2E (TRA-1027).
 *
 * Same gap TRA-483 closed for Java: the C# plugin extracts `using` directives
 * into `metadata.from` (`extractImportEdges`), but no pipeline pass consumed
 * them, so a C# repo indexed with zero import edges even though the matrix
 * claimed none. Unlike Java, C# namespaces don't have to mirror the directory
 * layout, so resolution matches against declared `namespace` symbols instead
 * of path suffixes — these tests put `Store.cs` at a path that would break
 * suffix matching to prove that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { CSharpLanguagePlugin } from '../../src/indexer/plugins/language/csharp/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const FILES: Record<string, string> = {
  'src/App.cs': `using System;
using Acme.Store;
using static Acme.Util.Ids;
using Db = Acme.Store.Db;

namespace Acme.App
{
    public class Program
    {
        static void Main()
        {
            var repo = new Repo();
            Console.WriteLine(Next());
        }
    }
}
`,
  // Deliberately not under a store/ directory — proves resolution follows the
  // declared namespace, not the file path, unlike the Java suffix approach.
  'src/nested/deep/Store.cs': `namespace Acme.Store
{
    public class Repo {}
    public class Db {}
}
`,
  'src/util/Ids.cs': `namespace Acme.Util
{
    public static class Ids
    {
        public static int Next() => 0;
    }
}
`,
};

function importTargets(store: Store, sourcePath: string): Set<string> {
  const file = store.getFile(sourcePath);
  if (!file) return new Set();
  const nodeId = store.getNodeId('file', file.id);
  if (nodeId == null) return new Set();
  const targets = new Set<string>();
  for (const edge of store.getOutgoingEdges(nodeId)) {
    if (edge.edge_type_name !== 'imports') continue;
    const ref = store.getNodeRef(edge.target_node_id);
    if (ref?.nodeType === 'file') targets.add(store.getFileById(ref.refId)?.path ?? '');
  }
  return targets;
}

describe('C# import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-csharp-imports-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new CSharpLanguagePlugin());

    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.cs'],
      exclude: ['node_modules/**'],
      plugins: [],
    } as TraceMcpConfig;

    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('resolves a plain namespace import to the file declaring it, regardless of its path', () => {
    expect(importTargets(store, 'src/App.cs')).toContain('src/nested/deep/Store.cs');
  });

  it('resolves a `using static` member import to the namespace holding the type', () => {
    expect(importTargets(store, 'src/App.cs')).toContain('src/util/Ids.cs');
  });

  it('resolves an aliased import to its target namespace', () => {
    // `using Db = Acme.Store.Db;` trims to `Acme.Store`, same target as the
    // plain import above — already covered by the first assertion.
    expect(importTargets(store, 'src/App.cs')).toEqual(
      new Set(['src/nested/deep/Store.cs', 'src/util/Ids.cs']),
    );
  });

  it('skips BCL imports rather than inventing targets', () => {
    // App.cs also imports `System`, which is not in the repo, so only the two
    // first-party targets may appear.
    expect(importTargets(store, 'src/App.cs').size).toBe(2);
  });
});
