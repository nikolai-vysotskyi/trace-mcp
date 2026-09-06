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

  it('relinks to the new declaring file when a type moves, without reindexing the importer', async () => {
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
        'src/One.cs': `namespace Acme.Store
{
    public class Repo {}
}
`,
      },
      'trace-mcp-csharp-move-',
    );
    try {
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new CSharpLanguagePlugin());
      const pipeline = new IndexingPipeline(store, registry, makeConfig(fixtureDir), fixtureDir);
      await pipeline.indexAll();
      expect(importTargets(store, 'src/App.cs')).toEqual(new Set(['src/One.cs']));

      // Move Repo out of One.cs and into a new Two.cs — App.cs, the
      // importer, is untouched; both target files are reindexed together,
      // as a file watcher would batch them.
      const onePath = path.join(fixtureDir, 'src/One.cs');
      const twoPath = path.join(fixtureDir, 'src/Two.cs');
      fs.writeFileSync(
        onePath,
        `namespace Acme.Store
{
}
`,
      );
      fs.writeFileSync(
        twoPath,
        `namespace Acme.Store
{
    public class Repo {}
}
`,
      );
      await pipeline.indexFiles([onePath, twoPath]);

      // The stale edge into One.cs is gone, and the resolver relinked to
      // Two.cs using the stale edge's own source + specifier — no reindex
      // of App.cs was needed for this to converge.
      expect(importTargets(store, 'src/App.cs')).toEqual(new Set(['src/Two.cs']));
    } finally {
      removeTmpDir(fixtureDir);
    }
  });

  it('keeps a still-valid specifier when another specifier collapsed onto the same edge moves', async () => {
    const fixtureDir = createTmpFixture(
      {
        'src/App.cs': `using static Acme.Store.A;
using static Acme.Store.B;

namespace Acme.App
{
    public class Program
    {
        A a;
        B b;
    }
}
`,
        'src/Types.cs': `namespace Acme.Store
{
    public class A {}
    public class B {}
}
`,
      },
      'trace-mcp-csharp-multi-specifier-',
    );
    try {
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new CSharpLanguagePlugin());
      const pipeline = new IndexingPipeline(store, registry, makeConfig(fixtureDir), fixtureDir);
      await pipeline.indexAll();
      // Both `using static` directives collapse onto the same file edge.
      expect(importTargets(store, 'src/App.cs')).toEqual(new Set(['src/Types.cs']));

      // Move only A out to its own file — B stays in Types.cs. App.cs, the
      // importer, is untouched.
      const typesPath = path.join(fixtureDir, 'src/Types.cs');
      const aPath = path.join(fixtureDir, 'src/A.cs');
      fs.writeFileSync(
        typesPath,
        `namespace Acme.Store
{
    public class B {}
}
`,
      );
      fs.writeFileSync(
        aPath,
        `namespace Acme.Store
{
    public class A {}
}
`,
      );
      await pipeline.indexFiles([typesPath, aPath]);

      // Types.cs must survive (B still resolves there) alongside the new
      // A.cs edge — an earlier version stored only the single latest
      // specifier per edge, so revalidating B against a metadata blob that
      // actually held "A" wiped the whole edge instead of keeping it.
      expect(importTargets(store, 'src/App.cs')).toEqual(new Set(['src/Types.cs', 'src/A.cs']));
    } finally {
      removeTmpDir(fixtureDir);
    }
  });

  it('does not invent a stale edge after a real delete-then-create rename, but does not self-heal without a full reindex either', async () => {
    // Documents a known, deliberate limitation (see the resolver's file
    // header): unlike the in-place edits above, a real file watcher renames
    // by calling `deleteFiles` and `indexFiles` as two separate calls, and
    // `deleteFiles` cascades away the old edge before the create is ever
    // seen — there is nothing left to relink from. The graph ends up
    // missing an edge, not lying with a wrong one, and a full reindex
    // recovers it.
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
        'src/One.cs': `namespace Acme.Store
{
    public class Repo {}
}
`,
      },
      'trace-mcp-csharp-delete-create-',
    );
    try {
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new CSharpLanguagePlugin());
      const pipeline = new IndexingPipeline(store, registry, makeConfig(fixtureDir), fixtureDir);
      await pipeline.indexAll();
      expect(importTargets(store, 'src/App.cs')).toEqual(new Set(['src/One.cs']));

      const onePath = path.join(fixtureDir, 'src/One.cs');
      const twoPath = path.join(fixtureDir, 'src/Two.cs');
      fs.rmSync(onePath);
      fs.writeFileSync(
        twoPath,
        `namespace Acme.Store
{
    public class Repo {}
}
`,
      );
      pipeline.deleteFiles([onePath]);
      await pipeline.indexFiles([twoPath]);

      // No stale pointer at the deleted One.cs — but no proactive edge to
      // Two.cs either, since deleteFiles already destroyed the edge this
      // resolver would otherwise have relinked from.
      expect(importTargets(store, 'src/App.cs')).toEqual(new Set());

      // A forced full reindex recomputes from scratch and recovers it (a
      // plain `indexAll()` would hash-skip both untouched files and prove
      // nothing).
      await pipeline.indexAll(true);
      expect(importTargets(store, 'src/App.cs')).toEqual(new Set(['src/Two.cs']));
    } finally {
      removeTmpDir(fixtureDir);
    }
  });

  it('prunes a stale edge even when the removed type was the last C# type in the whole index', async () => {
    // Top-level statements (C# 9+): App.cs declares no type of its own, so
    // once Store.cs stops declaring Repo, `byType` is empty across the
    // entire index. An earlier version early-returned on an empty `byType`
    // before the revalidation pass ever ran, leaving this edge stale.
    const fixtureDir = createTmpFixture(
      {
        'src/App.cs': `using static Acme.Store.Repo;

Run();
`,
        'src/Store.cs': `namespace Acme.Store
{
    public static class Repo
    {
        public static void Run() {}
    }
}
`,
      },
      'trace-mcp-csharp-empty-bytype-',
    );
    try {
      const store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new CSharpLanguagePlugin());
      const pipeline = new IndexingPipeline(store, registry, makeConfig(fixtureDir), fixtureDir);
      await pipeline.indexAll();
      expect(importTargets(store, 'src/App.cs')).toEqual(new Set(['src/Store.cs']));

      const storePath = path.join(fixtureDir, 'src/Store.cs');
      fs.writeFileSync(
        storePath,
        `namespace Acme.Store
{
}
`,
      );
      await pipeline.indexFiles([storePath]);

      expect(importTargets(store, 'src/App.cs')).toEqual(new Set());
    } finally {
      removeTmpDir(fixtureDir);
    }
  });
});
