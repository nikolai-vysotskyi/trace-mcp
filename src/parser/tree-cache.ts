/**
 * Per-file tree-sitter Tree cache for the watcher-increment lifecycle
 * (TRA-1577, F2 follow-up to the TRA-1540 `tree.edit()` prototype).
 *
 * The pipeline parses files from scratch on every edit: an edited file goes
 * through `FileExtractor.extract` → language plugin → `parser.parse(text)` →
 * `tree.delete()`, even when the edit touched two lines. This module keeps
 * the last parsed Tree + its source text per file so the next edit of the
 * same file goes through `parseIncremental` (single `computeSingleEdit` +
 * `tree.edit()`) instead of a full parse.
 *
 * Ownership (copy semantics, deliberate): the cache NEVER hands out its own
 * trees. Every `parseWithTreeCache` caller gets a tree it owns and must
 * `delete()` — exactly like `parser.parse()`. Internally the cache keeps a
 * private `tree.copy()` per entry (web-tree-sitter documents `copy()` as a
 * very fast shallow copy). This keeps the per-plugin diff to one line and
 * makes a missed `delete()` in a caller corrupt nothing but its own memory.
 *
 * Correctness notes:
 * - Incremental reparse is always a correct full parse of the new text — the
 *   old tree is only a reuse hint. A stale/wrong-base entry costs speed, not
 *   correctness. Cross-scope aliasing (same relPath in two projects sharing
 *   one process) is still avoided by scoping keys on the project root.
 * - Every cache operation is defensive: any failure (copy throws, incremental
 *   throws, entry oversized) falls back to a plain full parse. The cache must
 *   never break extraction.
 * - Evicted / invalidated / cleared entries are always `tree.delete()`d —
 *   otherwise the WASM-side nodes leak silently (the issue's explicit worry).
 *
 * Workers: each worker thread imports this module separately, so the cache is
 * automatically per-worker. `drop_project` control messages drop the scope
 * (see `extract-worker.ts`); the daemon drops the main-thread scope in
 * `project-manager.ts` on project removal.
 *
 * No native dependencies — pure web-tree-sitter (WASM), same as the parser
 * factory this builds on.
 */

import type { Tree } from 'web-tree-sitter';
import { getParser, parseIncremental } from './tree-sitter.js';

/** Kill-switch + bench A/B arm: bypass the cache with plain full parses. */
export const NO_TREE_CACHE_ENV = 'TRACE_MCP_NO_TREE_CACHE';

export function isTreeCacheEnabled(): boolean {
  return process.env[NO_TREE_CACHE_ENV] !== '1';
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface TreeCacheLimits {
  maxEntries: number;
  maxBytes: number;
}

export function defaultTreeCacheLimits(): TreeCacheLimits {
  return {
    maxEntries: readEnvInt('TRACE_MCP_TREE_CACHE_ENTRIES', DEFAULT_MAX_ENTRIES),
    maxBytes: readEnvInt('TRACE_MCP_TREE_CACHE_BYTES', DEFAULT_MAX_BYTES),
  };
}

/**
 * Heuristic weight of one cached tree in bytes. The entry always pins its
 * source text (exact byte length) plus the WASM-side tree, whose size has no
 * public API — estimated at 3× the text bytes (tree-sitter nodes run ~40+
 * bytes C-side at roughly one node per 10–20 source bytes for code). The cap
 * is a guardrail against unbounded growth, not accounting: over-counting
 * evicts early (safe direction), under-counting is bounded by maxEntries.
 */
const TREE_BYTES_PER_TEXT_BYTE = 3;

export interface TreeCacheStats {
  /** Full `parser.parse()` runs (misses + incremental-fallback rebuilds). */
  fullParses: number;
  /** Successful `parseIncremental()` reuses — the issue's headline metric. */
  incrementalParses: number;
  /** Text-identical hits: no parse at all, a copy of the cached tree. */
  identicalHits: number;
  /** Entries evicted by the LRU / byte caps. */
  evictions: number;
  /** Entries dropped by explicit invalidation (delete / scope drop). */
  invalidations: number;
  /** Entries currently held. */
  entries: number;
  /** Approximate bytes currently held (text + tree heuristic). */
  approxBytes: number;
}

interface TreeCacheEntry {
  scope: string;
  language: string;
  filePath: string;
  tag: string;
  text: string;
  tree: Tree;
  bytes: number;
}

function entryBytes(text: string): number {
  const textBytes = Buffer.byteLength(text);
  return textBytes + textBytes * TREE_BYTES_PER_TEXT_BYTE;
}

function safeDelete(tree: Tree | undefined): void {
  if (!tree) return;
  try {
    tree.delete();
  } catch {
    /* best-effort: the map state is already updated; never throw out of evict */
  }
}

function safeCopy(tree: Tree): Tree | null {
  try {
    return tree.copy();
  } catch {
    return null;
  }
}

export class TreeCache {
  private readonly entries = new Map<string, TreeCacheEntry>();
  private approxBytes = 0;
  private fullParses = 0;
  private incrementalParses = 0;
  private identicalHits = 0;
  private evictions = 0;
  private invalidations = 0;

  constructor(private readonly limits: TreeCacheLimits = defaultTreeCacheLimits()) {}

  static keyFor(scope: string, language: string, filePath: string, tag = ''): string {
    return tag
      ? `${scope}\u0000${language}\u0000${filePath}\u0000${tag}`
      : `${scope}\u0000${language}\u0000${filePath}`;
  }

  /** Test seam: current entry count. Prefer `getStats().entries` in prod code. */
  get size(): number {
    return this.entries.size;
  }

  getStats(): TreeCacheStats {
    return {
      fullParses: this.fullParses,
      incrementalParses: this.incrementalParses,
      identicalHits: this.identicalHits,
      evictions: this.evictions,
      invalidations: this.invalidations,
      entries: this.entries.size,
      approxBytes: this.approxBytes,
    };
  }

  /** Reset counters only (keeps entries) — bench session boundaries. */
  resetStats(): void {
    this.fullParses = 0;
    this.incrementalParses = 0;
    this.identicalHits = 0;
    this.evictions = 0;
    this.invalidations = 0;
  }

  /** LRU lookup: returns the entry and refreshes its recency. */
  getEntry(key: string): TreeCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Map insertion order is the LRU order: re-insert to mark most-recent.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Store a caller-owned tree under `key`, keeping a private copy. When the
   * copy fails (or the entry is oversized) nothing is stored and the caller
   * keeps its tree — the parse result is never at risk.
   */
  store(
    key: string,
    opts: { scope: string; language: string; filePath: string; tag: string; text: string },
    tree: Tree,
  ): void {
    const bytes = entryBytes(opts.text);
    if (bytes > this.limits.maxBytes) return;
    const copy = safeCopy(tree);
    if (!copy) return;
    this.remove(key);
    this.entries.set(key, { ...opts, tree: copy, bytes });
    this.approxBytes += bytes;
    this.evictWhileOverCaps();
  }

  /**
   * Replace the entry at `key` with a new caller-owned tree (the
   * incremental path: the old cached tree was consumed by `tree.edit()` and
   * is freed here). Keeps a private copy; on copy failure the entry is
   * dropped and the caller keeps its tree.
   */
  replace(
    key: string,
    opts: { scope: string; language: string; filePath: string; tag: string; text: string },
    tree: Tree,
  ): void {
    this.remove(key);
    this.store(key, opts, tree);
  }

  /** Drop one entry, freeing its WASM tree. Returns true when present. */
  remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.approxBytes -= entry.bytes;
    safeDelete(entry.tree);
    return true;
  }

  /**
   * Drop every entry for a file across all languages and tags (the grammar
   * used for a path can change between edits — e.g. a `.js` file gaining JSX
   * flips `typescript` → `tsx` — so invalidation must not filter by language).
   */
  invalidateFile(scope: string, filePath: string): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.scope === scope && entry.filePath === filePath) {
        this.entries.delete(key);
        this.approxBytes -= entry.bytes;
        safeDelete(entry.tree);
        dropped++;
      }
    }
    this.invalidations += dropped;
    return dropped;
  }

  /**
   * Move every entry for a renamed file to its new path (rename keeps content
   * identical, so the moved entry is immediately usable as an incremental
   * base — or an identical hit — instead of a cold miss plus a stale leak).
   * A pre-existing entry at the target is dropped first.
   */
  renameFile(scope: string, fromPath: string, toPath: string): number {
    if (fromPath === toPath) return 0;
    let moved = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.scope !== scope || entry.filePath !== fromPath) continue;
      // A stale entry may already sit at the target (e.g. the new path was
      // parsed before the rename was detected) — drop it first so the moved
      // entry, whose text matches the renamed file's content, wins.
      const targetKey = TreeCache.keyFor(entry.scope, entry.language, toPath, entry.tag);
      if (targetKey !== key) this.remove(targetKey);
      this.entries.delete(key);
      // Re-key under the new path (re-inserted as most-recent). The live
      // tree moves untouched — rename keeps content identical, so the entry
      // is immediately usable as an incremental base or identical hit.
      entry.filePath = toPath;
      this.entries.set(targetKey, entry);
      moved++;
    }
    return moved;
  }

  /** Drop every entry under a project scope (project removal). */
  dropScope(scope: string): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (entry.scope !== scope) continue;
      this.entries.delete(key);
      this.approxBytes -= entry.bytes;
      safeDelete(entry.tree);
      dropped++;
    }
    this.invalidations += dropped;
    return dropped;
  }

  /** Free every entry and reset counters. Tests + process teardown. */
  clear(): void {
    for (const entry of this.entries.values()) safeDelete(entry.tree);
    this.entries.clear();
    this.approxBytes = 0;
    this.resetStats();
  }

  recordFullParse(): void {
    this.fullParses++;
  }

  recordIncrementalParse(): void {
    this.incrementalParses++;
  }

  recordIdenticalHit(): void {
    this.identicalHits++;
  }

  private evictWhileOverCaps(): void {
    while (this.entries.size > this.limits.maxEntries || this.approxBytes > this.limits.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      const key = oldest.value;
      const entry = this.entries.get(key);
      this.entries.delete(key);
      if (entry) {
        this.approxBytes -= entry.bytes;
        safeDelete(entry.tree);
      }
      this.evictions++;
    }
  }
}

/** Process-wide cache (per worker thread in pool workers — see module doc). */
export const defaultTreeCache = new TreeCache();

export interface ParseWithTreeCacheOptions {
  /** Project scope namespacing the key (absolute root path). Unscoped when omitted. */
  scope?: string;
  /** Discriminator when one file is parsed as several texts (vue/astro blocks). */
  tag?: string;
  /** Inject a cache (tests). Defaults to the process-wide singleton. */
  cache?: TreeCache;
}

/** Scope used when none is provided — keeps unscoped (test/tool) keys apart. */
export const UNSCOPED = '';

/**
 * Parse `text` for (`scope`, `language`, `filePath`[, `tag`]), reusing the
 * cached Tree via `parseIncremental` when the file was parsed before.
 *
 * Caller-owned result: MUST be `delete()`d like any `parser.parse()` tree —
 * the cache only ever keeps its own private copies. Any cache failure falls
 * back to a plain full parse, so extraction can never break because of this.
 */
export async function parseWithTreeCache(
  language: string,
  filePath: string,
  text: string,
  opts: ParseWithTreeCacheOptions = {},
): Promise<Tree> {
  const cache = opts.cache ?? defaultTreeCache;
  if (!isTreeCacheEnabled()) {
    const parser = await getParser(language);
    return parser.parse(text);
  }
  const scope = opts.scope ?? UNSCOPED;
  const tag = opts.tag ?? '';
  const key = TreeCache.keyFor(scope, language, filePath, tag);
  const meta = { scope, language, filePath, tag };

  const entry = cache.getEntry(key);
  if (!entry) {
    const parser = await getParser(language);
    const tree = parser.parse(text);
    cache.store(key, { ...meta, text }, tree);
    cache.recordFullParse();
    return tree;
  }

  if (entry.text === text) {
    const copy = safeCopy(entry.tree);
    if (copy) {
      cache.recordIdenticalHit();
      return copy;
    }
    // Copy failed — fall through to a full parse (entry stays for next time).
  } else {
    try {
      // parseIncremental narrows null away, but the WASM binding returns
      // null at runtime when it refuses the old tree — handle it.
      const newTree: Tree | null = await parseIncremental(language, entry.tree, entry.text, text);
      if (newTree === entry.tree) {
        // Unreachable in practice (texts differ, so parseIncremental always
        // reparses) — but if it ever happens, hand out a copy, keep entry.
        const copy = safeCopy(entry.tree);
        if (copy) {
          cache.recordIdenticalHit();
          return copy;
        }
      } else if (newTree !== null) {
        cache.replace(key, { ...meta, text }, newTree);
        cache.recordIncrementalParse();
        return newTree;
      } else {
        // The WASM parse refused the edited old tree (returns null at
        // runtime despite the narrowed type) — drop the spent entry and fall
        // through to a full parse below. Extraction must degrade, not crash.
        cache.remove(key);
      }
    } catch {
      // The cached tree may have been mutated by tree.edit() before the
      // failure — drop it rather than poison the next lookup.
      cache.remove(key);
    }
  }

  const parser = await getParser(language);
  const tree = parser.parse(text);
  cache.store(key, { ...meta, text }, tree);
  cache.recordFullParse();
  return tree;
}

/** Share of cached parses that went the incremental route (0–1, NaN when idle). */
export function incrementalShare(
  stats: Pick<TreeCacheStats, 'incrementalParses' | 'fullParses'>,
): number {
  const total = stats.incrementalParses + stats.fullParses;
  return total === 0 ? Number.NaN : stats.incrementalParses / total;
}

export function getTreeCacheStats(): TreeCacheStats {
  return defaultTreeCache.getStats();
}

export function resetTreeCacheStats(): void {
  defaultTreeCache.resetStats();
}

/** Drop every cached tree for a file (delete / rename-source paths). */
export function invalidateTreeCacheFile(scope: string, filePath: string): number {
  return defaultTreeCache.invalidateFile(scope, filePath);
}

/** Move cached trees across a rename (identical content → still usable). */
export function renameTreeCacheFile(scope: string, fromPath: string, toPath: string): number {
  return defaultTreeCache.renameFile(scope, fromPath, toPath);
}

/** Drop a whole project scope (project removal / worker drop_project). */
export function dropTreeCacheScope(scope: string): number {
  return defaultTreeCache.dropScope(scope);
}

/** Free everything (tests). */
export function clearTreeCache(): void {
  defaultTreeCache.clear();
}
