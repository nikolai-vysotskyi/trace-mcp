/**
 * Detect the project root from any subdirectory by walking up
 * looking for well-known marker files/directories.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.svn', '__pycache__', '.tox']);

export const ROOT_MARKERS = [
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

export interface WorktreeInfo {
  /** Absolute path to the main worktree root (where the primary .git directory lives). */
  mainRoot: string;
}

/**
 * Detect whether `dir` (default: cwd) is inside a git linked worktree.
 *
 * In a linked worktree, `<project-root>/.git` is a FILE containing:
 *   "gitdir: /path/to/main/.git/worktrees/<name>"
 *
 * That admin directory contains a `commondir` file whose content is a
 * relative path pointing back to the shared `.git` directory of the main
 * worktree.  The main repo root is simply the parent of that directory.
 *
 * Returns null when:
 *  - not in a git repo
 *  - `.git` is a directory (this IS the main worktree)
 *  - any file is missing or unreadable
 */
export function detectGitWorktree(dir?: string): WorktreeInfo | null {
  const absDir = path.resolve(dir ?? process.cwd());

  let projectDir: string;
  try {
    projectDir = findProjectRoot(absDir);
  } catch {
    return null;
  }

  const gitEntry = path.join(projectDir, '.git');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitEntry);
  } catch {
    return null;
  }

  // .git is a directory → this is the main worktree, not a linked one
  if (!stat.isFile()) return null;

  // .git file content: "gitdir: /abs/path/to/.git/worktrees/<name>"
  let gitFileContent: string;
  try {
    gitFileContent = fs.readFileSync(gitEntry, 'utf8').trim();
  } catch {
    return null;
  }

  const match = gitFileContent.match(/^gitdir:\s*(.+)$/);
  if (!match) return null;

  const worktreeAdminDir = path.resolve(projectDir, match[1].trim());

  // commondir is relative to the worktree admin directory and points to the
  // main .git dir (e.g. "../.." or an absolute path)
  let mainGitDir: string;
  try {
    const raw = fs.readFileSync(path.join(worktreeAdminDir, 'commondir'), 'utf8').trim();
    mainGitDir = path.resolve(worktreeAdminDir, raw);
  } catch {
    // Fallback: the admin dir is .git/worktrees/<name>, so ../../ is .git
    mainGitDir = path.resolve(worktreeAdminDir, '../..');
  }

  const mainRoot = path.dirname(mainGitDir);

  // Sanity check: main root must have a real .git directory
  try {
    const mainGitStat = fs.statSync(path.join(mainRoot, '.git'));
    if (!mainGitStat.isDirectory()) return null;
  } catch {
    return null;
  }

  return { mainRoot };
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
 *
 * Env-var override: `TRACE_MCP_REPO_ROOT` short-circuits the walk and is
 * returned verbatim (after `~` expansion). Useful for scripted callers
 * that invoke trace-mcp from a parent directory or for Docker/CI contexts
 * where the repo lives outside the cwd. CRG v2.3.0 (#155) introduced the
 * same knob.
 */
export function findProjectRoot(from?: string): string {
  const envOverride = process.env.TRACE_MCP_REPO_ROOT;
  if (envOverride && envOverride.length > 0) {
    const expanded = envOverride.startsWith('~')
      ? path.join(os.homedir(), envOverride.slice(1))
      : envOverride;
    return path.resolve(expanded);
  }

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
