/**
 * Changed Symbols — maps git diff to affected symbols.
 * Parses `git diff` unified output, maps changed line ranges to indexed symbols.
 *
 * Performance: Single `git diff` call, single batch SQL for symbol lookup per file.
 */
import { execSync } from 'node:child_process';
import type { Store, SymbolRow, FileRow } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { logger } from '../logger.js';

export type ChangeKind = 'added' | 'modified' | 'removed' | 'renamed';

export interface ChangedSymbolEntry {
  symbolId: string;
  name: string;
  kind: string;
  fqn: string | null;
  file: string;
  changeKind: ChangeKind;
  linesChanged: number;
  blastRadius?: number;
}

export interface ChangedSymbolsResult {
  since: string;
  until: string;
  changedFiles: number;
  changedSymbols: ChangedSymbolEntry[];
  summary: { added: number; modified: number; removed: number; renamed: number };
}

export interface ChangedSymbolsOptions {
  since: string;
  until?: string;
  includeBlastRadius?: boolean;
  maxBlastDepth?: number;
}

interface DiffHunk {
  file: string;
  newStart: number;
  newCount: number;
  filter: string; // A, M, D, R
}

/**
 * Parse git diff to find changed symbols.
 * Single git diff call → parse hunks → batch SQL per file.
 */
export function getChangedSymbols(
  store: Store,
  rootPath: string,
  opts: ChangedSymbolsOptions,
): TraceMcpResult<ChangedSymbolsResult> {
  const until = opts.until ?? 'HEAD';

  // Get list of changed files with their status
  let diffNameStatus: string;
  try {
    diffNameStatus = execSync(
      `git diff --name-status --diff-filter=AMRD ${opts.since}..${until}`,
      { cwd: rootPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 15_000 },
    ).trim();
  } catch (e) {
    return err({ code: 'VALIDATION_ERROR', message: `git diff failed: ${e instanceof Error ? e.message : String(e)}` });
  }

  if (!diffNameStatus) {
    return ok({
      since: opts.since,
      until,
      changedFiles: 0,
      changedSymbols: [],
      summary: { added: 0, modified: 0, removed: 0, renamed: 0 },
    });
  }

  // Parse name-status output: "M\tfile.ts" or "R100\told.ts\tnew.ts"
  const fileStatuses = new Map<string, string>();
  for (const line of diffNameStatus.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0].charAt(0); // A, M, D, R
    const filePath = status === 'R' ? parts[2] : parts[1]; // renamed: use new name
    fileStatuses.set(filePath, status);
  }

  // Get unified diff with line numbers for modified files
  let diffUnified = '';
  try {
    diffUnified = execSync(
      `git diff --unified=0 ${opts.since}..${until}`,
      { cwd: rootPath, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, timeout: 30_000 },
    );
  } catch {
    // Non-fatal — we can still report file-level changes
  }

  // Parse hunks from unified diff
  const hunks: DiffHunk[] = [];
  let currentFile = '';
  for (const line of diffUnified.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
    } else if (line.startsWith('@@ ') && currentFile) {
      // Parse @@ -old,count +new,count @@
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        hunks.push({
          file: currentFile,
          newStart: parseInt(match[1], 10),
          newCount: parseInt(match[2] ?? '1', 10),
          filter: fileStatuses.get(currentFile) ?? 'M',
        });
      }
    }
  }

  // Map hunks to symbols — batch per file (no N+1)
  const changedSymbols: ChangedSymbolEntry[] = [];
  const seenSymbols = new Set<string>();

  // Group hunks by file
  const hunksByFile = new Map<string, DiffHunk[]>();
  for (const hunk of hunks) {
    const arr = hunksByFile.get(hunk.file) ?? [];
    arr.push(hunk);
    hunksByFile.set(hunk.file, arr);
  }

  // Process each file — single SQL per file for symbols in range
  for (const [filePath, fileHunks] of hunksByFile) {
    const file = store.getFile(filePath);
    if (!file) continue;

    // Batch-fetch all symbols for this file
    const symbols = store.getSymbolsByFile(file.id);
    if (symbols.length === 0) continue;

    for (const hunk of fileHunks) {
      const hunkEnd = hunk.newStart + hunk.newCount;
      const changeKind = statusToChangeKind(hunk.filter);

      // Find symbols whose line range overlaps with the hunk
      for (const sym of symbols) {
        if (seenSymbols.has(sym.symbol_id)) continue;
        const symStart = sym.line_start ?? 0;
        const symEnd = sym.line_end ?? symStart;

        if (symStart <= hunkEnd && symEnd >= hunk.newStart) {
          seenSymbols.add(sym.symbol_id);
          changedSymbols.push({
            symbolId: sym.symbol_id,
            name: sym.name,
            kind: sym.kind,
            fqn: sym.fqn,
            file: filePath,
            changeKind,
            linesChanged: hunk.newCount,
          });
        }
      }
    }
  }

  // Handle added/deleted files — all their symbols are added/removed
  for (const [filePath, status] of fileStatuses) {
    if (status === 'A' || status === 'D') {
      const file = store.getFile(filePath);
      if (!file) continue;
      const symbols = store.getSymbolsByFile(file.id);
      const changeKind = status === 'A' ? 'added' : 'removed';
      for (const sym of symbols) {
        if (seenSymbols.has(sym.symbol_id)) continue;
        seenSymbols.add(sym.symbol_id);
        changedSymbols.push({
          symbolId: sym.symbol_id,
          name: sym.name,
          kind: sym.kind,
          fqn: sym.fqn,
          file: filePath,
          changeKind,
          linesChanged: (sym.line_end ?? 0) - (sym.line_start ?? 0),
        });
      }
    }
  }

  // Optional: compute blast radius for each changed symbol
  if (opts.includeBlastRadius) {
    const depth = opts.maxBlastDepth ?? 3;
    for (const cs of changedSymbols) {
      const sym = store.getSymbolBySymbolId(cs.symbolId);
      if (!sym) continue;
      const nodeId = store.getNodeId('symbol', sym.id);
      if (!nodeId) continue;
      const edges = store.traverseEdges(nodeId, 'incoming', depth);
      cs.blastRadius = edges.length;
    }
  }

  const summary = {
    added: changedSymbols.filter((s) => s.changeKind === 'added').length,
    modified: changedSymbols.filter((s) => s.changeKind === 'modified').length,
    removed: changedSymbols.filter((s) => s.changeKind === 'removed').length,
    renamed: changedSymbols.filter((s) => s.changeKind === 'renamed').length,
  };

  return ok({
    since: opts.since,
    until,
    changedFiles: fileStatuses.size,
    changedSymbols,
    summary,
  });
}

function statusToChangeKind(status: string): ChangeKind {
  switch (status) {
    case 'A': return 'added';
    case 'D': return 'removed';
    case 'R': return 'renamed';
    default: return 'modified';
  }
}

// --- Branch Comparison (sugar over getChangedSymbols) ---

export interface BranchComparisonOptions {
  branch: string;
  base?: string;
  includeBlastRadius?: boolean;
  maxBlastDepth?: number;
  groupBy?: 'file' | 'category' | 'risk';
}

export interface BranchComparisonResult extends ChangedSymbolsResult {
  branch: string;
  base: string;
  mergeBase: string;
  commitCount: number;
  grouped: Record<string, ChangedSymbolEntry[]>;
  riskAssessment: { level: string; symbol: string; dependents: number }[];
}

/**
 * Compare two branches at the symbol level.
 * Resolves merge-base automatically, then delegates to getChangedSymbols.
 */
export function compareBranches(
  store: Store,
  rootPath: string,
  opts: BranchComparisonOptions,
): TraceMcpResult<BranchComparisonResult> {
  const base = opts.base ?? 'main';
  const branch = opts.branch;

  // Find merge base between the two branches
  let mergeBase: string;
  try {
    mergeBase = execSync(
      `git merge-base ${base} ${branch}`,
      { cwd: rootPath, encoding: 'utf-8', timeout: 10_000 },
    ).trim();
  } catch (e) {
    // Try 'master' if 'main' doesn't exist
    if (base === 'main') {
      try {
        mergeBase = execSync(
          `git merge-base master ${branch}`,
          { cwd: rootPath, encoding: 'utf-8', timeout: 10_000 },
        ).trim();
      } catch {
        return err({ code: 'VALIDATION_ERROR', message: `Cannot find merge base between ${base} and ${branch}: ${e instanceof Error ? e.message : String(e)}` });
      }
    } else {
      return err({ code: 'VALIDATION_ERROR', message: `Cannot find merge base between ${base} and ${branch}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // Count commits in range
  let commitCount = 0;
  try {
    const countOutput = execSync(
      `git rev-list --count ${mergeBase}..${branch}`,
      { cwd: rootPath, encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    commitCount = parseInt(countOutput, 10) || 0;
  } catch {
    // Non-fatal
  }

  // Delegate to getChangedSymbols
  const result = getChangedSymbols(store, rootPath, {
    since: mergeBase,
    until: branch,
    includeBlastRadius: opts.includeBlastRadius ?? true,
    maxBlastDepth: opts.maxBlastDepth ?? 3,
  });

  if (result.isErr()) return result as any;

  const data = result.value;
  const groupBy = opts.groupBy ?? 'category';

  // Group symbols
  const grouped: Record<string, ChangedSymbolEntry[]> = {};
  for (const sym of data.changedSymbols) {
    let key: string;
    switch (groupBy) {
      case 'file':
        key = sym.file;
        break;
      case 'risk': {
        const br = sym.blastRadius ?? 0;
        key = br >= 10 ? 'high' : br >= 3 ? 'medium' : 'low';
        break;
      }
      case 'category':
      default:
        key = sym.changeKind;
        break;
    }
    (grouped[key] ??= []).push(sym);
  }

  // Build risk assessment — symbols sorted by blast radius
  const riskAssessment = data.changedSymbols
    .filter((s) => s.blastRadius != null && s.blastRadius > 0)
    .sort((a, b) => (b.blastRadius ?? 0) - (a.blastRadius ?? 0))
    .slice(0, 20)
    .map((s) => ({
      level: (s.blastRadius ?? 0) >= 10 ? 'high' : (s.blastRadius ?? 0) >= 3 ? 'medium' : 'low',
      symbol: `${s.name} (${s.kind})`,
      dependents: s.blastRadius ?? 0,
    }));

  return ok({
    ...data,
    branch,
    base,
    mergeBase,
    commitCount,
    grouped,
    riskAssessment,
  });
}
