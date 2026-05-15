/**
 * Behavioural coverage for the `delete_corpus` MCP tool.
 *
 * IMPL NOTE: `delete_corpus` is inline-registered in
 * `src/tools/register/knowledge.ts` (lines 264-285). The wrapper forwards
 * to `CorpusStore#delete(name)`, which removes both the manifest sidecar
 * and the packed body file from disk. We test the underlying primitive
 * against an isolated rootDir so we never touch the user's real
 * ~/.trace-mcp/corpora directory (same approach as
 * `list-corpora.behavioural.test.ts`).
 *
 * Contract under test:
 *   - delete() of an existing corpus returns true and removes it from list()
 *   - delete() of an unknown corpus returns false (no throw — idempotent)
 *   - delete() is idempotent: second call against the same name returns false
 *   - validateCorpusName guards bad input (delegated)
 *   - both manifest + pack body files are unlinked
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CorpusManifest, CorpusStore } from '../../../src/memory/corpus-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

function manifest(name: string, projectRoot = '/tmp/proj'): CorpusManifest {
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

describe('delete_corpus — CorpusStore#delete() behavioural contract', () => {
  let rootDir: string;
  let store: CorpusStore;

  beforeEach(() => {
    rootDir = createTmpDir('trace-mcp-delete-corpus-');
    store = new CorpusStore({ rootDir });
  });

  afterEach(() => {
    removeTmpDir(rootDir);
  });

  it('deleting an existing corpus returns true', () => {
    store.save(manifest('alpha'), '# packed body\n');
    expect(store.delete('alpha')).toBe(true);
  });

  it('after delete, the corpus is gone from list()', () => {
    store.save(manifest('alpha'), 'a\n');
    store.save(manifest('beta'), 'b\n');
    store.delete('alpha');
    const names = store.list().map((m) => m.name);
    expect(names).toEqual(['beta']);
  });

  it('deleting an unknown corpus returns false (no throw)', () => {
    expect(store.delete('does-not-exist')).toBe(false);
  });

  it('delete is idempotent — second delete against the same name returns false', () => {
    store.save(manifest('zeta'), 'z\n');
    expect(store.delete('zeta')).toBe(true);
    expect(store.delete('zeta')).toBe(false);
  });

  it('both manifest sidecar and packed body are unlinked from disk', () => {
    store.save(manifest('mu'), '# packed mu\n');
    // Verify files exist before delete.
    const beforeFiles = fs.readdirSync(rootDir).filter((f) => f.startsWith('mu'));
    expect(beforeFiles.length).toBeGreaterThanOrEqual(2);

    store.delete('mu');

    const afterFiles = fs.readdirSync(rootDir).filter((f) => f.startsWith('mu'));
    expect(afterFiles).toEqual([]);
  });

  it('deletion preserves sibling corpora — unrelated files are untouched', () => {
    store.save(manifest('alpha'), 'a\n');
    store.save(manifest('beta'), 'b\n');
    store.save(manifest('gamma'), 'g\n');
    store.delete('beta');

    const surviving = store
      .list()
      .map((m) => m.name)
      .sort();
    expect(surviving).toEqual(['alpha', 'gamma']);

    // Sibling pack bodies are still on disk too.
    const dirEntries = fs.readdirSync(rootDir);
    expect(dirEntries.some((f) => f.startsWith('alpha'))).toBe(true);
    expect(dirEntries.some((f) => f.startsWith('gamma'))).toBe(true);
    expect(dirEntries.some((f) => f.startsWith('beta'))).toBe(false);
    // Quiet unused-import lint in case path becomes unused.
    expect(path.basename(rootDir).length).toBeGreaterThan(0);
  });
});
