/**
 * .traceignore support — project-level ignore rules for trace-mcp indexing.
 *
 * Reads `.traceignore` from the project root (gitignore syntax) and merges
 * with `ignore.patterns` from config. Files matching these rules are fully
 * skipped during indexing (not indexed at all, unlike .gitignore which only
 * hides content).
 *
 * Priority: .traceignore patterns + config ignore.patterns are combined.
 * Config `ignore.directories` provides a simple directory-name blocklist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { parseIgnorePattern, type IgnoreRule } from './ignore-patterns.js';

export interface TraceignoreConfig {
  /** Extra glob patterns from config (gitignore syntax) */
  patterns?: string[];
  /** Directory names to skip (e.g. ['proto', 'generated']) */
  directories?: string[];
}

export class TraceignoreMatcher {
  private rules: IgnoreRule[] = [];
  private skipDirs: Set<string>;

  /** Built-in directories that are always skipped. */
  static readonly DEFAULT_SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
    '.venv', 'vendor', '.trace-mcp', 'coverage', '.turbo',
  ]);

  constructor(rootPath: string, config: TraceignoreConfig = {}) {
    // Start with default skip dirs, add config extras
    this.skipDirs = new Set(TraceignoreMatcher.DEFAULT_SKIP_DIRS);
    if (config.directories) {
      for (const dir of config.directories) {
        this.skipDirs.add(dir);
      }
    }

    // Load .traceignore file
    this.loadTraceignore(rootPath);

    // Add config patterns
    if (config.patterns) {
      for (const line of config.patterns) {
        const rule = parseIgnorePattern(line);
        if (rule) this.rules.push(rule);
      }
    }
  }

  private loadTraceignore(rootPath: string): void {
    const traceignorePath = path.join(rootPath, '.traceignore');
    if (!fs.existsSync(traceignorePath)) return;

    try {
      const content = fs.readFileSync(traceignorePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const rule = parseIgnorePattern(line);
        if (rule) this.rules.push(rule);
      }

      logger.debug({ rules: this.rules.length }, 'Loaded .traceignore rules');
    } catch {
      logger.warn({ path: traceignorePath }, 'Failed to read .traceignore');
    }
  }

  /** Check if a directory name should be skipped entirely. */
  isSkippedDir(dirName: string): boolean {
    return this.skipDirs.has(dirName);
  }

  /** Check if a relative path matches .traceignore rules or skip dirs. */
  isIgnored(relPath: string): boolean {
    const normalized = relPath.replace(/\\/g, '/');

    // Check if any path segment is a skipped directory
    const segments = normalized.split('/');
    for (const seg of segments) {
      if (this.skipDirs.has(seg)) return true;
    }

    // Check pattern rules
    if (this.rules.length === 0) return false;

    let ignored = false;
    for (const rule of this.rules) {
      if (rule.pattern.test(normalized)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }

  /** Get skip dirs as a Set (for consumers that need the raw set). */
  getSkipDirs(): ReadonlySet<string> {
    return this.skipDirs;
  }

  /** Convert rules to fast-glob ignore patterns for collectFiles. */
  toFastGlobIgnore(): string[] {
    const patterns: string[] = [];
    for (const dir of this.skipDirs) {
      patterns.push(`**/${dir}/**`);
    }
    // Note: .traceignore pattern rules are checked post-collection via isIgnored()
    // because fast-glob uses different syntax than gitignore patterns.
    return patterns;
  }
}
