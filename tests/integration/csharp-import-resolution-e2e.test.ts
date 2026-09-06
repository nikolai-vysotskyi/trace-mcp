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
 * Several shapes below exist specifically because two rounds of review caught
 * the earlier versions getting them wrong:
 * - a namespace with more than one file in it (`Acme.Store` spans `Store.cs`
 *   and `Db.cs`), so a plain `using` of it can be checked to resolve to
 *   NEITHER file (ambiguous — see the resolver's file header) while a
 *   type-level `using` of a specific type in that same namespace still
 *   resolves precisely;
 * - a namespace with exactly one file (`Acme.Config`), so a plain `using` of
 *   an unambiguous namespace can be checked to still resolve;
 * - an unindexed sub-namespace (`Acme.Store.Missing`), so trimming a miss can
 *   be checked to never fall back onto the parent namespace;
 * - a `using` inside a namespace block (not just at the top of the file);
 * - an incremental reindex that renames a namespace without touching the
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
  // Deliberately not under a store/ directory — proves resolution follows the
  // declared namespace, not the file path, unlike the Java suffix approach.
  // Acme.Store spans two files, so a plain `using Acme.Store;` is ambiguous.
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
  // The sole file declaring Acme.Config — a plain `using` of it is precise.
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

describe('C# import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-csharp-imports-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new CSharpLanguagePlugin());
    await new IndexingPipeline(store, registry, makeConfig(fixtureDir), fixtureDir).indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('does not resolve a plain namespace import when more than one file declares it', () => {
    // `using Acme.Store;` — Acme.Store spans Store.cs and Db.cs, so neither
    // is a precise target; the resolver must not guess which one was meant.
    const targets = importTargets(store, 'src/App.cs');
    expect(targets).not.toContain('src/nested/deep/Store.cs');
  });

  it('resolves a plain namespace import to its sole declaring file', () => {
    expect(importTargets(store, 'src/App.cs')).toContain('src/config/Settings.cs');
  });

  it('resolves a `using static` member import to only the file declaring that type', () => {
    const targets = importTargets(store, 'src/App.cs');
    expect(targets).toContain('src/util/Ids.cs');
    expect(targets).not.toContain('src/util/Other.cs');
  });

  it('resolves an aliased type import to only the file declaring that type, even in an ambiguous namespace', () => {
    // `using Db = Acme.Store.Db;` must resolve to Db.cs specifically — the
    // type-level match is precise regardless of Acme.Store being ambiguous
    // for the plain-namespace case above.
    expect(importTargets(store, 'src/App.cs')).toContain('src/nested/deep/Db.cs');
  });

  it('does not fall back to the parent namespace for an unindexed sub-namespace', () => {
    // `using Acme.Store.Missing;` names a namespace that isn't declared
    // anywhere in the repo. It must not be treated as `Acme.Store`.
    expect(importTargets(store, 'src/App.cs')).toEqual(
      new Set(['src/config/Settings.cs', 'src/util/Ids.cs', 'src/nested/deep/Db.cs']),
    );
  });

  it('skips BCL imports rather than inventing targets', () => {
    // App.cs also imports `System` (BCL), the ambiguous `Acme.Store`, and the
    // unindexed `Acme.Store.Missing` — none may appear, so only the three
    // precise targets above are here.
    expect(importTargets(store, 'src/App.cs').size).toBe(3);
  });
});

describe('C# import resolution: namespace-scoped using directives', () => {
  it('extracts a `using` declared inside a namespace block, not just at file scope', async () => {
    const fixtureDir = createTmpFixture(
      {
        'src/App.cs': `namespace Acme.App
{
    using Acme.Store;

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
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new CSharpLanguagePlugin());
      await new IndexingPipeline(store, registry, makeConfig(fixtureDir), fixtureDir).indexAll();

      expect(importTargets(store, 'src/App.cs')).toContain('src/Store.cs');
    } finally {
      removeTmpDir(fixtureDir);
    }
  });
});

describe('C# import resolution: incremental reindex', () => {
  it('prunes a stale edge after the target file renames its namespace, without reindexing the importer', async () => {
    const fixtureDir = createTmpFixture(
      {
        'src/App.cs': `using Acme.Store;

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

      // Rename the namespace — App.cs, the importer, is untouched.
      const storePath = path.join(fixtureDir, 'src/Store.cs');
      fs.writeFileSync(
        storePath,
        `namespace Acme.Other
{
    public class Repo {}
}
`,
      );
      await pipeline.indexFiles([storePath]);

      // Acme.Store no longer has a declaring file — the edge must be gone,
      // not left pointing at a file that no longer means what it did.
      expect(importTargets(store, 'src/App.cs')).not.toContain('src/Store.cs');
    } finally {
      removeTmpDir(fixtureDir);
    }
  });
});
