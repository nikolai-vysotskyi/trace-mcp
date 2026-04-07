/**
 * Detect the project root from any subdirectory by walking up
 * looking for well-known marker files/directories.
 */

import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.svn', '__pycache__', '.tox']);

/**
 * Scan immediate subdirectories of `parentDir` for project root markers.
 * Returns sorted absolute paths of discovered child project roots.
 * Only scans depth-1 (no recursion).
 */
export function discoverChildProjects(parentDir: string): string[] {
  const absParent = path.resolve(parentDir);
  if (!fs.existsSync(absParent)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absParent, { withFileTypes: true });
  } catch {
    return [];
  }

  const children: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const childDir = path.join(absParent, entry.name);
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(childDir, marker))) {
        children.push(childDir);
        break;
      }
    }
  }

  return children.sort();
}

/**
 * Walk up from `from` (default: cwd) and return the first directory
 * that contains any root marker. Throws if none found.
 */
export function findProjectRoot(from?: string): string {
  let dir = path.resolve(from ?? process.cwd());

  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) {
        return dir;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find project root from ${from ?? process.cwd()}. ` +
        `Looked for: ${ROOT_MARKERS.join(', ')}`,
      );
    }
    dir = parent;
  }
}
