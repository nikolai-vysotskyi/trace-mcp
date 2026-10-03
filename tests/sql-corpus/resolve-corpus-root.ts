import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * BrightChamps benchmark SQL under data-analytics-python (sibling repo).
 * Override with TRACE_SQL_CORPUS_ROOT when layouts differ.
 */
export function resolveBrightchampsCorpusRoot(): string | null {
  const env = process.env.TRACE_SQL_CORPUS_ROOT;
  if (env) {
    const resolved = path.resolve(env);
    return fs.existsSync(resolved) ? resolved : null;
  }
  const sibling = path.join(REPO_ROOT, '../data-analytics-python/scripts/queries');
  return fs.existsSync(sibling) ? sibling : null;
}

export function corpusFile(relPath: string): string | null {
  const root = resolveBrightchampsCorpusRoot();
  if (!root) return null;
  const full = path.join(root, relPath);
  return fs.existsSync(full) ? full : null;
}
