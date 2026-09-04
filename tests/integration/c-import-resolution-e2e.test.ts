/**
 * C/C++ cross-file `#include` resolution E2E (TRA-832).
 *
 * Same gap TRA-449 closed for Go, TRA-483 for Java and TRA-565 for Rust: the
 * C and C++ plugins extracted every `#include` into `metadata.module`, but no
 * pipeline pass consumed it, so a C repo indexed with zero import edges
 * (confirmed on redis: 191 files, 0 edges). These tests pin the shapes an
 * include comes in — same-directory quoted, `../` relative, an angle-bracket
 * path resolved by suffix, a cross-language C header included from a `.cpp`
 * file — plus the rules that a system header resolves to nothing and an
 * ambiguous bare filename is left unresolved rather than guessed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { CLanguagePlugin } from '../../src/indexer/plugins/language/c/index.js';
import { CppLanguagePlugin } from '../../src/indexer/plugins/language/cpp/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const FILES: Record<string, string> = {
  'src/main.c': `#include "app.h"
#include <stdio.h>

int main(void) { return 0; }
`,
  'src/app.h': `#ifndef APP_H
#define APP_H
void app_init(void);
#endif
`,
  'src/utils/helper.c': `#include "../app.h"

void helper(void) {}
`,
  'include/api/api.hpp': `#pragma once
namespace api { void call(); }
`,
  'src/wrapper.cpp': `#include "app.h"
#include <api/api.hpp>

void wrap() {}
`,
  'src/moduleA/common.h': `#define A 1
`,
  'src/moduleB/common.h': `#define B 2
`,
  'src/moduleC/user2.c': `#include "common.h"

void use(void) {}
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

describe('C/C++ import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-c-imports-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new CLanguagePlugin());
    registry.registerLanguagePlugin(new CppLanguagePlugin());

    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.c', '**/*.h', '**/*.cpp', '**/*.hpp'],
      exclude: ['node_modules/**'],
      plugins: [],
    } as TraceMcpConfig;

    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('resolves a same-directory quoted include', () => {
    expect(importTargets(store, 'src/main.c')).toContain('src/app.h');
  });

  it('resolves a `../` relative include', () => {
    expect(importTargets(store, 'src/utils/helper.c')).toContain('src/app.h');
  });

  it('resolves a cross-language include — a .cpp file pulling in a C header', () => {
    expect(importTargets(store, 'src/wrapper.cpp')).toContain('src/app.h');
  });

  it('resolves an angle-bracket include by path suffix when it is not relative to the source file', () => {
    // `#include <api/api.hpp>` in src/wrapper.cpp — the file lives at
    // include/api/api.hpp, unreachable by relative-path resolution alone.
    expect(importTargets(store, 'src/wrapper.cpp')).toContain('include/api/api.hpp');
  });

  it('skips a system header rather than inventing a target', () => {
    // main.c also includes <stdio.h>, which is not part of the repo.
    expect(importTargets(store, 'src/main.c')).toEqual(new Set(['src/app.h']));
  });

  it('leaves an ambiguous bare-filename include unresolved', () => {
    // Two files named common.h exist (moduleA, moduleB); user2.c's own
    // directory has neither, so the suffix match is ambiguous and no edge
    // is created for either candidate.
    expect(importTargets(store, 'src/moduleC/user2.c').size).toBe(0);
  });
});
