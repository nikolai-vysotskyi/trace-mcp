/**
 * Zero-index fallback — on-the-fly search when the index is stale or missing.
 *
 * Uses ripgrep (via child_process) for text search, and regex-based symbol
 * extraction for a lightweight "get_outline" without full indexing.
 *
 * Designed as a graceful degradation: same result shape as the indexed tools
 * but with a "fallback: true" flag so the AI knows to suggest reindexing.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';
import { TraceignoreMatcher } from '../../utils/traceignore.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FallbackSearchResult {
  fallback: true;
  reason: string;
  matches: FallbackMatch[];
  total: number;
  hint: string;
}

interface FallbackMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  context?: string;
}

interface FallbackOutlineResult {
  fallback: true;
  reason: string;
  file: string;
  symbols: FallbackSymbol[];
  hint: string;
}

interface FallbackSymbol {
  name: string;
  kind: string;
  line: number;
  signature?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if the index is usable: has files and was updated recently */
export function isIndexStale(store: Store, maxAgeMinutes = 60): { stale: boolean; reason: string } {
  try {
    const row = store.db
      .prepare('SELECT COUNT(*) as cnt, MAX(indexed_at) as latest FROM files')
      .get() as { cnt: number; latest: string | null };

    if (row.cnt === 0) {
      return { stale: true, reason: 'Index is empty — no files have been indexed yet' };
    }

    if (row.latest) {
      const latestDate = new Date(`${row.latest}Z`);
      const ageMinutes = (Date.now() - latestDate.getTime()) / 60_000;
      if (ageMinutes > maxAgeMinutes) {
        return {
          stale: true,
          reason: `Index is ${Math.round(ageMinutes)} minutes old (threshold: ${maxAgeMinutes}m)`,
        };
      }
    }

    return { stale: false, reason: 'Index is fresh' };
  } catch {
    return { stale: true, reason: 'Cannot read index — database may be corrupted or missing' };
  }
}

// ---------------------------------------------------------------------------
// Fallback text search — uses ripgrep if available, else manual scan
// ---------------------------------------------------------------------------

const RG_ARGS_BASE = [
  '--json',
  '--max-count=200',
  '--max-filesize=512K',
  '--glob=!node_modules',
  '--glob=!vendor',
  '--glob=!.git',
  '--glob=!dist',
  '--glob=!build',
  '--glob=!*.min.*',
];

function searchWithRipgrep(
  projectRoot: string,
  query: string,
  opts: { filePattern?: string; caseSensitive?: boolean; maxResults?: number },
): FallbackMatch[] {
  const args = [...RG_ARGS_BASE];
  if (!opts.caseSensitive) args.push('-i');
  if (opts.filePattern) args.push(`--glob=${opts.filePattern}`);
  args.push(query, projectRoot);

  try {
    const output = execFileSync('rg', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
    });

    const matches: FallbackMatch[] = [];
    const limit = opts.maxResults ?? 50;

    for (const line of output.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'match') continue;
        const data = parsed.data;
        const relPath = path.relative(projectRoot, data.path.text);
        matches.push({
          file: relPath,
          line: data.line_number,
          column: data.submatches?.[0]?.start ?? 0,
          text: data.lines.text.trimEnd(),
        });
        if (matches.length >= limit) break;
      } catch {}
    }

    return matches;
  } catch (e: unknown) {
    // rg not found or error — fall through to manual search
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return manualSearch(projectRoot, query, opts);
    }
    // rg exited with 1 = no matches
    return [];
  }
}

/** Manual fallback when ripgrep is not installed */
function manualSearch(
  projectRoot: string,
  query: string,
  opts: { filePattern?: string; maxResults?: number },
): FallbackMatch[] {
  const matches: FallbackMatch[] = [];
  const limit = opts.maxResults ?? 50;
  const regex = new RegExp(escapeRegex(query), 'gi');
  const traceignore = new TraceignoreMatcher(projectRoot);

  function walk(dir: string): void {
    if (matches.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= limit) return;
      if (traceignore.isSkippedDir(entry)) continue;

      const full = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && stat.size < 512 * 1024) {
        const rel = path.relative(projectRoot, full);
        if (traceignore.isIgnored(rel)) continue;
        try {
          const content = readFileSync(full, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            const m = regex.exec(lines[i]);
            if (m) {
              matches.push({
                file: path.relative(projectRoot, full),
                line: i + 1,
                column: m.index + 1,
                text: lines[i].trimEnd(),
              });
              if (matches.length >= limit) return;
            }
          }
        } catch {}
      }
    }
  }

  walk(projectRoot);
  return matches;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Fallback outline — regex-based symbol extraction for a single file
// ---------------------------------------------------------------------------

interface SymbolPattern {
  kind: string;
  pattern: RegExp;
}

const SYMBOL_PATTERNS: Record<string, SymbolPattern[]> = {
  typescript: [
    { kind: 'class', pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm },
    { kind: 'interface', pattern: /^\s*(?:export\s+)?interface\s+(\w+)/gm },
    { kind: 'function', pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm },
    { kind: 'type', pattern: /^\s*(?:export\s+)?type\s+(\w+)\s*=/gm },
    { kind: 'variable', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/gm },
    { kind: 'enum', pattern: /^\s*(?:export\s+)?enum\s+(\w+)/gm },
  ],
  javascript: [
    { kind: 'class', pattern: /^\s*(?:export\s+)?class\s+(\w+)/gm },
    { kind: 'function', pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm },
    { kind: 'variable', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/gm },
  ],
  python: [
    { kind: 'class', pattern: /^\s*class\s+(\w+)/gm },
    { kind: 'function', pattern: /^\s*(?:async\s+)?def\s+(\w+)/gm },
  ],
  php: [
    { kind: 'class', pattern: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/gm },
    { kind: 'interface', pattern: /^\s*interface\s+(\w+)/gm },
    { kind: 'function', pattern: /^\s*(?:public|protected|private|static|\s)+function\s+(\w+)/gm },
  ],
  go: [
    { kind: 'function', pattern: /^func\s+(?:\(.*?\)\s+)?(\w+)/gm },
    { kind: 'type', pattern: /^type\s+(\w+)\s+/gm },
  ],
  rust: [
    { kind: 'function', pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm },
    { kind: 'type', pattern: /^\s*(?:pub\s+)?struct\s+(\w+)/gm },
    { kind: 'enum', pattern: /^\s*(?:pub\s+)?enum\s+(\w+)/gm },
    { kind: 'trait', pattern: /^\s*(?:pub\s+)?trait\s+(\w+)/gm },
  ],
  java: [
    {
      kind: 'class',
      pattern: /^\s*(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/gm,
    },
    { kind: 'interface', pattern: /^\s*(?:public\s+)?interface\s+(\w+)/gm },
    {
      kind: 'method',
      pattern: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/gm,
    },
  ],
  ruby: [
    { kind: 'class', pattern: /^\s*class\s+(\w+)/gm },
    { kind: 'method', pattern: /^\s*def\s+(\w+)/gm },
  ],
};

// Alias groups
SYMBOL_PATTERNS.tsx = SYMBOL_PATTERNS.typescript;
SYMBOL_PATTERNS.jsx = SYMBOL_PATTERNS.javascript;
SYMBOL_PATTERNS.kotlin = SYMBOL_PATTERNS.java;

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.php': 'php',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.rb': 'ruby',
  };
  return map[ext] ?? 'typescript';
}

function extractSymbolsFromContent(content: string, language: string): FallbackSymbol[] {
  const patterns = SYMBOL_PATTERNS[language];
  if (!patterns) return [];

  const lines = content.split('\n');
  const symbols: FallbackSymbol[] = [];
  const seen = new Set<string>();

  for (const { kind, pattern } of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const name = match[1];
      if (!name || seen.has(`${kind}:${name}`)) continue;
      seen.add(`${kind}:${name}`);

      // Find line number
      let lineNum = 1;
      for (let i = 0; i < match.index && i < content.length; i++) {
        if (content[i] === '\n') lineNum++;
      }

      // Extract the matched line as signature
      const signature = lines[lineNum - 1]?.trim();

      symbols.push({ name, kind, line: lineNum, signature });
    }
  }

  // Sort by line number
  symbols.sort((a, b) => a.line - b.line);
  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fallback search — searches files directly when the index is unavailable.
 */
export function fallbackSearch(
  projectRoot: string,
  query: string,
  opts: {
    filePattern?: string;
    caseSensitive?: boolean;
    maxResults?: number;
  } = {},
): FallbackSearchResult {
  const matches = searchWithRipgrep(projectRoot, query, opts);

  return {
    fallback: true,
    reason: 'Using on-the-fly search — index unavailable or stale',
    matches,
    total: matches.length,
    hint: 'Run `reindex` to enable full symbol-aware search with graph traversal.',
  };
}

/**
 * Fallback outline — extracts symbols from a single file without indexing.
 */
export function fallbackOutline(projectRoot: string, filePath: string): FallbackOutlineResult {
  const absPath = path.resolve(projectRoot, filePath);
  const content = readFileSync(absPath, 'utf-8');
  const language = detectLanguage(filePath);
  const symbols = extractSymbolsFromContent(content, language);

  return {
    fallback: true,
    reason: 'Using regex-based extraction — index unavailable or stale',
    file: filePath,
    symbols,
    hint: 'Run `reindex` for full extraction with framework awareness and dependency graph.',
  };
}
