/**
 * Lightweight .gitignore parser.
 * Reads .gitignore files and provides a matcher to check if a relative path
 * is gitignored. Used to flag files during indexing — gitignored files are
 * indexed for graph metadata but their source content is not served to AI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { parseIgnorePattern, type IgnoreRule } from './ignore-patterns.js';

export class GitignoreMatcher {
  private rules: IgnoreRule[] = [];

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
        const rule = parseIgnorePattern(line);
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
