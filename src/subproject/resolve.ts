import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TOPOLOGY_DB_PATH } from '../global.js';
import { logger } from '../logger.js';
import { resolveRegisteredAncestor } from '../registry.js';

/** True when `p` is `ancestor` itself or lives underneath it. */
function isAncestorOrSelf(ancestor: string, p: string): boolean {
  const rel = path.relative(ancestor, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Deepest registered *subproject* (topology.db `subprojects.repo_root`) that is
 * an ancestor-or-self of `cwd`. Read-only, best-effort: returns null when
 * topology.db is missing/unreadable or nothing matches. Cheap — one indexed
 * query, run only at session bootstrap / recovery.
 */
export function findSubprojectRootForPath(cwd: string, dbPath = TOPOLOGY_DB_PATH): string | null {
  const abs = path.resolve(cwd);
  if (!fs.existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT DISTINCT repo_root FROM subprojects').all() as {
      repo_root: string;
    }[];
    let best: string | null = null;
    for (const { repo_root } of rows) {
      const r = path.resolve(repo_root);
      // Among ancestors-of-`abs`, the longest path is the deepest ancestor.
      if (isAncestorOrSelf(r, abs) && (best === null || r.length > best.length)) best = r;
    }
    return best;
  } catch (err) {
    logger.debug({ err: String(err), dbPath }, 'findSubprojectRootForPath: topology read failed');
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}

/**
 * True when `root` is ITSELF a registered subproject repo_root (not merely
 * living under one). Lets the auto-add path serve a known subproject read-mostly
 * (indexed once, no fs watcher, no registry.json entry) instead of promoting it
 * to a full watched project — the resource guard for umbrella repos with many
 * subprojects (#209). `findSubprojectRootForPath` returns the deepest ancestor,
 * which equals `root` exactly when `root` is the registered subproject.
 */
export function isKnownSubproject(root: string, dbPath = TOPOLOGY_DB_PATH): boolean {
  return findSubprojectRootForPath(root, dbPath) === path.resolve(root);
}

/**
 * Resolve the most-specific KNOWN project root for a session cwd: the deeper of
 * the registered-project ancestor and the registered *subproject* repo_root.
 *
 * A subproject (e.g. `the/fair/fair-front`, registered via Codechats/
 * subproject_add_repo with its own index db_path) beats its container ancestor
 * (`the`) so the session binds to the subproject's own scoped index instead of
 * the container's mixed 9k-file blob — the "ругается на зонтик" gap (#209): the
 * subproject index existed but the router only consulted registry.json and
 * fell through to the container. Both ancestors are prefixes of `cwd`, so the
 * longer path is the deeper one. Returns null when neither covers the path
 * (caller falls back to worktree-aware resolution / raw cwd).
 */
export function resolveDeepestKnownRoot(cwd: string): string | null {
  const abs = path.resolve(cwd);
  const registryAncestor = resolveRegisteredAncestor(abs)?.root ?? null;
  const subprojectRoot = findSubprojectRootForPath(abs);
  if (registryAncestor && subprojectRoot) {
    return subprojectRoot.length > registryAncestor.length ? subprojectRoot : registryAncestor;
  }
  return subprojectRoot ?? registryAncestor;
}
