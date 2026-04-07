/**
 * Detect the project root from any subdirectory by walking up
 * looking for well-known marker files/directories.
 */

import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.svn', '__pycache__', '.tox']);

const ROOT_MARKERS = [
  // VCS
  '.git',
  // JavaScript / TypeScript
  'package.json',
  // Go
  'go.mod',
  // Rust
  'Cargo.toml',
  // PHP
  'composer.json',
  // Python
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  // Ruby
  'Gemfile',
  // Java / Kotlin (Maven)
  'pom.xml',
  // Java / Kotlin (Gradle)
  'build.gradle',
  'build.gradle.kts',
  // C / C++ / Fortran
  'CMakeLists.txt',
  'meson.build',
  // C# / F#
  'Directory.Build.props',
  // Dart / Flutter
  'pubspec.yaml',
  // Elixir
  'mix.exs',
  // Erlang
  'rebar.config',
  // Scala
  'build.sbt',
  // Swift
  'Package.swift',
  // Haskell
  'stack.yaml',
  'cabal.project',
  // OCaml
  'dune-project',
  // Clojure
  'deps.edn',
  // Julia
  'Project.toml',
  // Zig
  'build.zig',
  // Gleam
  'gleam.toml',
  // Elm
  'elm.json',
  // Nix
  'flake.nix',
  // GDScript (Godot)
  'project.godot',
];

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
 * Recursively discover child projects under `parentDir`.
 * Unlike `discoverChildProjects`, this traverses all nested directories
 * (e.g. the/fair/fair-front) — not just depth-1.
 * Stops descending into a directory once it's identified as a project root.
 */
export function discoverChildProjectsRecursive(parentDir: string, maxDepth = 10): string[] {
  const absParent = path.resolve(parentDir);
  if (!fs.existsSync(absParent)) return [];

  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const childDir = path.join(dir, entry.name);
      let isProject = false;
      for (const marker of ROOT_MARKERS) {
        if (fs.existsSync(path.join(childDir, marker))) {
          results.push(childDir);
          isProject = true;
          break;
        }
      }

      // Keep descending even into project dirs — monorepos have nested projects
      if (!isProject || depth < maxDepth) {
        walk(childDir, depth + 1);
      }
    }
  }

  walk(absParent, 0);
  return results.sort();
}

/**
 * Check if a directory itself contains any root marker (no walk-up).
 */
export function hasRootMarkers(dir: string): boolean {
  const absDir = path.resolve(dir);
  for (const marker of ROOT_MARKERS) {
    if (fs.existsSync(path.join(absDir, marker))) {
      return true;
    }
  }
  return false;
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
