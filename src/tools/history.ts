/**
 * Historical Graph Analysis (Time Machine)
 *
 * Structural trend analysis that complements git churn with graph-level data:
 * - Coupling trend: how Ca/Ce/instability changed over time for a file
 * - Symbol complexity trend: per-symbol cyclomatic/nesting growth across commits
 */

import { execFileSync } from 'node:child_process';
import type { Store } from '../db/store.js';
import { isGitRepo } from './git-analysis.js';
import { computeCyclomatic, computeMaxNesting, computeParamCount } from './complexity.js';
import { logger } from '../logger.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface CouplingSnapshot {
  date: string;
  commit: string;
  /** Afferent coupling — files that import this file */
  ca: number;
  /** Efferent coupling — files this file imports */
  ce: number;
  /** Instability I = Ce / (Ca + Ce). 0 = stable, 1 = unstable */
  instability: number;
}

interface CouplingTrendResult {
  file: string;
  current: CouplingSnapshot;
  historical: CouplingSnapshot[];
  trend: 'stabilizing' | 'stable' | 'destabilizing';
  /** Change in instability from oldest snapshot to current */
  instability_delta: number;
  /** Change in total coupling (Ca + Ce) */
  coupling_delta: number;
}

interface SymbolComplexitySnapshot {
  date: string;
  commit: string;
  cyclomatic: number;
  max_nesting: number;
  param_count: number;
  lines: number;
}

interface SymbolComplexityTrendResult {
  symbol_id: string;
  name: string;
  file: string;
  current: SymbolComplexitySnapshot;
  historical: SymbolComplexitySnapshot[];
  trend: 'improving' | 'stable' | 'degrading';
  /** Change in cyclomatic from oldest snapshot to current */
  cyclomatic_delta: number;
}

// ════════════════════════════════════════════════════════════════════════
// GIT HELPERS
// ════════════════════════════════════════════════════════════════════════

/** Get sampled commit hashes that touched a file within a time window. */
function sampleFileCommits(
  cwd: string,
  filePath: string,
  sinceDays: number | undefined,
  count: number,
): Array<{ hash: string; date: string }> {
  const args = [
    'log', '--pretty=format:%H|%aI', '--follow', '--no-merges',
    `--max-count=${count * 3}`,
  ];
  if (sinceDays !== undefined) {
    args.push(`--since=${sinceDays} days ago`);
  }
  args.push('--', filePath);

  let output: string;
  try {
    output = execFileSync('git', args, {
      cwd, stdio: 'pipe', timeout: 10_000,
    }).toString('utf-8');
  } catch {
    return [];
  }

  const all = output.split('\n').filter(Boolean).map((line) => {
    const [hash, date] = line.split('|');
    return { hash, date: date.split('T')[0] };
  });

  if (all.length <= count) return all;

  // Sample evenly, always include newest + oldest
  const step = Math.max(1, Math.floor((all.length - 1) / (count - 1)));
  const sampled: typeof all = [];
  for (let i = 0; i < all.length && sampled.length < count; i += step) {
    sampled.push(all[i]);
  }
  if (sampled[sampled.length - 1] !== all[all.length - 1]) {
    sampled.push(all[all.length - 1]);
  }
  return sampled;
}

/** Get file content at a specific commit. Returns null if file doesn't exist. */
function getFileAtCommit(cwd: string, filePath: string, commitHash: string): string | null {
  try {
    return execFileSync('git', ['show', `${commitHash}:${filePath}`], {
      cwd, stdio: 'pipe', timeout: 10_000, maxBuffer: 5 * 1024 * 1024,
    }).toString('utf-8');
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// IMPORT PARSING (language-agnostic heuristic, line-based)
// ════════════════════════════════════════════════════════════════════════

/** Count import statements in a file (Ce approximation). Line-based to avoid multiline regex issues. */
export function countImports(content: string): number {
  let count = 0;
  for (const line of content.split('\n')) {
    const t = line.trim();
    // ESM: import ... from '...'  or  import '...'
    if (/^import\s+/.test(t) && /['"]/.test(t)) { count++; continue; }
    // CJS: require('...')
    if (/\brequire\s*\(\s*['"]/.test(t)) { count++; continue; }
    // Python: from X import ... / import X
    if (/^(?:from\s+\S+\s+import|import\s+\S+)/.test(t)) { count++; continue; }
    // Go: import "..."
    if (/^import\s+"/.test(t)) { count++; continue; }
    // PHP: use Namespace\...
    if (/^use\s+[A-Z\\]/.test(t)) { count++; continue; }
  }
  return count;
}

/**
 * Count files importing a given file path at a commit using git grep.
 * Only uses the directory-qualified base name to avoid false positives
 * from overly short patterns like "utils" or "config".
 */
function countImportersAtCommit(
  cwd: string,
  filePath: string,
  commitHash: string,
): number {
  // Derive searchable module name: strip extension and /index suffix.
  // e.g. "src/tools/history.ts" → "src/tools/history"
  //      "src/tools/index.ts"   → "src/tools"
  const searchPattern = filePath
    .replace(/\.[^.]+$/, '')
    .replace(/\/index$/, '');

  // Skip patterns that are too short / ambiguous (< 8 chars → too many false positives)
  if (searchPattern.length < 8) return 0;

  try {
    const output = execFileSync('git', [
      'grep', '-l', '--fixed-strings', searchPattern, commitHash, '--',
    ], {
      cwd, stdio: 'pipe', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
    }).toString('utf-8');

    let count = 0;
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      // Format: "commitHash:filepath"
      const colonIdx = line.indexOf(':');
      const file = colonIdx >= 0 ? line.slice(colonIdx + 1) : line;
      if (file !== filePath) count++;
    }
    return count;
  } catch {
    // git grep returns exit code 1 when no matches
    return 0;
  }
}

// ════════════════════════════════════════════════════════════════════════
// 1. COUPLING TREND
// ════════════════════════════════════════════════════════════════════════

export function getCouplingTrend(
  store: Store,
  cwd: string,
  filePath: string,
  options: { sinceDays?: number; snapshots?: number } = {},
): CouplingTrendResult | null {
  const { sinceDays = 90, snapshots = 6 } = options;

  if (!isGitRepo(cwd)) return null;

  const file = store.getFile(filePath);
  if (!file) return null;

  // Current coupling from the live graph (single query for both Ca and Ce)
  const currentCoupling = getCurrentCoupling(store, file.id);
  const currentSnapshot: CouplingSnapshot = {
    date: new Date().toISOString().split('T')[0],
    commit: 'HEAD',
    ...currentCoupling,
  };

  // Sample historical commits
  const commits = sampleFileCommits(cwd, filePath, sinceDays, snapshots);
  const historical: CouplingSnapshot[] = [];

  for (const { hash, date } of commits) {
    try {
      const content = getFileAtCommit(cwd, filePath, hash);
      if (!content) continue;

      const ce = countImports(content);
      const ca = countImportersAtCommit(cwd, filePath, hash);
      const total = ca + ce;
      const instability = total === 0 ? 0 : Math.round((ce / total) * 1000) / 1000;

      historical.push({ date, commit: hash.slice(0, 8), ca, ce, instability });
    } catch (e) {
      logger.debug({ file: filePath, commit: hash, error: e }, 'Coupling snapshot failed');
    }
  }

  // Determine trend
  let trend: CouplingTrendResult['trend'] = 'stable';
  let instabilityDelta = 0;
  let couplingDelta = 0;

  if (historical.length > 0) {
    const oldest = historical[historical.length - 1];
    instabilityDelta = Math.round((currentSnapshot.instability - oldest.instability) * 1000) / 1000;
    couplingDelta = (currentSnapshot.ca + currentSnapshot.ce) - (oldest.ca + oldest.ce);

    if (instabilityDelta > 0.1) trend = 'destabilizing';
    else if (instabilityDelta < -0.1) trend = 'stabilizing';
  }

  return {
    file: filePath,
    current: currentSnapshot,
    historical,
    trend,
    instability_delta: instabilityDelta,
    coupling_delta: couplingDelta,
  };
}

/** Get current Ca/Ce from the live indexed graph — single query. */
function getCurrentCoupling(
  store: Store,
  fileId: number,
): { ca: number; ce: number; instability: number } {
  // Use a CTE to resolve file IDs once, then count Ca/Ce in one pass.
  const row = store.db.prepare(`
    WITH file_edges AS (
      SELECT
        CASE WHEN n1.node_type = 'file' THEN n1.ref_id ELSE s1.file_id END AS src_file,
        CASE WHEN n2.node_type = 'file' THEN n2.ref_id ELSE s2.file_id END AS tgt_file
      FROM edges e
      JOIN edge_types et ON e.edge_type_id = et.id
      JOIN nodes n1 ON e.source_node_id = n1.id
      JOIN nodes n2 ON e.target_node_id = n2.id
      LEFT JOIN symbols s1 ON n1.node_type = 'symbol' AND n1.ref_id = s1.id
      LEFT JOIN symbols s2 ON n2.node_type = 'symbol' AND n2.ref_id = s2.id
      WHERE et.name IN ('esm_imports', 'imports', 'py_imports', 'py_reexports')
        AND (
          (CASE WHEN n1.node_type = 'file' THEN n1.ref_id ELSE s1.file_id END) = ?
          OR (CASE WHEN n2.node_type = 'file' THEN n2.ref_id ELSE s2.file_id END) = ?
        )
    )
    SELECT
      COUNT(DISTINCT CASE WHEN src_file = ? AND tgt_file != ? THEN tgt_file END) AS ce,
      COUNT(DISTINCT CASE WHEN tgt_file = ? AND src_file != ? THEN src_file END) AS ca
    FROM file_edges
  `).get(fileId, fileId, fileId, fileId, fileId, fileId) as { ca: number; ce: number } | undefined;

  const ca = row?.ca ?? 0;
  const ce = row?.ce ?? 0;
  const total = ca + ce;
  const instability = total === 0 ? 0 : Math.round((ce / total) * 1000) / 1000;

  return { ca, ce, instability };
}

// ════════════════════════════════════════════════════════════════════════
// 2. SYMBOL COMPLEXITY TREND
// ════════════════════════════════════════════════════════════════════════

/** Strip string literals and comments to avoid false brace/bracket counts. */
function stripStringsForBraces(source: string): string {
  let s = source.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/\/\/.*$/gm, '');
  s = s.replace(/#.*$/gm, '');
  s = s.replace(/`[^`]*`/g, '""');
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  return s;
}

/** Extract a symbol's source from file content using line-based matching. */
export function extractSymbolSource(
  content: string,
  symbolName: string,
  symbolKind: string,
): { source: string; signature: string | null } | null {
  const lines = content.split('\n');

  // Build pattern based on symbol kind
  const patterns: RegExp[] = [];
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (symbolKind === 'function' || symbolKind === 'method') {
    patterns.push(
      new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*[(<]`),
      new RegExp(`(?:public|private|protected)\\s+(?:async\\s+)?(?:static\\s+)?${escaped}\\s*\\(`),
      new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|\\w+)\\s*=>`),
      new RegExp(`\\b${escaped}\\s*:\\s*(?:async\\s+)?function`),
      new RegExp(`\\bdef\\s+${escaped}\\s*\\(`),
      new RegExp(`\\bfunc\\s+${escaped}\\s*\\(`),
    );
  } else if (symbolKind === 'class') {
    patterns.push(
      new RegExp(`(?:export\\s+)?(?:abstract\\s+)?class\\s+${escaped}\\b`),
      new RegExp(`\\bclass\\s+${escaped}\\b`),
    );
  } else {
    patterns.push(new RegExp(`\\b${escaped}\\b`));
  }

  // Find the line where the symbol starts
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]))) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;

  // Find the end by tracking brace depth on string-stripped content
  const cleanLines = stripStringsForBraces(content).split('\n');
  let depth = 0;
  let foundOpenBrace = false;
  let endLine = startLine;

  for (let i = startLine; i < cleanLines.length; i++) {
    for (const ch of cleanLines[i]) {
      if (ch === '{') { depth++; foundOpenBrace = true; }
      else if (ch === '}') { depth--; }
    }
    endLine = i;
    if (foundOpenBrace && depth <= 0) break;

    // Python: use indentation-based end detection
    if (!foundOpenBrace && i > startLine && lines[i].trim() !== '') {
      const startIndent = lines[startLine].match(/^\s*/)?.[0].length ?? 0;
      const currentIndent = lines[i].match(/^\s*/)?.[0].length ?? 0;
      if (currentIndent <= startIndent && i > startLine + 1) {
        endLine = i - 1;
        break;
      }
    }
  }

  // Return source from original (un-stripped) lines
  const source = lines.slice(startLine, endLine + 1).join('\n');
  const signature = lines[startLine].trim();

  return { source, signature };
}

export function getSymbolComplexityTrend(
  store: Store,
  cwd: string,
  symbolId: string,
  options: { sinceDays?: number; snapshots?: number } = {},
): SymbolComplexityTrendResult | null {
  const { sinceDays, snapshots = 6 } = options;

  if (!isGitRepo(cwd)) return null;

  // Look up the symbol in the index
  const sym = store.db.prepare(`
    SELECT s.symbol_id, s.name, s.kind, s.fqn, s.signature,
           s.cyclomatic, s.max_nesting, s.param_count,
           s.line_start, s.line_end,
           f.path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.symbol_id = ?
  `).get(symbolId) as {
    symbol_id: string; name: string; kind: string; fqn: string | null;
    signature: string | null; cyclomatic: number | null; max_nesting: number | null;
    param_count: number | null; line_start: number | null; line_end: number | null;
    path: string;
  } | undefined;

  if (!sym) return null;

  // Current snapshot from indexed data
  const currentLines = (sym.line_end && sym.line_start)
    ? sym.line_end - sym.line_start + 1
    : 0;

  const currentSnapshot: SymbolComplexitySnapshot = {
    date: new Date().toISOString().split('T')[0],
    commit: 'HEAD',
    cyclomatic: sym.cyclomatic ?? 1,
    max_nesting: sym.max_nesting ?? 0,
    param_count: sym.param_count ?? 0,
    lines: currentLines,
  };

  // Historical snapshots
  const commits = sampleFileCommits(cwd, sym.path, sinceDays, snapshots);
  const historical: SymbolComplexitySnapshot[] = [];

  for (const { hash, date } of commits) {
    const content = getFileAtCommit(cwd, sym.path, hash);
    if (!content) continue;

    try {
      const extracted = extractSymbolSource(content, sym.name, sym.kind);
      if (!extracted) continue;

      const cyclomatic = computeCyclomatic(extracted.source);
      const maxNesting = computeMaxNesting(extracted.source);
      const paramCount = computeParamCount(extracted.signature);
      const lineCount = extracted.source.split('\n').length;

      historical.push({
        date,
        commit: hash.slice(0, 8),
        cyclomatic,
        max_nesting: maxNesting,
        param_count: paramCount,
        lines: lineCount,
      });
    } catch (e) {
      logger.debug({ symbol: symbolId, commit: hash, error: e }, 'Symbol complexity snapshot failed');
    }
  }

  // Determine trend
  let trend: SymbolComplexityTrendResult['trend'] = 'stable';
  let cyclomaticDelta = 0;

  if (historical.length > 0) {
    const oldest = historical[historical.length - 1];
    cyclomaticDelta = currentSnapshot.cyclomatic - oldest.cyclomatic;
    if (cyclomaticDelta >= 2) trend = 'degrading';
    else if (cyclomaticDelta <= -2) trend = 'improving';
  }

  return {
    symbol_id: sym.symbol_id,
    name: sym.name,
    file: sym.path,
    current: currentSnapshot,
    historical,
    trend,
    cyclomatic_delta: cyclomaticDelta,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 3. GRAPH SNAPSHOT CAPTURE
// ════════════════════════════════════════════════════════════════════════

/**
 * Capture coupling snapshots for all files — called after full indexing completes.
 * Stores per-file coupling metrics keyed by commit hash so that get_coupling_trend
 * can use stored snapshots for fast historical lookups without re-parsing git history.
 *
 * Performance: single-pass edge scan + batch insert in one transaction.
 * Memory: O(files) for the two counting maps — no full graph materialization.
 */
export function captureGraphSnapshots(store: Store, cwd: string): void {
  let commitHash: string | undefined;
  try {
    commitHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd, stdio: 'pipe', timeout: 5000,
    }).toString('utf-8').trim();
  } catch { /* not a git repo — snapshots still useful without commit hash */ }

  // Dedup: skip if we already captured for this commit
  if (commitHash) {
    const existing = store.db.prepare(
      "SELECT id FROM graph_snapshots WHERE commit_hash = ? AND snapshot_type = 'coupling_summary' LIMIT 1",
    ).get(commitHash) as { id: number } | undefined;
    if (existing) return;
  }

  const allFiles = store.getAllFiles();
  if (allFiles.length === 0) return;

  const allFileIds = allFiles.map((f) => f.id);

  // Chunk getNodeIdsBatch to avoid SQLite variable limit (SQLITE_MAX_VARIABLE_NUMBER)
  const fileNodeMap = new Map<number, number>();
  const CHUNK = 500;
  for (let i = 0; i < allFileIds.length; i += CHUNK) {
    const chunk = allFileIds.slice(i, i + CHUNK);
    for (const [k, v] of store.getNodeIdsBatch('file', chunk)) {
      fileNodeMap.set(k, v);
    }
  }

  // Resolve imports edge type — single query
  const importsTypeRow = store.db.prepare(
    "SELECT id FROM edge_types WHERE name = 'imports'",
  ).get() as { id: number } | undefined;
  if (!importsTypeRow) return;

  // Load ALL import edges in a single query (no N+1)
  const allImportEdges = store.db.prepare(
    'SELECT source_node_id, target_node_id FROM edges WHERE edge_type_id = ?',
  ).all(importsTypeRow.id) as Array<{ source_node_id: number; target_node_id: number }>;

  // Build nodeId→fileId reverse map — O(files) memory
  const nodeToFileId = new Map<number, number>();
  for (const [fileId, nodeId] of fileNodeMap) {
    nodeToFileId.set(nodeId, fileId);
  }

  // Count Ca (afferent) / Ce (efferent) per file — single pass over edges
  const fileCa = new Map<number, number>();
  const fileCe = new Map<number, number>();
  for (const edge of allImportEdges) {
    const srcFileId = nodeToFileId.get(edge.source_node_id);
    const tgtFileId = nodeToFileId.get(edge.target_node_id);
    if (srcFileId != null) fileCe.set(srcFileId, (fileCe.get(srcFileId) ?? 0) + 1);
    if (tgtFileId != null) fileCa.set(tgtFileId, (fileCa.get(tgtFileId) ?? 0) + 1);
  }

  const fileIdToPath = new Map(allFiles.map((f) => [f.id, f.path]));

  // Prepared statement reused for all inserts — no per-row compilation
  const insertStmt = store.db.prepare(
    'INSERT INTO graph_snapshots (commit_hash, snapshot_type, file_path, data) VALUES (?, ?, ?, ?)',
  );

  let count = 0;
  store.db.transaction(() => {
    for (const fileId of allFileIds) {
      const ca = fileCa.get(fileId) ?? 0;
      const ce = fileCe.get(fileId) ?? 0;
      if (ca === 0 && ce === 0) continue; // skip isolated files

      const total = ca + ce;
      const instability = Math.round((ce / total) * 1000) / 1000;
      const filePath = fileIdToPath.get(fileId);
      if (!filePath) continue;

      insertStmt.run(commitHash ?? null, 'coupling', filePath, JSON.stringify({ ca, ce, instability }));
      count++;
    }

    // Summary snapshot for quick trend overview
    if (count > 0) {
      const totalInstability = allFileIds.reduce((sum, fid) => {
        const ca = fileCa.get(fid) ?? 0;
        const ce = fileCe.get(fid) ?? 0;
        const total = ca + ce;
        return sum + (total === 0 ? 0 : ce / total);
      }, 0);

      insertStmt.run(
        commitHash ?? null, 'coupling_summary', null,
        JSON.stringify({
          total_files: allFiles.length,
          files_with_edges: count,
          avg_instability: Math.round((totalInstability / allFiles.length) * 1000) / 1000,
        }),
      );
    }
  })();

  if (count > 0) {
    logger.info({ files: count, commit: commitHash }, 'Coupling snapshots captured');
  }
}
