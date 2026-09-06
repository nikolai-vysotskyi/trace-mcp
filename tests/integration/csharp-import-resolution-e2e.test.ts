/**
 * C# cross-file import resolution E2E (TRA-1027).
 *
 * Same gap TRA-483 closed for Java: the C# plugin extracts `using` directives
 * into `metadata.from` (`extractImportEdges`), but no pipeline pass consumed
 * them, so a C# repo indexed with zero import edges even though the matrix
 * claimed none. Unlike Java, resolution only trusts forms that name a
 * specific type — a plain `using Namespace;` is deliberately never resolved
 * to a file edge, regardless of how many (or how few) files declare that
 * namespace. See the resolver's file header for why: two rounds of review
 * rejected namespace-level file edges, first for volume (a real repo averaged
 * 86 resolved edges per importing file) and then because even the
 * single-declarer case depends on unrelated files elsewhere in the repo in a
 * way the incremental resolver can't track soundly.
 *
 * Several shapes below exist specifically because review caught earlier
 * versions getting them wrong:
 * - a plain namespace import with only one declaring file (`Acme.Config`)
 *   must still stay unresolved — the earlier version treated this as
 *   precise, which review found unsound;
 * - an unindexed sub-namespace (`Acme.Store.Missing`), so trimming a miss
 *   can be checked to never fall back onto a namespace;
 * - a `using` inside a namespace block (not just at the top of the file);
 * - an incremental reindex that renames a type without touching the
 *   importing file, so a stale edge can be checked to get pruned rather than
 *   surviving forever.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { CSharpLanguagePlugin } from '../../src/indexer/plugins/language/csharp/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

function makeConfig(root: string): TraceMcpConfig {
  return {
    root,
    include: ['**/*.cs'],
    exclude: ['node_modules/**'],
    plugins: [],
  } as TraceMcpConfig;
}

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

async function indexFixture(files: Record<string, string>, prefix: string) {
  const fixtureDir = createTmpFixture(files, prefix);
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new CSharpLanguagePlugin());
  await new IndexingPipeline(store, registry, makeConfig(fixtureDir), fixtureDir).indexAll();
  return { store, fixtureDir };
}

describe('C# import resolution E2E', () => {
  const FILES: Record<string, string> = {
    'src/App.cs': `using System;
using Acme.Store;
using Acme.Store.Missing;
using Acme.Config;
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
    // Deliberately not under a store/ directory — proves resolution follows
    // the declared type, not the file path, unlike the Java suffix approach.
    'src/nested/deep/Store.cs': `namespace Acme.Store
{
    public class Repo {}
}
`,
    'src/nested/deep/Db.cs': `namespace Acme.Store
{
    public class Db {}
}
`,
    // The sole file declaring Acme.Config — still must NOT resolve, since a
    // plain namespace import never names a specific type.
    'src/config/Settings.cs': `namespace Acme.Config
{
    public class Settings {}
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

  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    ({ store, fixtureDir } = await indexFixture(FILES, 'trace-mcp-csharp-imports-'));
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('never resolves a plain namespace import to a file edge, even with a single declaring file', () => {
    const targets = importTargets(store, 'src/App.cs');
    expect(targets).not.toContain('src/nested/deep/Store.cs');
    expect(targets).not.toContain('src/config/Settings.cs');
  });

  it('resolves a `using static` member import to only the file declaring that type', () => {
    const targets = importTargets(store, 'src/App.cs');
    expect(targets).toContain('src/util/Ids.cs');
    expect(targets).not.toContain('src/util/Other.cs');
  });

  it('resolves an aliased type import to only the file declaring that type', () => {
    // `using Db = Acme.Store.Db;` must resolve to Db.cs specifically, even
    // though the plain `using Acme.Store;` above stays unresolved.
    expect(importTargets(store, 'src/App.cs')).toContain('src/nested/deep/Db.cs');
  });

  it('does not fall back to a namespace for an unindexed sub-namespace', () => {
    // `using Acme.Store.Missing;` names a namespace that isn't declared
    // anywhere in the repo. It must not be treated as `Acme.Store`.
    expect(importTargets(store, 'src/App.cs')).toEqual(
      new Set(['src/util/Ids.cs', 'src/nested/deep/Db.cs']),
    );
  });

  it('skips BCL and plain-namespace imports rather than inventing targets', () => {
    // App.cs also imports `System` (BCL), `Acme.Store` and `Acme.Config`
    // (plain namespace — never resolved), and `Acme.Store.Missing`
    // (unindexed sub-namespace) — none may appear, so only the two
    // type-precise targets above are here.
    expect(importTargets(store, 'src/App.cs').size).toBe(2);
  });
});

describe('C# import resolution: namespace-scoped using directives', () => {
  it('extracts a `using` declared inside a namespace block, not just at file scope', async () => {
    const { store, fixtureDir } = await indexFixture(
      {
        'src/App.cs': `namespace Acme.App
{
    using static Acme.Store.Repo;

    public class Program
    {
        Repo repo;
    }
}
`,
        'src/Store.cs': `namespace Acme.Store
{
    public class Repo {}
}
`,
      },
      'trace-mcp-csharp-ns-scoped-using-',
    );
    try {
      expect(importTargets(store, 'src/App.cs')).toContain('src/Store.cs');
    } finally {
      removeTmpDir(fixtureDir);
    }
  });
});

describe('C# import resolution: incremental reindex', () => {
  it('prunes a stale edge after the target file renames its type, without reindexing the importer', async () => {
    const fixtureDir = createTmpFixture(
      {
        'src/App.cs': `using static Acme.Store.Repo;

namespace Acme.App
{
    public class Program
    {
        Repo repo;
    }
}
`,
        'src/Store.cs': `namespace Acme.Store
{
    public class Repo {}
}
`,
      },
      'trace-mcp-csharp-rename-',
    );
    try {
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new CSharpLanguagePlugin());
      const pipeline = new IndexingPipeline(store, registry, makeConfig(fixtureDir), fixtureDir);
      await pipeline.indexAll();
      expect(importTargets(store, 'src/App.cs')).toContain('src/Store.cs');

      // Rename the type — App.cs, the importer, is untouched.
      const storePath = path.join(fixtureDir, 'src/Store.cs');
      fs.writeFileSync(
        storePath,
        `namespace Acme.Store
{
    public class Other {}
}
`,
      );
      await pipeline.indexFiles([storePath]);

      // Acme.Store.Repo no longer has a declaring file — the edge must be
      // gone, not left pointing at a file that no longer means what it did.
      expect(importTargets(store, 'src/App.cs')).not.toContain('src/Store.cs');
    } finally {
      removeTmpDir(fixtureDir);
    }
  });
});
