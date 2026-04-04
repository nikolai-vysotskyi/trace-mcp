/**
 * Lightweight .gitignore parser.
 * Reads .gitignore files and provides a matcher to check if a relative path
 * is gitignored. Used to flag files during indexing — gitignored files are
 * indexed for graph metadata but their source content is not served to AI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

interface GitignoreRule {
  pattern: RegExp;
  negated: boolean;
}

/**
 * Convert a single .gitignore pattern line to a RegExp.
 * Supports: *, **, ?, leading /, trailing /, negation (!), and comments (#).
 */
function parsePattern(line: string): GitignoreRule | null {
  let trimmed = line.trim();

  // Skip empty lines and comments
  if (!trimmed || trimmed.startsWith('#')) return null;

  const negated = trimmed.startsWith('!');
  if (negated) trimmed = trimmed.slice(1);

  // Remove trailing spaces (unless escaped)
  trimmed = trimmed.replace(/(?<!\\)\s+$/, '');
  if (!trimmed) return null;

  // A trailing slash means "directory only" — for our purposes (files), match as prefix
  const dirOnly = trimmed.endsWith('/');
  if (dirOnly) trimmed = trimmed.slice(0, -1);

  // Build regex
  let regex = '';
  // If the pattern contains a slash (not trailing), it's anchored to the root
  const anchored = trimmed.includes('/');
  const parts = trimmed.split('');

  let i = 0;
  while (i < parts.length) {
    const ch = parts[i];
    if (ch === '*') {
      if (parts[i + 1] === '*') {
        if (parts[i + 2] === '/') {
          // **/ — match zero or more directories
          regex += '(?:.+/)?';
          i += 3;
          continue;
        } else {
          // ** at end — match everything
          regex += '.*';
          i += 2;
          continue;
        }
      }
      // single * — match anything except /
      regex += '[^/]*';
    } else if (ch === '?') {
      regex += '[^/]';
    } else if (ch === '/') {
      regex += '/';
    } else {
      // Escape regex special chars
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    i++;
  }

  // If pattern has no slash, it can match at any depth
  if (!anchored) {
    regex = '(?:^|.*/)' + regex;
  } else {
    // Remove leading slash if present (already anchored)
    regex = regex.replace(/^\//, '');
    regex = '^' + regex;
  }

  // Match the path itself or anything under it (directory semantics)
  regex += '(?:$|/.*)';

  try {
    return { pattern: new RegExp(regex), negated };
  } catch {
    logger.warn({ line }, 'Invalid .gitignore pattern, skipping');
    return null;
  }
}

export class GitignoreMatcher {
  private rules: GitignoreRule[] = [];

  constructor(rootPath: string) {
    this.loadGitignore(rootPath);
  }

  private loadGitignore(rootPath: string): void {
    const gitignorePath = path.join(rootPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return;

    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const rule = parsePattern(line);
        if (rule) this.rules.push(rule);
      }

      logger.debug({ rules: this.rules.length }, 'Loaded .gitignore rules');
    } catch {
      logger.warn({ path: gitignorePath }, 'Failed to read .gitignore');
    }
  }

  /** Check if a relative path (forward slashes) matches .gitignore rules. */
  isIgnored(relPath: string): boolean {
    if (this.rules.length === 0) return false;

    // Normalize to forward slashes
    const normalized = relPath.replace(/\\/g, '/');

    let ignored = false;
    for (const rule of this.rules) {
      if (rule.pattern.test(normalized)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }
}
