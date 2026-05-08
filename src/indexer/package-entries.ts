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

/**
 * Walk every `package.json` under `rootPath` (skipping node_modules and
 * vendor dirs), resolve `main` / `module` / `bin` / `exports` to relative
 * file paths, and return them as a Set of project-root-relative paths
 * with forward slashes.
 *
 * Wildcards in subpath/conditional `exports` keys or values are skipped
 * — they map to many files and can't be enumerated upfront.
 */
export function findPackageJsonEntries(rootPath: string): Set<string> {
  const entries = new Set<string>();
  if (!rootPath || !fs.existsSync(rootPath)) return entries;

  const visited = new Set<string>();
  const queue: string[] = [rootPath];

  while (queue.length > 0) {
    const dir = queue.shift()!;
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
          name === 'node_modules' ||
          name === 'vendor' ||
          name === 'dist' ||
          name === 'build' ||
          name === '.git' ||
          name.startsWith('.') // .next, .turbo, .pnpm-store, etc.
        ) {
          continue;
        }
        queue.push(path.join(dir, name));
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
  }

  return entries;
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
