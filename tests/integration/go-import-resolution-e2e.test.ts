/**
 * Go cross-file import resolution E2E (TRA-449).
 *
 * The Go plugin has always extracted import specifiers, but nothing consumed
 * them: the ESM resolver skips non-JS languages, and the extractor only read
 * `metadata.from` while the Go plugin writes `metadata.module`. A real Go repo
 * therefore indexed with ZERO import edges while the published capability
 * matrix claimed Go had them.
 *
 * These tests pin the whole chain — extractor carries the specifier, the Go
 * resolver maps `<module path>/<pkg>` to the package directory, and the edge
 * lands file→file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { GoLanguagePlugin } from '../../src/indexer/plugins/language/go/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

const FILES: Record<string, string> = {
  'go.mod': `module example.com/app

go 1.22
`,
  'main.go': `package main

import (
	"fmt"
	"example.com/app/store"
	"github.com/spf13/pflag"
)

func main() { fmt.Println(store.Load(), pflag.Args()) }
`,
  'store/store.go': `package store

func Load() string { return "loaded" }
`,
  'store/store_test.go': `package store

import "testing"

func TestLoad(t *testing.T) { _ = Load() }
`,
  'api/handler.go': `package api

import "example.com/app/store"

func Handle() string { return store.Load() }
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

describe('Go import resolution E2E', () => {
  let store: Store;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = createTmpFixture(FILES, 'trace-mcp-go-imports-');
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new GoLanguagePlugin());

    const config: TraceMcpConfig = {
      root: fixtureDir,
      include: ['**/*.go'],
      exclude: ['node_modules/**'],
      plugins: [],
    } as TraceMcpConfig;

    await new IndexingPipeline(store, registry, config, fixtureDir).indexAll();
  });

  afterAll(() => {
    removeTmpDir(fixtureDir);
  });

  it('resolves a first-party package import to every file in that package', () => {
    expect(importTargets(store, 'main.go')).toContain('store/store.go');
  });

  it('resolves the same package from a second importer', () => {
    expect(importTargets(store, 'api/handler.go')).toContain('store/store.go');
  });

  it('never points an import at a _test.go file', () => {
    // `store_test.go` is only in the test binary — importing `store` must not
    // reach it, or every package fans out into its own test suite.
    for (const path of ['main.go', 'api/handler.go']) {
      for (const target of importTargets(store, path)) {
        expect(target.endsWith('_test.go')).toBe(false);
      }
    }
  });

  it('skips stdlib and third-party imports rather than inventing targets', () => {
    const targets = importTargets(store, 'main.go');
    expect(targets.size).toBe(1);
    for (const target of targets) expect(target.startsWith('store/')).toBe(true);
  });
});
