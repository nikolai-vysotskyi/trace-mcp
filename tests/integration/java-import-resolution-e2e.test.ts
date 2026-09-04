/**
 * Java cross-file import resolution E2E (TRA-483).
 *
 * Same gap TRA-449 closed for Go: the Java plugin extracted `import` specifiers
 * into `metadata.from`, but no pipeline pass consumed them, so a Java repo
 * indexed with zero import edges. These tests pin the four shapes a Java import
 * comes in — plain type, wildcard package, static member, nested class — plus
 * the rule that a JDK or third-party import resolves to nothing rather than to
 * an invented node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { JavaLanguagePlugin } from '../../src/indexer/plugins/language/java/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const SRC = 'src/main/java/com/example/app';

const FILES: Record<string, string> = {
  [`${SRC}/Main.java`]: `package com.example.app;

import java.util.List;
import org.apache.commons.lang3.StringUtils;
import com.example.app.store.Repo;
import static com.example.app.util.Ids.next;

public class Main {
  public static void main(String[] args) {
    List<String> all = new Repo().all();
    StringUtils.trim(all.get(next()));
  }
}
`,
  [`${SRC}/Api.java`]: `package com.example.app;

import com.example.app.store.*;

public class Api {
  Repo repo = new Repo();
  Row row = new Row();
}
`,
  [`${SRC}/Nested.java`]: `package com.example.app;

import com.example.app.store.Repo.Cursor;

public class Nested {
  Cursor cursor;
}
`,
  [`${SRC}/store/Repo.java`]: `package com.example.app.store;

import java.util.ArrayList;
import java.util.List;

public class Repo {
  public static class Cursor {}
  public List<String> all() { return new ArrayList<>(); }
}
`,
  [`${SRC}/store/Row.java`]: `package com.example.app.store;

public class Row {}
`,
  [`${SRC}/util/Ids.java`]: `package com.example.app.util;

public final class Ids {
  public static int next() { return 0; }
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

describe('Java import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-java-imports-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new JavaLanguagePlugin());

    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.java'],
      exclude: ['node_modules/**'],
      plugins: [],
    } as TraceMcpConfig;

    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('resolves a plain type import to the file declaring it', () => {
    expect(importTargets(store, `${SRC}/Main.java`)).toContain(`${SRC}/store/Repo.java`);
  });

  it('resolves a static member import to the class holding the member', () => {
    expect(importTargets(store, `${SRC}/Main.java`)).toContain(`${SRC}/util/Ids.java`);
  });

  it('resolves a wildcard import to every file in that package', () => {
    expect(importTargets(store, `${SRC}/Api.java`)).toEqual(
      new Set([`${SRC}/store/Repo.java`, `${SRC}/store/Row.java`]),
    );
  });

  it('resolves a nested-class import to its outer class file', () => {
    expect(importTargets(store, `${SRC}/Nested.java`)).toEqual(new Set([`${SRC}/store/Repo.java`]));
  });

  it('skips JDK and third-party imports rather than inventing targets', () => {
    // Main.java imports java.util.List and org.apache...StringUtils; neither is
    // in the repo, so only the two first-party targets may appear.
    expect(importTargets(store, `${SRC}/Main.java`).size).toBe(2);
    // Repo.java imports only JDK types — it must end up with no import edges.
    expect(importTargets(store, `${SRC}/store/Repo.java`).size).toBe(0);
  });
});
