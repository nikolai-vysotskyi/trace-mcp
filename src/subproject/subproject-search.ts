/**
 * Subproject search — cross-repo BM25 FTS across all registered subprojects.
 * Extracted from SubprojectManager to reduce class complexity.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { searchFts } from '../db/fts.js';
import { logger } from '../logger.js';
import type { TopologyStore } from '../topology/topology-db.js';

export interface SubprojectSearchItem {
  repo: string;
  symbol_id: string;
  name: string;
  kind: string;
  fqn: string | null;
  signature: string | null;
  file: string;
  line: number | null;
  score: number;
}

export interface SubprojectSearchResult {
  items: SubprojectSearchItem[];
  total: number;
  repos_searched: number;
}

/**
 * Search a single subproject repo's DB: run FTS, normalize BM25 scores within
 * the repo (rank is negative, lower = better), and join symbol rows.
 * Extracted out of subprojectSearch() — this was the per-repo unit of work
 * (DB lifecycle + score math + row join) that made the top-level function do
 * two things at once (orchestrate repos AND process one). Callers own the
 * `db` handle's lifecycle (open/close); this function only reads from it.
 */
function searchRepoDb(
  db: Database.Database,
  repoName: string,
  query: string,
  filters: { kind?: string; language?: string; filePattern?: string } | undefined,
  limit: number,
): SubprojectSearchItem[] {
  const ftsResults = searchFts(db, query, limit, 0, {
    kind: filters?.kind,
    language: filters?.language,
    filePattern: filters?.filePattern,
  });
  if (ftsResults.length === 0) return [];

  const minRank = Math.min(...ftsResults.map((r) => r.rank));
  const maxRank = Math.max(...ftsResults.map((r) => r.rank));
  const rankSpread = maxRank - minRank || 1;

  const symbolIds = ftsResults.map((r) => r.symbolId);
  const symbolRows = db
    .prepare(
      `SELECT s.id, s.symbol_id, s.name, s.kind, s.fqn, s.signature, s.line_start, f.path as file_path
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.id IN (${symbolIds.map(() => '?').join(',')})`,
    )
    .all(...symbolIds) as Array<{
    id: number;
    symbol_id: string;
    name: string;
    kind: string;
    fqn: string | null;
    signature: string | null;
    line_start: number | null;
    file_path: string;
  }>;

  const symbolMap = new Map(symbolRows.map((s) => [s.id, s]));

  const items: SubprojectSearchItem[] = [];
  for (const fts of ftsResults) {
    const sym = symbolMap.get(fts.symbolId);
    if (!sym) continue;
    items.push({
      repo: repoName,
      symbol_id: sym.symbol_id,
      name: sym.name,
      kind: sym.kind,
      fqn: sym.fqn,
      signature: sym.signature,
      file: sym.file_path,
      line: sym.line_start,
      score: 1 - (fts.rank - minRank) / rankSpread,
    });
  }
  return items;
}

/**
 * Canonical form for comparing two repo roots. `path.resolve` collapses
 * trailing and duplicated separators the same way `upsertSubproject` does when
 * it writes the row — and unlike a `/\/+$/` strip it carries no ReDoS risk on
 * a path that ultimately comes from a tool caller.
 */
const normRoot = (root: string): string => path.resolve(root);

/**
 * Subprojects reachable from `projectRoot`: those registered under it, plus —
 * when `projectRoot` is itself a registered subproject — its siblings under the
 * same parent project. The topology DB is global (one row per repo ever
 * registered on the machine), so without this filter a scoped search fanned out
 * across every unrelated repo: wrong results, wasted tokens (TRA-470).
 */
export function reachableSubprojects<T extends { repo_root: string; project_root: string }>(
  repos: T[],
  projectRoot: string,
): T[] {
  const scope = normRoot(projectRoot);
  const parents = new Set([scope]);
  for (const repo of repos) {
    if (normRoot(repo.repo_root) === scope) parents.add(normRoot(repo.project_root));
  }
  return repos.filter((repo) => parents.has(normRoot(repo.project_root)));
}

/**
 * Search subprojects reachable from `projectRoot`. Opens each per-repo DB
 * readonly, runs FTS search, normalizes scores within the repo, and merges
 * results. Omitting `projectRoot` searches every registered subproject.
 */
export function subprojectSearch(
  topoStore: TopologyStore,
  query: string,
  filters?: { kind?: string; language?: string; filePattern?: string },
  limit = 20,
  projectRoot?: string,
): SubprojectSearchResult {
  const allRepos = topoStore.getAllSubprojects();
  const repos = projectRoot ? reachableSubprojects(allRepos, projectRoot) : allRepos;
  const allItems: SubprojectSearchItem[] = [];
  let reposSearched = 0;

  const normalizedExclude = projectRoot ? normRoot(projectRoot) : undefined;

  for (const repo of repos) {
    if (!repo.db_path || !fs.existsSync(repo.db_path)) continue;
    // Skip the local repo — its results are already in the primary search
    if (normalizedExclude && normRoot(repo.repo_root) === normalizedExclude) continue;

    let db: Database.Database | null = null;
    try {
      db = new Database(repo.db_path, { readonly: true });
      db.pragma('busy_timeout = 3000');

      const items = searchRepoDb(db, repo.name, query, filters, limit);
      if (items.length === 0) continue;
      reposSearched++;
      allItems.push(...items);
    } catch (e) {
      logger.warn({ repo: repo.name, error: e }, 'Failed to search subproject repo');
    } finally {
      db?.close();
    }
  }

  allItems.sort((a, b) => b.score - a.score);
  return { items: allItems.slice(0, limit), total: allItems.length, repos_searched: reposSearched };
}
