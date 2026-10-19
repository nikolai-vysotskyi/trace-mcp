import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC_FIXTURES_ROOT = path.join(REPO_ROOT, 'tests/sql-corpus/fixtures');

/** Shipped SQL fixtures for vitest (no external corpus required). */
export function resolvePublicFixtureRoot(): string {
  return PUBLIC_FIXTURES_ROOT;
}

export function fixtureFile(relPath: string): string | null {
  const full = path.join(PUBLIC_FIXTURES_ROOT, relPath);
  return fs.existsSync(full) ? full : null;
}

/**
 * Optional external corpus for local spike / diff scripts (`TRACE_SQL_CORPUS_ROOT`).
 * Not used by public CI tests.
 */
export function resolveExternalCorpusRoot(): string | null {
  const env = process.env.TRACE_SQL_CORPUS_ROOT;
  if (!env) return null;
  const resolved = path.resolve(env);
  return fs.existsSync(resolved) ? resolved : null;
}
