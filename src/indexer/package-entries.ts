/**
 * Package.json entry-point discovery for the indexer.
 *
 * Files referenced from `package.json#main` / `module` / `bin` / `exports`
 * are the package's *public surface*. Excluding them from the index because
 * of an incidental size cap silently breaks dead-code analysis, call-graph
 * navigation, and any tool that follows public exports.
 *
 * Lodash 4.17.21 is the canonical example: `lodash.js` is a 548 KB UMD/IIFE
 * declared as the package's `main`. With the default 1 MB cap we already
 * include it, but jcodemunch's 500 KB cap dropped it. To stay robust against
 * cap tightening (and oversized monolithic libs we ship in monorepos), we
 * pre-compute the set of force-included paths and let extract() skip the
 * size check for them.
 *
 * Mirrors jcodemunch v1.80.9 force-include logic.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { yieldToEventLoopFair } from '../utils/event-loop.js';

const PACKAGE_ENTRIES_CACHE_TTL_MS = 60_000;
const MAX_PACKAGE_ENTRIES_CACHE_ENTRIES = 20;

const packageEntriesCache = new Map<string, { entries: Set<string>; computedAt: number }>();

/** Evict package.json entry cache (all or per-root). */
export function clearPackageEntriesCache(rootPath?: string): void {
  if (rootPath) {
    packageEntriesCache.delete(rootPath);
  } else {
    packageEntriesCache.clear();
  }
}

/**
 * Walk every `package.json` under `rootPath` (skipping node_modules and
 * vendor dirs), resolve `main` / `module` / `bin` / `exports` to relative
 * file paths, and return them as a Set of project-root-relative paths
 * with forward slashes.
 *
 * Wildcards in subpath/conditional `exports` keys or values are skipped
 * — they map to many files and can't be enumerated upfront.
 */
export function findPackageJsonEntries(
  rootPath: string,
  options?: { bypassCache?: boolean; ttlMs?: number },
): Set<string> {
  const cached = readCachedEntries(rootPath, options);
  if (cached) return cached;
  const entries = new Set<string>();
  for (const _ of scanPackageEntries(rootPath, entries)) {
    // Synchronous callers use the same scanner and cache contract.
  }
  cacheEntries(rootPath, entries);
  return entries;
}

/** Cooperative variant for bulk indexing: no directory walk may monopolize /health. */
export async function findPackageJsonEntriesAsync(
  rootPath: string,
  options?: { bypassCache?: boolean; ttlMs?: number },
): Promise<Set<string>> {
  const cached = readCachedEntries(rootPath, options);
  if (cached) return cached;
  const entries = new Set<string>();
  let dirs = 0;
  for (const _ of scanPackageEntries(rootPath, entries)) {
    if (++dirs % 32 === 0) await yieldToEventLoopFair();
  }
  cacheEntries(rootPath, entries);
  return entries;
}

function readCachedEntries(
  rootPath: string,
  options?: { bypassCache?: boolean; ttlMs?: number },
): Set<string> | undefined {
  const ttl = options?.ttlMs ?? PACKAGE_ENTRIES_CACHE_TTL_MS;
  if (!options?.bypassCache) {
    const cached = packageEntriesCache.get(rootPath);
    if (cached && Date.now() - cached.computedAt < ttl) {
      // LRU refresh: move to end
      packageEntriesCache.delete(rootPath);
      packageEntriesCache.set(rootPath, cached);
      return cached.entries;
    }
  }
  return undefined;
}

function* scanPackageEntries(rootPath: string, entries: Set<string>): Generator<void> {
  if (!rootPath || !fs.existsSync(rootPath)) return;

  const visited = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
  const MAX_DEPTH = 8;

  // A cursor keeps breadth-first order without Array.shift's quadratic copies.
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { dir, depth } = queue[cursor]!;
    if (visited.has(dir)) continue;
    visited.add(dir);

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of dirents) {
      const name = ent.name;
      // Skip directories that never contain first-party source
      if (ent.isDirectory()) {
        if (
          depth >= MAX_DEPTH ||
          name === 'node_modules' ||
          name === 'vendor' ||
          name === 'dist' ||
          name === 'build' ||
          name === '.git' ||
          name === 'coverage' ||
          name === 'tmp' ||
          name === 'temp' ||
          name === '__pycache__' ||
          name === 'site-packages' ||
          name.startsWith('.') // .next, .turbo, .pnpm-store, etc.
        ) {
          continue;
        }
        queue.push({ dir: path.join(dir, name), depth: depth + 1 });
        continue;
      }

      if (!ent.isFile() || name !== 'package.json') continue;

      const pkgPath = path.join(dir, name);
      try {
        const raw = fs.readFileSync(pkgPath, 'utf-8');
        const pkg = JSON.parse(raw);
        const baseDir = path.relative(rootPath, dir).replace(/\\/g, '/');

        const add = (rel: unknown) => {
          if (typeof rel !== 'string') return;
          if (rel.includes('*')) return; // wildcard — can't enumerate
          // Strip leading ./ before joining so we don't get  ".//foo"
          const cleaned = rel.replace(/^\.\//, '');
          const joined = baseDir ? `${baseDir}/${cleaned}` : cleaned;
          entries.add(path.normalize(joined).replace(/\\/g, '/'));
        };

        add(pkg.main);
        add(pkg.module);
        if (typeof pkg.bin === 'string') {
          add(pkg.bin);
        } else if (pkg.bin && typeof pkg.bin === 'object') {
          for (const v of Object.values(pkg.bin)) add(v);
        }
        if (pkg.exports !== undefined) {
          for (const target of walkExportsTargets(pkg.exports)) add(target);
        }
      } catch (e) {
        // Malformed package.json shouldn't break the whole indexer
        logger.debug({ err: e, pkgPath }, 'force-include: failed to parse package.json');
      }
    }
    yield;
  }
}

function cacheEntries(rootPath: string, entries: Set<string>): void {
  packageEntriesCache.delete(rootPath);
  if (packageEntriesCache.size >= MAX_PACKAGE_ENTRIES_CACHE_ENTRIES) {
    const oldestKey = packageEntriesCache.keys().next().value;
    if (oldestKey !== undefined) packageEntriesCache.delete(oldestKey);
  }
  packageEntriesCache.set(rootPath, { entries, computedAt: Date.now() });
}

/**
 * Walk a `package.json#exports` value and yield concrete relative target
 * paths. Same algorithm as the dead-code reachability walker — duplicated
 * here to avoid an indexer→tools layering violation.
 */
function walkExportsTargets(node: unknown): string[] {
  const out: string[] = [];
  visit(node);
  return out;

  function visit(n: unknown): void {
    if (typeof n === 'string') {
      if (n.startsWith('./') || n.startsWith('/')) out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (n && typeof n === 'object') {
      const obj = n as Record<string, unknown>;
      const keys = Object.keys(obj);
      const isSubpathMap = keys.some((k) => k === '.' || k.startsWith('./'));
      if (isSubpathMap) {
        for (const k of keys) {
          if (k.includes('*')) continue;
          visit(obj[k]);
        }
      } else {
        for (const k of keys) visit(obj[k]);
      }
    }
  }
}
