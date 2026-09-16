/**
 * TRA-1577 — per-file tree-sitter Tree cache.
 *
 * Pins the contract the watcher-increment lifecycle depends on:
 * - miss → full parse + seed, caller owns the tree (must delete);
 * - identical text → no parse, a private copy, entry intact;
 * - edited text → incremental reparse with S-expression parity vs full parse;
 * - bounded: LRU entry cap + byte cap evict (and free WASM trees);
 * - invalidation: per-file drop, rename move, scope drop;
 * - isolation: scope / language / tag never alias;
 * - kill-switch: TRACE_MCP_NO_TREE_CACHE=1 bypasses everything.
 *
 * Uses an injected TreeCache per test — the process singleton is only
 * touched by the two tests that pin the module-level helpers, with
 * clearTreeCache() in finally blocks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Tree } from 'web-tree-sitter';
import {
  clearTreeCache,
  dropTreeCacheScope,
  getTreeCacheStats,
  incrementalShare,
  invalidateTreeCacheFile,
  NO_TREE_CACHE_ENV,
  parseWithTreeCache,
  renameTreeCacheFile,
  resetTreeCacheStats,
  TreeCache,
} from '../tree-cache.js';
import { getParser } from '../tree-sitter.js';

const LANG = 'typescript';
const FILE = 'src/a.ts';
const SCOPE = '/proj';

function freshCache(limits = { maxEntries: 50, maxBytes: 8 * 1024 * 1024 }): TreeCache {
  return new TreeCache(limits);
}

async function fullSexp(language: string, text: string): Promise<string> {
  const parser = await getParser(language);
  const tree = parser.parse(text);
  try {
    return tree.rootNode.toString();
  } finally {
    tree.delete();
  }
}

const BASE = 'function foo() {\n  return 1;\n}\n';
const EDITED = 'function foo() {\n  return 2;\n}\n';

afterEach(() => {
  clearTreeCache();
  delete process.env[NO_TREE_CACHE_ENV];
});

describe('parseWithTreeCache', () => {
  it('miss seeds the cache and returns a caller-owned tree', async () => {
    const cache = freshCache();
    const tree = await parseWithTreeCache(LANG, FILE, BASE, { scope: SCOPE, cache });
    try {
      expect(tree.rootNode.toString()).toBe(await fullSexp(LANG, BASE));
    } finally {
      tree.delete();
    }
    const stats = cache.getStats();
    expect(stats.fullParses).toBe(1);
    expect(stats.incrementalParses).toBe(0);
    expect(stats.entries).toBe(1);
  });

  it('identical text hits without parsing and keeps the entry', async () => {
    const cache = freshCache();
    const first = await parseWithTreeCache(LANG, FILE, BASE, { scope: SCOPE, cache });
    first.delete();
    const second = await parseWithTreeCache(LANG, FILE, BASE, { scope: SCOPE, cache });
    try {
      expect(second.rootNode.toString()).toBe(await fullSexp(LANG, BASE));
    } finally {
      second.delete();
    }
    const stats = cache.getStats();
    expect(stats.fullParses).toBe(1);
    expect(stats.identicalHits).toBe(1);
    expect(stats.entries).toBe(1);
  });

  it('edited text reuses the cached tree with full-parse parity', async () => {
    const cache = freshCache();
    const first = await parseWithTreeCache(LANG, FILE, BASE, { scope: SCOPE, cache });
    first.delete();
    const second = await parseWithTreeCache(LANG, FILE, EDITED, { scope: SCOPE, cache });
    try {
      expect(second.rootNode.toString()).toBe(await fullSexp(LANG, EDITED));
    } finally {
      second.delete();
    }
    const stats = cache.getStats();
    expect(stats.incrementalParses).toBe(1);
    expect(stats.fullParses).toBe(1);
    expect(incrementalShare(stats)).toBe(0.5);
    // The rotated entry serves the new text as an identical hit.
    const third = await parseWithTreeCache(LANG, FILE, EDITED, { scope: SCOPE, cache });
    third.delete();
    expect(cache.getStats().identicalHits).toBe(1);
  });

  it('chains sequential edits with parity at every step', async () => {
    const cache = freshCache();
    const versions = [
      'const a = 1;\n',
      'const a = 1;\nconst b = 2;\n',
      'const alpha = 1;\nconst b = 2;\n',
      'const alpha = 1;\n',
    ];
    for (const text of versions) {
      const tree = await parseWithTreeCache(LANG, FILE, text, { scope: SCOPE, cache });
      try {
        expect(tree.rootNode.toString()).toBe(await fullSexp(LANG, text));
      } finally {
        tree.delete();
      }
    }
    const stats = cache.getStats();
    expect(stats.fullParses).toBe(1);
    expect(stats.incrementalParses).toBe(3);
  });

  it('isolates scopes, languages, and tags', async () => {
    const cache = freshCache();
    const t1 = await parseWithTreeCache(LANG, FILE, BASE, { scope: '/a', cache });
    t1.delete();
    const t2 = await parseWithTreeCache(LANG, FILE, BASE, { scope: '/b', cache });
    t2.delete();
    const t3 = await parseWithTreeCache('tsx', FILE, BASE, { scope: '/a', cache });
    t3.delete();
    const t4 = await parseWithTreeCache(LANG, FILE, BASE, {
      scope: '/a',
      tag: 'setup',
      cache,
    });
    t4.delete();
    // Four distinct slots → four full parses, zero hits.
    expect(cache.getStats().fullParses).toBe(4);
    expect(cache.getStats().entries).toBe(4);
    // Each slot still serves its own identical hit.
    const again = await parseWithTreeCache(LANG, FILE, BASE, { scope: '/a', cache });
    again.delete();
    expect(cache.getStats().identicalHits).toBe(1);
  });

  it('bypasses everything when the kill-switch is set', async () => {
    process.env[NO_TREE_CACHE_ENV] = '1';
    const cache = freshCache();
    const tree = await parseWithTreeCache(LANG, FILE, BASE, { scope: SCOPE, cache });
    try {
      expect(tree.rootNode.toString()).toBe(await fullSexp(LANG, BASE));
    } finally {
      tree.delete();
    }
    expect(cache.getStats().fullParses).toBe(0);
    expect(cache.getStats().entries).toBe(0);
  });
});

describe('bounds', () => {
  it('evicts least-recently-used entries past maxEntries', async () => {
    const cache = freshCache({ maxEntries: 2, maxBytes: 64 * 1024 * 1024 });
    for (const f of ['a.ts', 'b.ts', 'c.ts']) {
      const tree = await parseWithTreeCache(LANG, f, BASE, { scope: SCOPE, cache });
      tree.delete();
    }
    expect(cache.getStats().entries).toBe(2);
    expect(cache.getStats().evictions).toBe(1);
    // 'a.ts' was evicted → next parse is a cold miss, not incremental.
    const before = cache.getStats();
    const tree = await parseWithTreeCache(LANG, 'a.ts', EDITED, { scope: SCOPE, cache });
    tree.delete();
    const after = cache.getStats();
    expect(after.fullParses).toBe(before.fullParses + 1);
    expect(after.incrementalParses).toBe(before.incrementalParses);
    // Re-adding 'a.ts' evicted 'b.ts' ({b,c} + a → {c,a}); 'c.ts' was never
    // touched, so it still serves an identical hit.
    const hit = await parseWithTreeCache(LANG, 'c.ts', BASE, { scope: SCOPE, cache });
    hit.delete();
    expect(cache.getStats().identicalHits).toBe(1);
  });

  it('refuses entries larger than the byte cap', async () => {
    const cache = freshCache({ maxEntries: 50, maxBytes: 16 });
    const tree = await parseWithTreeCache(LANG, FILE, BASE, { scope: SCOPE, cache });
    tree.delete();
    // BASE (~35 bytes text, ~4x heuristic) exceeds 16 bytes → parsed but uncached.
    expect(cache.getStats().entries).toBe(0);
    expect(cache.getStats().fullParses).toBe(1);
  });

  it('evicts by bytes when text volume exceeds maxBytes', async () => {
    // One entry weighs ~880 heuristic bytes (220 text × 4): fits alone under
    // 1000, but two cannot coexist.
    const cache = freshCache({ maxEntries: 50, maxBytes: 1000 });
    const big = `${'let x = 1;\n'.repeat(20)}`;
    const t1 = await parseWithTreeCache(LANG, 'big1.ts', big, { scope: SCOPE, cache });
    t1.delete();
    expect(cache.getStats().entries).toBe(1);
    const t2 = await parseWithTreeCache(LANG, 'big2.ts', big, { scope: SCOPE, cache });
    t2.delete();
    // Two ~880-byte-heuristic entries cannot both fit in 400 bytes.
    expect(cache.getStats().entries).toBe(1);
    expect(cache.getStats().evictions).toBeGreaterThanOrEqual(1);
  });
});

describe('invalidation', () => {
  it('invalidateFile drops every language/tag slot for the path', async () => {
    const cache = freshCache();
    for (const args of [
      { scope: SCOPE, tag: '' },
      { scope: SCOPE, tag: 'setup' },
    ] as const) {
      const tree = await parseWithTreeCache(LANG, FILE, BASE, { ...args, cache });
      tree.delete();
    }
    const py = await parseWithTreeCache('python', FILE, 'x = 1\n', { scope: SCOPE, cache });
    py.delete();
    expect(cache.getStats().entries).toBe(3);
    expect(cache.invalidateFile(SCOPE, FILE)).toBe(3);
    expect(cache.getStats().entries).toBe(0);
    expect(cache.getStats().invalidations).toBe(3);
    // A sibling file in the same scope is untouched.
    const sib = await parseWithTreeCache(LANG, 'src/b.ts', BASE, { scope: SCOPE, cache });
    sib.delete();
    expect(cache.invalidateFile(SCOPE, FILE)).toBe(0);
    expect(cache.getStats().entries).toBe(1);
  });

  it('renameFile moves the entry so the new path hits', async () => {
    const cache = freshCache();
    const tree = await parseWithTreeCache(LANG, 'src/old.ts', BASE, { scope: SCOPE, cache });
    tree.delete();
    expect(cache.renameFile(SCOPE, 'src/old.ts', 'src/new.ts')).toBe(1);
    // Same content under the new path → identical hit, no parse.
    const moved = await parseWithTreeCache(LANG, 'src/new.ts', BASE, { scope: SCOPE, cache });
    try {
      expect(moved.rootNode.toString()).toBe(await fullSexp(LANG, BASE));
    } finally {
      moved.delete();
    }
    expect(cache.getStats().identicalHits).toBe(1);
    expect(cache.getStats().fullParses).toBe(1);
    // The old path is a cold miss again.
    const cold = await parseWithTreeCache(LANG, 'src/old.ts', BASE, { scope: SCOPE, cache });
    cold.delete();
    expect(cache.getStats().fullParses).toBe(2);
  });

  it('dropScope removes only that project', async () => {
    const cache = freshCache();
    const t1 = await parseWithTreeCache(LANG, FILE, BASE, { scope: '/a', cache });
    t1.delete();
    const t2 = await parseWithTreeCache(LANG, FILE, BASE, { scope: '/b', cache });
    t2.delete();
    expect(cache.dropScope('/a')).toBe(1);
    expect(cache.getStats().entries).toBe(1);
    // '/b' still hits.
    const hit = await parseWithTreeCache(LANG, FILE, BASE, { scope: '/b', cache });
    hit.delete();
    expect(cache.getStats().identicalHits).toBe(1);
  });
});

describe('module-level helpers (default cache)', () => {
  it('invalidate / rename / dropScope delegate to the singleton', async () => {
    const t1 = await parseWithTreeCache(LANG, FILE, BASE, { scope: SCOPE });
    t1.delete();
    expect(getTreeCacheStats().entries).toBe(1);
    resetTreeCacheStats();
    expect(getTreeCacheStats().fullParses).toBe(0);
    expect(invalidateTreeCacheFile(SCOPE, FILE)).toBe(1);

    const t2 = await parseWithTreeCache(LANG, 'src/r.ts', BASE, { scope: SCOPE });
    t2.delete();
    expect(renameTreeCacheFile(SCOPE, 'src/r.ts', 'src/r2.ts')).toBe(1);
    const t3 = await parseWithTreeCache(LANG, 'src/r2.ts', BASE, { scope: SCOPE });
    t3.delete();
    expect(getTreeCacheStats().identicalHits).toBe(1);

    expect(dropTreeCacheScope(SCOPE)).toBe(1);
    expect(getTreeCacheStats().entries).toBe(0);
  });

  it('freed trees stay freed: evicted entries never resurface', async () => {
    const cache = freshCache({ maxEntries: 1, maxBytes: 64 * 1024 * 1024 });
    const trees: Tree[] = [];
    try {
      for (const f of ['x.ts', 'y.ts']) {
        trees.push(await parseWithTreeCache(LANG, f, BASE, { scope: SCOPE, cache }));
      }
      // Both caller trees are live and independent; the evicted cache copy of
      // x.ts was deleted exactly once (no double-free crash here or below).
      expect(trees[0].rootNode.toString()).toBe(trees[1].rootNode.toString());
    } finally {
      for (const t of trees) t.delete();
    }
    expect(cache.getStats().evictions).toBe(1);
  });
});
