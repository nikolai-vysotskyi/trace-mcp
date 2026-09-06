/**
 * C# cross-file import resolution E2E (TRA-1027).
 *
 * Same gap TRA-483 closed for Java: the C# plugin extracts `using` directives
 * into `metadata.from` (`extractImportEdges`), but no pipeline pass consumed
 * them, so a C# repo indexed with zero import edges even though the matrix
 * claimed none. Unlike Java, C# namespaces don't have to mirror the directory
 * layout, so resolution matches against declared `namespace`/type symbols
 * instead of path suffixes — these tests put `Store.cs` at a path that would
 * break suffix matching to prove that.
 *
 * Two shapes are here specifically because review caught the first version
 * getting them wrong: a namespace with more than one file in it (`Acme.Store`
 * spans `Store.cs` and `Db.cs`), so a type-level `using` can be checked to
 * resolve to only its declaring file rather than fanning out to every file in
 * the namespace; and an unindexed sub-namespace (`Acme.Store.Missing`), so
 * trimming a miss can be checked to never fall back onto the parent
 * namespace — `using Acme.Store.Missing` does not import `Acme.Store`.
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
using Acme.Store.Missing;
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
}
`,
  // A second file in the same namespace as Store.cs — proves a type-level
  // `using` (static or aliased) resolves to only the file declaring that
  // type, not every file in the namespace.
  'src/nested/deep/Db.cs': `namespace Acme.Store
{
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
  // Shares a namespace with Ids.cs but declares nothing App.cs imports —
  // proves `using static Acme.Util.Ids` doesn't leak an edge here.
  'src/util/Other.cs': `namespace Acme.Util
{
    public class Other {}
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

  it('resolves a plain namespace import to every file declaring it, regardless of path', () => {
    expect(importTargets(store, 'src/App.cs')).toContain('src/nested/deep/Store.cs');
    expect(importTargets(store, 'src/App.cs')).toContain('src/nested/deep/Db.cs');
  });

  it('resolves a `using static` member import to only the file declaring that type', () => {
    const targets = importTargets(store, 'src/App.cs');
    expect(targets).toContain('src/util/Ids.cs');
    expect(targets).not.toContain('src/util/Other.cs');
  });

  it('resolves an aliased type import to only the file declaring that type', () => {
    // `using Db = Acme.Store.Db;` must resolve to Db.cs specifically, not fan
    // out via the namespace to every file in Acme.Store.
    expect(importTargets(store, 'src/App.cs')).toContain('src/nested/deep/Db.cs');
  });

  it('does not fall back to the parent namespace for an unindexed sub-namespace', () => {
    // `using Acme.Store.Missing;` names a namespace that isn't declared
    // anywhere in the repo. It must not be treated as `Acme.Store`.
    expect(importTargets(store, 'src/App.cs')).toEqual(
      new Set(['src/nested/deep/Store.cs', 'src/nested/deep/Db.cs', 'src/util/Ids.cs']),
    );
  });

  it('skips BCL imports rather than inventing targets', () => {
    // App.cs also imports `System` (BCL) and `Acme.Store.Missing` (unindexed
    // sub-namespace) — neither may appear, so only the three first-party
    // targets above are here.
    expect(importTargets(store, 'src/App.cs').size).toBe(3);
  });
});
