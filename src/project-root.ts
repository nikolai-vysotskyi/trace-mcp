/**
 * Detect the project root from any subdirectory by walking up
 * looking for well-known marker files/directories.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT_MARKERS = [
  '.git',
  'package.json',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'pyproject.toml',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
];

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
