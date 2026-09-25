/**
 * TRA-1912: a live growing file past the size cap (14 MB `.jsonl` scratchpad
 * with a 1 MB cap) re-fired the watcher on every append — ~482 doomed
 * pipelines in 51 minutes, each running lock + whole-file read + error count
 * only for the extractor to reject it again. Same class: hot binary journals.
 *
 * `checkUnindexableSkip()` + the `filterIndexablePaths` gate must drop these
 * paths before the pipeline lock (one stat + at most one 8 KB head read),
 * while a file that shrinks back under the cap (or rotates into text) must
 * become indexable again. Force-included `package.json` entries keep their
 * 5 MB ceiling through the gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { initContentHasher } from '../../src/util/hash.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import {
  __unindexableSkipCacheStats,
  checkUnindexableSkip,
  resetUnindexableSkipCacheForTests,
} from '../../src/indexer/unindexable-skip-cache.js';
import { logger } from '../../src/logger.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';

describe('TRA-1912 — unindexable-skip negative cache', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = createTmpDir('trace-mcp-unindexable-skip-');
    resetUnindexableSkipCacheForTests();
    await initContentHasher();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeTmpDir(tmpRoot);
  });

  function statOf(abs: string): { size: number; mtimeMs: number } {
    const st = fs.statSync(abs);
    return { size: st.size, mtimeMs: st.mtimeMs };
  }

  function check(relPosix: string) {
    const abs = path.join(tmpRoot, relPosix);
    return checkUnindexableSkip({ rootPath: tmpRoot, relPosix, absPath: abs, ...statOf(abs) });
  }

  function makeRegistry(): PluginRegistry {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    return registry;
  }

  function makeConfig(): TraceMcpConfig {
    return { root: tmpRoot, include: ['**/*'], exclude: [], plugins: [] };
  }

  it('a growing oversized file stays skipped; warn fires once, repeats go to debug', () => {
    const rel = path.join('scratchpad', 'channel_discovery', 'account_actions.jsonl');
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${'x'.repeat(1_200_000)}\n`);

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    // Three watcher events; the live scraper appends between them.
    for (let i = 0; i < 3; i++) {
      expect(check(rel.split(path.sep).join('/'))).toBe('oversize');
      fs.appendFileSync(abs, `${'y'.repeat(100_000)}\n`);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(2);
    const [meta, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe('File too large, skipping');
    expect(meta).toMatchObject({ file: rel.split(path.sep).join('/'), limit: 1_048_576 });
    expect(meta['size']).toBeGreaterThan(1_048_576);
  });

  it('shrinking back under the cap clears the oversize verdict', () => {
    const rel = 'big-then-small.ts';
    const abs = path.join(tmpRoot, rel);
    fs.writeFileSync(abs, `${'x'.repeat(1_200_000)}\n`);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    expect(check(rel)).toBe('oversize');
    fs.writeFileSync(abs, 'export const recovered = 1;\n');
    expect(check(rel)).toBeNull();
  });

  it('binary verdict is re-probed: clears when content becomes text, even at same size+mtime', () => {
    const rel = 'tg.session-journal';
    const abs = path.join(tmpRoot, rel);
    // Dense null bytes like a SQLite-style journal (well above the
    // isBinaryBuffer floor of 4 nulls + 0.4% density over the 8 KB window).
    fs.writeFileSync(abs, Buffer.alloc(9000));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    const first = statOf(abs);
    expect(checkUnindexableSkip({ rootPath: tmpRoot, relPosix: rel, absPath: abs, ...first })).toBe(
      'binary',
    );
    // A repeated check of unchanged content still answers 'binary'.
    expect(check(rel)).toBe('binary');

    // Same byte length, now plain text. TRA-1919: on coarse-mtime
    // filesystems (Windows) the rewrite lands inside one mtime tick, so a
    // size+mtime negative cache would answer stale 'binary' here. The gate
    // re-probes the head instead, so even a byte-identical stat clears.
    fs.writeFileSync(abs, 'a'.repeat(9000));
    expect(checkUnindexableSkip({ rootPath: tmpRoot, relPosix: rel, absPath: abs, ...first })).toBe(
      null,
    );

    // Fresh stat (new mtime) re-probes and clears: the file is text again.
    expect(check(rel)).toBeNull();
  });

  it('plain text files and missing paths resolve to null (pipeline must run)', () => {
    fs.writeFileSync(path.join(tmpRoot, 'ok.ts'), 'export const ok = 1;\n');
    expect(check('ok.ts')).toBeNull();

    // Unreadable here is not a verdict — the extractor's read path owns it.
    expect(
      checkUnindexableSkip({
        rootPath: tmpRoot,
        relPosix: 'gone.ts',
        absPath: path.join(tmpRoot, 'gone.ts'),
        size: 100,
        mtimeMs: Date.now(),
      }),
    ).toBeNull();
  });

  it('force-included package entries keep the 5 MB ceiling through the gate', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'huge-pkg', main: 'lodash.js' }, null, 2),
    );
    const head = 'export function bigEntry() {\n  return 42;\n}\n';
    fs.writeFileSync(path.join(tmpRoot, 'lodash.js'), head + `/* ${'x'.repeat(1_200_000)} */\n`);
    // Same size, NOT declared as an entry — still rejected.
    fs.writeFileSync(path.join(tmpRoot, 'plain.js'), head + `/* ${'x'.repeat(1_200_000)} */\n`);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    expect(check('lodash.js')).toBeNull();
    expect(check('plain.js')).toBe('oversize');

    // Above the hard ceiling even a declared entry is an artifact, not source.
    fs.writeFileSync(
      path.join(tmpRoot, 'lodash.js'),
      head + `/* ${'x'.repeat(6 * 1024 * 1024)} */\n`,
    );
    resetUnindexableSkipCacheForTests();
    expect(check('lodash.js')).toBe('oversize');
  });

  it('cache bookkeeping stays bounded', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    for (let i = 0; i < 300; i++) {
      checkUnindexableSkip({
        rootPath: tmpRoot,
        relPosix: `hot/file-${i}.ts`,
        absPath: path.join(tmpRoot, `hot/file-${i}.ts`),
        size: 2 * 1024 * 1024,
        mtimeMs: 1000 + i,
      });
    }
    const stats = __unindexableSkipCacheStats();
    expect(stats.totalEntries).toBeLessThanOrEqual(stats.maxEntriesPerRoot);

    for (let r = 0; r < 70; r++) {
      checkUnindexableSkip({
        rootPath: `${tmpRoot}-root-${r}`,
        relPosix: 'big.ts',
        absPath: path.join(tmpRoot, 'big.ts'),
        size: 2 * 1024 * 1024,
        mtimeMs: 2000,
      });
    }
    expect(__unindexableSkipCacheStats().roots).toBeLessThanOrEqual(
      __unindexableSkipCacheStats().maxRoots,
    );
  });

  it('indexFiles drops a growing oversized file before the pipeline: no errors, no rows', async () => {
    const store = createTestStore();
    const pipeline = new IndexingPipeline(store, makeRegistry(), makeConfig(), tmpRoot);
    const rel = path.join('scratchpad', 'channel_discovery', 'account_actions.jsonl');
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${'x'.repeat(1_200_000)}\n`);
    try {
      for (let i = 0; i < 3; i++) {
        const r = await pipeline.indexFiles([abs]);
        expect(r.totalFiles).toBe(0);
        expect(r.indexed).toBe(0);
        expect(r.errors).toBe(0);
        expect(store.getFile(rel.split(path.sep).join('/')), 'no row must be created').toBeFalsy();
        fs.appendFileSync(abs, `${'y'.repeat(100_000)}\n`);
      }
    } finally {
      await pipeline.dispose();
    }
  });

  it('indexFiles recovers a file that shrank back under the cap', async () => {
    const store = createTestStore();
    const pipeline = new IndexingPipeline(store, makeRegistry(), makeConfig(), tmpRoot);
    const abs = path.join(tmpRoot, 'recovered.jsonl');
    fs.writeFileSync(abs, `${'x'.repeat(1_200_000)}\n`);
    try {
      const dropped = await pipeline.indexFiles([abs]);
      expect(dropped.totalFiles).toBe(0);

      fs.writeFileSync(abs, '{"ok":true}\n');
      const flowed = await pipeline.indexFiles([abs]);
      expect(flowed.totalFiles).toBe(1);
      expect(flowed.errors).toBe(0);
    } finally {
      await pipeline.dispose();
    }
  });

  it('indexFiles still indexes a force-included entry above the cap (no carve-out regression)', async () => {
    const store = createTestStore();
    const pipeline = new IndexingPipeline(store, makeRegistry(), makeConfig(), tmpRoot);
    const head =
      '// Auto-generated huge entry-point fixture\nexport function bigEntry() {\n  return 42;\n}\n';
    fs.writeFileSync(
      path.join(tmpRoot, 'lodash.js'),
      head + `/* ${'x'.repeat(1_200_000 - head.length)} */\n`,
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'huge-pkg', main: 'lodash.js' }, null, 2),
    );
    try {
      const r = await pipeline.indexFiles([path.join(tmpRoot, 'lodash.js')]);
      expect(r.errors).toBe(0);
      expect(r.indexed).toBe(1);
      expect(store.getFile('lodash.js')).toBeTruthy();
    } finally {
      await pipeline.dispose();
    }
  });

  it('indexFiles drops a hot binary journal before the pipeline', async () => {
    const store = createTestStore();
    const pipeline = new IndexingPipeline(store, makeRegistry(), makeConfig(), tmpRoot);
    const rel = path.join('bank_mentions', 'tg.session-journal');
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(20_000));
    try {
      const r = await pipeline.indexFiles([abs]);
      expect(r.totalFiles).toBe(0);
      expect(r.errors).toBe(0);
      // The journal keeps appending — every event must stay cheap.
      fs.appendFileSync(abs, Buffer.alloc(1000));
      const r2 = await pipeline.indexFiles([abs]);
      expect(r2.totalFiles).toBe(0);
      expect(r2.errors).toBe(0);
    } finally {
      await pipeline.dispose();
    }
  });
});
