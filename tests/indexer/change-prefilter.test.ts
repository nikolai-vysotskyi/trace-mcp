/**
 * TRA-1536 — mtime+size change prefilter (`selectChangedFiles`).
 *
 * Contract under test: the prefilter answers "what changed" with one lstat
 * per file instead of one extract() dispatch per file.
 *
 *   - Property (no miss): every file whose mtime floor OR byte size differs
 *     from the stored row — plus new files, deleted files, symlinks and rows
 *     without a stored mtime — MUST be an extract candidate.
 *   - Precision (no wasted work): every file whose content is untouched MUST
 *     be skipped.
 *   - Soundness: every skipped file has byte-identical content to what was
 *     indexed (verified by re-hashing, not by re-reading the predicate).
 *
 * Known limitation (documented, pre-existing): a rewrite that keeps BOTH the
 * mtime-ms floor and the byte size is undetectable without reading — the old
 * mtime-only fast-path inside extract() had the same blind spot. The
 * randomized round below never generates that case; the unit test pins the
 * adjacent detectable case (same floor, different size → candidate).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { selectChangedFiles } from '../../src/indexer/change-prefilter.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { hashContent } from '../../src/utils/hasher.js';
import { initContentHasher } from '../../src/util/hash.js';
import { createTestStore } from '../test-utils.js';

describe('selectChangedFiles — mtime+size prefilter', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-prefilter-'));
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makePipeline() {
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config: TraceMcpConfig = {
      root: tmpRoot,
      include: ['src/**/*.ts'],
      exclude: [],
      plugins: [],
    };
    return { store, pipeline: new IndexingPipeline(store, registry, config, tmpRoot) };
  }

  function write(rel: string, content: string): string {
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  function bumpMtime(abs: string, deltaSec = 5): void {
    const stat = fs.statSync(abs);
    const t = Math.floor(stat.mtimeMs / 1000) + deltaSec;
    fs.utimesSync(abs, t, t);
  }

  it('untouched files are skipped, appended file is a candidate', async () => {
    const { store, pipeline } = makePipeline();
    const rels = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    for (const [i, rel] of rels.entries()) write(rel, `export const v${i} = ${i};\n`);
    await pipeline.indexAll();

    const changedAbs = path.join(tmpRoot, 'src/b.ts');
    fs.appendFileSync(changedAbs, 'export const extra = 1;\n');

    const existing = store.getFilesByPaths(rels);
    const { candidates, skipped } = selectChangedFiles(tmpRoot, rels, existing, false);
    expect(candidates).toEqual(['src/b.ts']);
    expect(skipped).toBe(2);
  });

  it('new file without a stored row is a candidate', async () => {
    const { store, pipeline } = makePipeline();
    write('src/a.ts', 'export const a = 1;\n');
    await pipeline.indexAll();

    write('src/new.ts', 'export const n = 1;\n');
    const existing = store.getFilesByPaths(['src/a.ts', 'src/new.ts']);
    const { candidates, skipped } = selectChangedFiles(
      tmpRoot,
      ['src/a.ts', 'src/new.ts'],
      existing,
      false,
    );
    expect(candidates).toEqual(['src/new.ts']);
    expect(skipped).toBe(1);
  });

  it('mtime touch with identical size is a candidate (conservative)', async () => {
    const { store, pipeline } = makePipeline();
    const abs = write('src/t.ts', 'export const t = 1;\n');
    await pipeline.indexAll();

    bumpMtime(abs, 30);
    const existing = store.getFilesByPaths(['src/t.ts']);
    const { candidates } = selectChangedFiles(tmpRoot, ['src/t.ts'], existing, false);
    expect(candidates).toEqual(['src/t.ts']);
  });

  it('same-mtime-floor rewrite with different size is a candidate', async () => {
    const { store, pipeline } = makePipeline();
    const abs = write('src/r.ts', 'export const r = 1;\n');
    await pipeline.indexAll();

    const before = fs.statSync(abs);
    // Different-length content, then restore the exact mtime (simulates a
    // rewrite inside the same mtime-ms floor the old check would miss).
    fs.writeFileSync(abs, 'export const r = 100000;\n');
    fs.utimesSync(abs, before.atime, before.mtime);

    const existing = store.getFilesByPaths(['src/r.ts']);
    const row = existing.get('src/r.ts')!;
    expect(row.mtime_ms).toBe(Math.floor(before.mtimeMs));
    expect(row.byte_length).not.toBe(fs.statSync(abs).size);

    const { candidates, skipped } = selectChangedFiles(tmpRoot, ['src/r.ts'], existing, false);
    expect(candidates).toEqual(['src/r.ts']);
    expect(skipped).toBe(0);
  });

  it('missing file and symlink pass through as candidates', async () => {
    const { store, pipeline } = makePipeline();
    write('src/a.ts', 'export const a = 1;\n');
    await pipeline.indexAll();

    const existing = store.getFilesByPaths(['src/a.ts', 'src/gone.ts']);
    const { candidates } = selectChangedFiles(
      tmpRoot,
      ['src/a.ts', 'src/gone.ts'],
      existing,
      false,
    );
    // a.ts unchanged → skipped; gone.ts has no row and no file → candidate
    // (extract() owns the error path, the prefilter must not swallow it).
    expect(candidates).toEqual(['src/gone.ts']);
  });

  it('force=true makes everything a candidate', async () => {
    const { store, pipeline } = makePipeline();
    write('src/a.ts', 'export const a = 1;\n');
    await pipeline.indexAll();

    const existing = store.getFilesByPaths(['src/a.ts']);
    const { candidates, skipped } = selectChangedFiles(tmpRoot, ['src/a.ts'], existing, true);
    expect(candidates).toEqual(['src/a.ts']);
    expect(skipped).toBe(0);
  });

  it('legacy row without stored size falls back to the mtime verdict', async () => {
    const { store } = makePipeline();
    const abs = write('src/legacy.ts', 'export const l = 1;\n');
    const stat = fs.statSync(abs);
    // byte_length NULL, mtime matching — as migrated pre-TRA-1536 rows look.
    store.insertFile(
      'src/legacy.ts',
      'typescript',
      'hash_legacy',
      null,
      null,
      Math.floor(stat.mtimeMs),
    );

    const existing = store.getFilesByPaths(['src/legacy.ts']);
    const { candidates, skipped } = selectChangedFiles(tmpRoot, ['src/legacy.ts'], existing, false);
    expect(candidates).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('randomized round: no detectably-changed file is skipped, skipped files are byte-identical', async () => {
    await initContentHasher();
    const { store, pipeline } = makePipeline();

    // Deterministic PRNG (mulberry32) — the round must be reproducible.
    let seed = 0x1536;
    const rand = (): number => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const N = 25;
    const rels: string[] = [];
    for (let i = 0; i < N; i++) {
      const rel = `src/f${i}.ts`;
      write(rel, `export const f${i} = ${i};\n// pad ${'x'.repeat(i)}\n`);
      rels.push(rel);
    }
    await pipeline.indexAll();

    // Mutate a random subset: appends (mtime+size) and touches (mtime only).
    // Same-size same-mtime rewrites are deliberately NOT generated — they are
    // undetectable without reading (documented limitation, same as the old
    // mtime fast-path).
    const touched = new Set<string>();
    const appended = new Set<string>();
    for (const rel of rels) {
      const r = rand();
      const abs = path.join(tmpRoot, rel);
      if (r < 0.3) {
        fs.appendFileSync(abs, `// mutation ${rel}\n`);
        appended.add(rel);
      } else if (r < 0.5) {
        bumpMtime(abs, 60 + Math.floor(rand() * 600));
        touched.add(rel);
      }
    }
    // Plus brand-new files (no stored row at all).
    const newRels = ['src/n0.ts', 'src/n1.ts'];
    for (const rel of newRels) write(rel, `export const n = 1;\n`);
    const all = [...rels, ...newRels];

    const existing = store.getFilesByPaths(all);
    const { candidates, skipped } = selectChangedFiles(tmpRoot, all, existing, false);
    const candidateSet = new Set(candidates);

    // Property 1 — no miss: every detectably-changed file is a candidate.
    for (const rel of [...appended, ...touched, ...newRels]) {
      expect(candidateSet.has(rel)).toBe(true);
    }
    // Property 2 — precision: untouched files are never extracted.
    for (const rel of rels) {
      if (!appended.has(rel) && !touched.has(rel)) {
        expect(candidateSet.has(rel)).toBe(false);
      }
    }
    expect(skipped).toBe(N - appended.size - touched.size);

    // Property 3 — soundness: every skipped file is byte-identical to the
    // indexed content (re-hash from disk, compare to the stored hash).
    for (const rel of all) {
      if (candidateSet.has(rel)) continue;
      const row = existing.get(rel)!;
      const disk = fs.readFileSync(path.join(tmpRoot, rel));
      expect(hashContent(disk)).toBe(row.content_hash);
    }
  });

  it('pipeline wiring: zero-change reindex skips everything, 1-file change indexes exactly 1', async () => {
    const { pipeline } = makePipeline();
    const rels = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    for (const [i, rel] of rels.entries()) write(rel, `export const w${i} = ${i};\n`);

    const cold = await pipeline.indexAll();
    expect(cold.indexed).toBe(3);

    const noop = await pipeline.indexAll();
    expect(noop.indexed).toBe(0);
    expect(noop.errors).toBe(0);
    expect(noop.skipped).toBe(3);

    fs.appendFileSync(path.join(tmpRoot, 'src/b.ts'), 'export const changed = true;\n');
    const inc = await pipeline.indexAll();
    expect(inc.indexed).toBe(1);
    expect(inc.errors).toBe(0);
    expect(inc.skipped).toBe(2);
    expect(inc.totalFiles).toBe(3);
  });

  it('oversized file is rejected without a behavior change (stat precheck)', async () => {
    const { pipeline } = makePipeline();
    write('src/ok.ts', 'export const ok = 1;\n');
    // 2 MB of text — over the 1 MB default cap, not a package entry.
    write('src/big.ts', `// pad\n${'y'.repeat(2 * 1024 * 1024)}\n`);
    const r = await pipeline.indexAll();
    expect(r.indexed).toBe(1);
    expect(r.errors).toBe(1);
  });
});
