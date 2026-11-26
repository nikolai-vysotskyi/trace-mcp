import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import {
  IndexingPipeline,
  readIndexTruncation,
  META_INDEX_TRUNCATED,
  META_INDEX_TRUNCATED_FOUND,
  META_INDEX_TRUNCATED_LIMIT,
} from '../pipeline.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { TypeScriptLanguagePlugin } from '../plugins/language/typescript/index.js';
import { createTestStore } from '../../../tests/test-utils.js';
import { verifyIndex } from '../../db/verify.js';
import { getIndexHealth } from '../../tools/project/project.js';

// TRA-3214: a project found truncated on one full walk (found=57080,
// limit=40000) later showed index_truncated=0 while the found/limit
// companions still read 57080/40000 — a self-contradictory row when read
// directly, because the untruncated branch only cleared the flag and left
// the previous run's found/limit sitting there. Readers were already
// gating found/limit on the flag (so nothing downstream actually lied), but
// the two layers below close the gap: the write side clears found/limit in
// lockstep with the flag, and the read side treats a stale found>limit pair
// as proof regardless of what the flag says.
describe('TRA-3214: index_truncated metadata stays internally consistent', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra3214-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('a walk that stops truncating clears found/limit instead of leaving them stale', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(tempDir, 'src', `f${i}.ts`), `export const v${i} = ${i};`);
    }
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = TraceMcpConfigSchema.parse({
      root: tempDir,
      include: ['src/**/*.ts'],
      exclude: [],
      security: { max_files: 5 },
    });
    const pipeline = new IndexingPipeline(store, registry, config, tempDir, undefined, {});

    await pipeline.indexAll();
    expect(readIndexTruncation(store)).toEqual({ found: 20, limit: 5 });
    expect(store.getRepoMetadata(META_INDEX_TRUNCATED_FOUND)).toBe('20');

    // Same tree, cap raised above the real file count — the next full walk
    // genuinely fits. A fresh pipeline instance over the same store stands
    // in for "the cap was raised in config and a full reindex ran".
    const config2 = TraceMcpConfigSchema.parse({
      root: tempDir,
      include: ['src/**/*.ts'],
      exclude: [],
      security: { max_files: 1000 },
    });
    const pipeline2 = new IndexingPipeline(store, registry, config2, tempDir, undefined, {});
    await pipeline2.indexAll(true, { discovery: 'full-walk' });
    await pipeline2.dispose();

    expect(readIndexTruncation(store)).toBeNull();
    expect(store.getRepoMetadata(META_INDEX_TRUNCATED)).toBe('0');
    // The companions must be gone, not merely ignored — a stale found/limit
    // pair next to flag '0' is exactly the contradiction this fixes.
    expect(store.getRepoMetadata(META_INDEX_TRUNCATED_FOUND)).toBeNull();
    expect(store.getRepoMetadata(META_INDEX_TRUNCATED_LIMIT)).toBeNull();

    await pipeline.dispose();
  });

  it('full-walk → auto with an unchanged file set and limit keeps reporting the same overflow (TRA-3214 acceptance case)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(tempDir, 'src', `f${i}.ts`), `export const v${i} = ${i};`);
    }
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = TraceMcpConfigSchema.parse({
      root: tempDir,
      include: ['src/**/*.ts'],
      exclude: [],
      security: { max_files: 5 },
    });
    const pipeline = new IndexingPipeline(store, registry, config, tempDir, undefined, {});

    // Initial full walk: truncated, stamps {found: 8, limit: 5}.
    await pipeline.indexAll();
    expect(readIndexTruncation(store)).toEqual({ found: 8, limit: 5 });

    // "auto": the normal, non-forced indexAll call a watcher/schedule would
    // make, with nothing on disk and nothing in config changed. Whether it
    // takes the incremental fast path (which never touches this metadata) or
    // re-walks, the persisted overflow must not change.
    await pipeline.indexAll();

    expect(readIndexTruncation(store)).toEqual({ found: 8, limit: 5 });
    expect(store.getRepoMetadata(META_INDEX_TRUNCATED)).toBe('1');
    expect(store.getRepoMetadata(META_INDEX_TRUNCATED_FOUND)).toBe('8');
    expect(store.getRepoMetadata(META_INDEX_TRUNCATED_LIMIT)).toBe('5');

    const health = getIndexHealth(store, config, tempDir);
    expect(health.status).toBe('degraded');
    expect(health.truncated).toEqual({ found: 8, limit: 5 });

    await pipeline.dispose();
  });

  it('readIndexTruncation reports the overflow from a stale found/limit pair even when the flag reads 0', () => {
    const store = createTestStore();
    store.setRepoMetadata(META_INDEX_TRUNCATED, '0');
    store.setRepoMetadata(META_INDEX_TRUNCATED_FOUND, '57080');
    store.setRepoMetadata(META_INDEX_TRUNCATED_LIMIT, '40000');

    expect(readIndexTruncation(store)).toEqual({ found: 57080, limit: 40000 });
  });

  it('readIndexTruncation reports nothing once the companions are cleared', () => {
    const store = createTestStore();
    store.setRepoMetadata(META_INDEX_TRUNCATED, '0');

    expect(readIndexTruncation(store)).toBeNull();
  });

  it('verifyIndex warns on a stale found/limit pair even when the flag reads 0', () => {
    const store = createTestStore();
    store.setRepoMetadata(META_INDEX_TRUNCATED, '0');
    store.setRepoMetadata(META_INDEX_TRUNCATED_FOUND, '57080');
    store.setRepoMetadata(META_INDEX_TRUNCATED_LIMIT, '40000');

    const report = verifyIndex(store.db);
    const check = report.checks.find((c) => c.name === 'index_truncation');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('57080 file(s) found on disk, capped at 40000');
  });

  // Regression (caught in review): the found>limit fail-safe above must not
  // replace the unconditional warning on flag='1' — a partial stamp (the
  // flag written, the found/limit write failing or never having landed)
  // must still read as truncated, not silently as complete.
  it('verifyIndex warns when the flag reads 1 even without a valid found/limit pair', () => {
    const store = createTestStore();
    store.setRepoMetadata(META_INDEX_TRUNCATED, '1');

    const report = verifyIndex(store.db);
    const check = report.checks.find((c) => c.name === 'index_truncation');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('unknown file(s) found on disk, capped at unknown');
  });
});
