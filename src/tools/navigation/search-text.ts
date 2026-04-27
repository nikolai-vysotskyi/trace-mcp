import fs from 'node:fs';
import path from 'node:path';
import { ok, err, type TraceMcpResult } from '../../errors.js';
import { validationError } from '../../errors.js';
import type { Store, FileRow } from '../../db/store.js';
import { validatePath } from '../../utils/security.js';
// @ts-expect-error — picomatch has no bundled types (transitive dep of fast-glob)
import picomatch from 'picomatch';

interface SearchTextMatch {
  file: string;
  language: string | null;
  line: number;
  column: number;
  match: string;
  context: string[];
}

interface SearchTextResult {
  matches: SearchTextMatch[];
  total_matches: number;
  files_searched: number;
  files_matched: number;
  truncated: boolean;
}

interface SearchTextOptions {
  query: string;
  isRegex?: boolean;
  filePattern?: string;
  language?: string;
  maxResults?: number;
  contextLines?: number;
  caseSensitive?: boolean;
}

/**
 * Full-text search across indexed files. Supports regex and glob file patterns.
 *
 * Queries the DB for the file list (avoiding full filesystem scan),
 * then streams files one at a time to keep memory bounded.
 */
export function searchText(
  store: Store,
  projectRoot: string,
  opts: SearchTextOptions,
): TraceMcpResult<SearchTextResult> {
  const {
    query,
    isRegex = false,
    filePattern,
    language,
    maxResults = 50,
    contextLines = 0,
    caseSensitive = false,
  } = opts;

  if (!query || query.length === 0) {
    return err(validationError('query is required'));
  }
  if (query.length > 1000) {
    return err(validationError('query too long (max 1000 chars)'));
  }

  // Build regex from query
  let regex: RegExp;
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    regex = isRegex ? new RegExp(query, flags) : new RegExp(escapeRegex(query), flags);
  } catch (e) {
    return err(validationError(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Get file list from DB (single query, no N+1)
  let files: FileRow[];
  if (language) {
    files = store.db
      .prepare('SELECT * FROM files WHERE language = ? AND status != ?')
      .all(language, 'error') as FileRow[];
  } else {
    files = store.db.prepare('SELECT * FROM files WHERE status != ?').all('error') as FileRow[];
  }

  // Apply glob filter in-memory (cheaper than SQL LIKE for globs)
  if (filePattern) {
    const isMatch = picomatch(filePattern, { dot: true });
    files = files.filter((f) => isMatch(f.path));
  }

  const matches: SearchTextMatch[] = [];
  let totalMatches = 0;
  let filesMatched = 0;
  let truncated = false;

  for (const file of files) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }

    const absPath = path.resolve(projectRoot, file.path);

    // Security: ensure path stays within project root
    const pathCheck = validatePath(file.path, projectRoot);
    if (pathCheck.isErr()) continue;

    let content: string;
    try {
      // Skip large files (>1MB) to prevent memory spikes
      const stat = fs.statSync(absPath);
      if (stat.size > 1_048_576) continue;
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue; // File may have been deleted since indexing
    }

    const lines = content.split('\n');
    let fileHasMatch = false;

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }

      // Reset regex lastIndex for each line (global flag)
      regex.lastIndex = 0;
      const m = regex.exec(lines[i]);
      if (!m) continue;

      totalMatches++;
      fileHasMatch = true;

      // Build context window
      const ctxStart = Math.max(0, i - contextLines);
      const ctxEnd = Math.min(lines.length - 1, i + contextLines);
      const context: string[] = [];
      for (let ci = ctxStart; ci <= ctxEnd; ci++) {
        const prefix = ci === i ? '>' : ' ';
        context.push(`${prefix} ${ci + 1}: ${lines[ci]}`);
      }

      matches.push({
        file: file.path,
        language: file.language,
        line: i + 1,
        column: m.index + 1,
        match: m[0],
        context,
      });
    }

    if (fileHasMatch) filesMatched++;
  }

  return ok({
    matches,
    total_matches: totalMatches,
    files_searched: files.length,
    files_matched: filesMatched,
    truncated,
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
