/**
 * Behavioural coverage for `list_corpora`. `listCorpora` is not exported as a
 * standalone function — the MCP wrapper calls `CorpusStore#list()`. We test
 * the same primitive against an isolated rootDir so we don't touch the user's
 * real ~/.trace-mcp/corpora directory.
 *
 * Contract under test:
 *  - empty store returns []
 *  - after saving one+ corpora, list returns each manifest
 *  - returned entries carry name/scope/projectRoot/sizes/timestamps
 *  - sorting is stable (alphabetical by name)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CorpusManifest, CorpusStore } from '../../../src/memory/corpus-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

function manifest(name: string, projectRoot: string): CorpusManifest {
  return {
    name,
    projectRoot,
    scope: 'project',
    tokenBudget: 10_000,
    symbolCount: 0,
    fileCount: 1,
    estimatedTokens: 42,
    packStrategy: 'most_relevant',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('list_corpora — CorpusStore#list() behavioural contract', () => {
  let rootDir: string;
  let store: CorpusStore;

  beforeEach(() => {
    rootDir = createTmpDir('trace-mcp-list-corpora-');
    store = new CorpusStore({ rootDir });
  });

  afterEach(() => {
    removeTmpDir(rootDir);
  });

  it('empty corpora dir returns []', () => {
    expect(store.list()).toEqual([]);
  });

  it('returns the saved manifest after one build', () => {
    store.save(manifest('alpha', '/tmp/proj-a'), '# packed body for alpha\n');
    const items = store.list();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('alpha');
    expect(items[0].projectRoot).toBe('/tmp/proj-a');
  });

  it('each entry carries scope, projectRoot, sizes and timestamps', () => {
    store.save(manifest('beta', '/tmp/proj-b'), '# packed beta\n');
    const [entry] = store.list();
    expect(entry.scope).toBe('project');
    expect(entry.projectRoot).toBe('/tmp/proj-b');
    expect(typeof entry.fileCount).toBe('number');
    expect(typeof entry.estimatedTokens).toBe('number');
    expect(typeof entry.tokenBudget).toBe('number');
    expect(typeof entry.createdAt).toBe('string');
    expect(typeof entry.updatedAt).toBe('string');
    // ISO timestamp shape
    expect(entry.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns multiple corpora sorted alphabetically by name', () => {
    store.save(manifest('zeta', '/tmp/p'), 'z\n');
    store.save(manifest('alpha', '/tmp/p'), 'a\n');
    store.save(manifest('mu', '/tmp/p'), 'm\n');
    const names = store.list().map((m) => m.name);
    expect(names).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('hidden / non-manifest sidecar files are ignored', () => {
    store.save(manifest('real', '/tmp/p'), '# body\n');
    // Simulate stray files in the corpora dir
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    fs.writeFileSync(path.join(rootDir, '.DS_Store'), 'noise');
    fs.writeFileSync(path.join(rootDir, 'README.txt'), 'not a manifest');
    const names = store.list().map((m) => m.name);
    expect(names).toEqual(['real']);
  });
});
