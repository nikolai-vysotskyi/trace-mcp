/**
 * Git blame-based code ownership.
 *
 * Per-file ownership: who contributed most lines (git shortlog).
 * Per-symbol ownership: git blame on the symbol's line range.
 */

import { execFileSync } from 'node:child_process';
import type { Store } from '../../db/store.js';
import { isGitRepo } from './git-analysis.js';
import { logger } from '../../logger.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface FileOwnership {
  file: string;
  owners: { author: string; commits: number; percentage: number }[];
  total_commits: number;
}

interface SymbolOwnership {
  symbol_id: string;
  name: string;
  file: string;
  lines: { start: number; end: number };
  owners: { author: string; lines: number; percentage: number }[];
  total_lines: number;
}

// ════════════════════════════════════════════════════════════════════════
// FILE OWNERSHIP (git shortlog)
// ════════════════════════════════════════════════════════════════════════

export function getFileOwnership(cwd: string, filePaths: string[]): FileOwnership[] {
  if (!isGitRepo(cwd)) return [];

  const results: FileOwnership[] = [];

  for (const filePath of filePaths) {
    try {
      const output = execFileSync('git', ['shortlog', '-sn', '--no-merges', '--', filePath], {
        cwd,
        stdio: 'pipe',
        timeout: 10_000,
      }).toString('utf-8');

      const owners: { author: string; commits: number }[] = [];
      let total = 0;

      for (const line of output.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (match) {
          const commits = parseInt(match[1], 10);
          owners.push({ author: match[2].trim(), commits });
          total += commits;
        }
      }

      if (total > 0) {
        results.push({
          file: filePath,
          owners: owners.map((o) => ({
            ...o,
            percentage: Math.round((o.commits / total) * 100),
          })),
          total_commits: total,
        });
      }
    } catch (e) {
      logger.warn({ file: filePath, error: e }, 'git shortlog failed');
    }
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════
// SYMBOL OWNERSHIP (git blame -L)
// ════════════════════════════════════════════════════════════════════════

export function getSymbolOwnership(
  store: Store,
  cwd: string,
  symbolId: string,
): SymbolOwnership | null {
  if (!isGitRepo(cwd)) return null;

  const symbol = store.getSymbolBySymbolId(symbolId);
  if (!symbol?.line_start || !symbol.line_end) return null;

  const file = store.getFileById(symbol.file_id);
  if (!file) return null;

  try {
    const output = execFileSync(
      'git',
      ['blame', '--porcelain', `-L${symbol.line_start},${symbol.line_end}`, '--', file.path],
      {
        cwd,
        stdio: 'pipe',
        timeout: 10_000,
      },
    ).toString('utf-8');

    // Parse porcelain blame: count lines per author
    const authorLines = new Map<string, number>();
    let totalLines = 0;
    let currentAuthor: string | null = null;

    for (const line of output.split('\n')) {
      if (line.startsWith('author ')) {
        currentAuthor = line.slice('author '.length);
      } else if (line.startsWith('\t') && currentAuthor) {
        // This is an actual content line
        authorLines.set(currentAuthor, (authorLines.get(currentAuthor) ?? 0) + 1);
        totalLines++;
        currentAuthor = null;
      }
    }

    if (totalLines === 0) return null;

    const owners = [...authorLines.entries()]
      .map(([author, lines]) => ({
        author,
        lines,
        percentage: Math.round((lines / totalLines) * 100),
      }))
      .sort((a, b) => b.lines - a.lines);

    return {
      symbol_id: symbolId,
      name: symbol.name,
      file: file.path,
      lines: { start: symbol.line_start, end: symbol.line_end },
      owners,
      total_lines: totalLines,
    };
  } catch (e) {
    logger.warn({ symbolId, error: e }, 'git blame failed');
    return null;
  }
}
