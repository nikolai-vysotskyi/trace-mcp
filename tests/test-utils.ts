/**
 * Shared test utilities — reduce boilerplate across test files.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initializeDatabase } from '../src/db/schema.js';
import { Store } from '../src/db/store.js';

/**
 * Create an in-memory Store (initializeDatabase + new Store).
 */
export function createTestStore(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

/**
 * Create a temp directory with an auto-generated prefix.
 * Returns the absolute path. Caller is responsible for cleanup
 * (or use `withTmpDir`).
 */
export function createTmpDir(prefix = 'trace-mcp-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Create a temp directory, populate it with files, return the path.
 * Each key in `files` is a relative path; the value is the file content.
 */
export function createTmpFixture(
  files: Record<string, string>,
  prefix = 'trace-mcp-fix-',
): string {
  const tmpDir = createTmpDir(prefix);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
  }
  return tmpDir;
}

/**
 * Remove a temp directory (safe to call even if it doesn't exist).
 */
export function removeTmpDir(dirPath: string): void {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * Write a file inside a directory, creating intermediate dirs as needed.
 */
export function writeFixtureFile(
  baseDir: string,
  relPath: string,
  content: string,
): void {
  const absPath = path.join(baseDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
}
