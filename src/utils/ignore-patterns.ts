/**
 * Shared gitignore-style pattern parser.
 * Used by both GitignoreMatcher (.gitignore) and TraceignoreMatcher (.traceignore).
 */
import { logger } from '../logger.js';

export interface IgnoreRule {
  pattern: RegExp;
  negated: boolean;
}

/**
 * Convert a single gitignore-style pattern line to a RegExp.
 * Supports: *, **, ?, leading /, trailing /, negation (!), and comments (#).
 */
export function parseIgnorePattern(line: string): IgnoreRule | null {
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
        }
        // ** at end — match everything
        regex += '.*';
        i += 2;
        continue;
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
    regex = `(?:^|.*/)${regex}`;
  } else {
    // Remove leading slash if present (already anchored)
    regex = regex.replace(/^\//, '');
    regex = `^${regex}`;
  }

  // Match the path itself or anything under it (directory semantics)
  regex += '(?:$|/.*)';

  try {
    return { pattern: new RegExp(regex), negated };
  } catch {
    logger.warn({ line }, 'Invalid ignore pattern, skipping');
    return null;
  }
}
