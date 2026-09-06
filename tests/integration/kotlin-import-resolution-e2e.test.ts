/**
 * Kotlin cross-file import resolution E2E (TRA-451).
 *
 * Same gap TRA-449 closed for Go: the Kotlin plugin extracted `import`
 * specifiers into `metadata.from`, but no pipeline pass consumed them, so a
 * Kotlin repo indexed with zero import edges. These tests pin the shapes a
 * Kotlin import comes in — plain class, wildcard package, member import
 * (Kotlin's equivalent of Java's static import), nested class — plus the
 * rule that a stdlib/JDK import resolves to nothing rather than to an
 * invented node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { KotlinLanguagePlugin } from '../../src/indexer/plugins/language/kotlin/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const SRC = 'src/main/kotlin/com/example/app';

const FILES: Record<string, string> = {
  [`${SRC}/Main.kt`]: `package com.example.app

import com.example.app.store.Repo
import com.example.app.util.Ids.next
import java.util.List

class Main {
    fun run() {
        val repo = Repo()
        next()
    }
}
`,
  [`${SRC}/Api.kt`]: `package com.example.app

import com.example.app.store.*

class Api {
    val repo = Repo()
    val row = Row()
}
`,
  [`${SRC}/Nested.kt`]: `package com.example.app

import com.example.app.store.Repo.Cursor

class Nested {
    var cursor: Cursor? = null
}
`,
  [`${SRC}/store/Repo.kt`]: `package com.example.app.store

class Repo {
    class Cursor
    fun all(): List<String> = emptyList()
}
`,
  [`${SRC}/store/Row.kt`]: `package com.example.app.store

class Row
`,
  [`${SRC}/util/Ids.kt`]: `package com.example.app.util

object Ids {
    fun next(): Int = 0
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

describe('Kotlin import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-kotlin-imports-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new KotlinLanguagePlugin());

    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.kt'],
      exclude: ['node_modules/**'],
      plugins: [],
    } as TraceMcpConfig;

    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('resolves a plain class import to the file declaring it', () => {
    expect(importTargets(store, `${SRC}/Main.kt`)).toContain(`${SRC}/store/Repo.kt`);
  });

  it('resolves a member import to the object/class holding the member', () => {
    expect(importTargets(store, `${SRC}/Main.kt`)).toContain(`${SRC}/util/Ids.kt`);
  });

  it('resolves a wildcard import to every file in that package', () => {
    expect(importTargets(store, `${SRC}/Api.kt`)).toEqual(
      new Set([`${SRC}/store/Repo.kt`, `${SRC}/store/Row.kt`]),
    );
  });

  it('resolves a nested-class import to its outer class file', () => {
    expect(importTargets(store, `${SRC}/Nested.kt`)).toEqual(new Set([`${SRC}/store/Repo.kt`]));
  });

  it('skips JDK/stdlib imports rather than inventing targets', () => {
    // Main.kt imports com.example.app.store.Repo and util.Ids.next (first-party)
    // plus java.util.List (JDK) — only the two first-party targets may appear.
    expect(importTargets(store, `${SRC}/Main.kt`).size).toBe(2);
    // Repo.kt declares its own nested class and a method returning a JDK
    // List, but has no import statements of its own — no import edges.
    expect(importTargets(store, `${SRC}/store/Repo.kt`).size).toBe(0);
  });
});
