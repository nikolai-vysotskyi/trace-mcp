/**
 * Python Module Resolver.
 *
 * Resolves Python dotted module names (e.g. `myapp.models.user`) to file paths,
 * analogous to PSR-4 for PHP and oxc-resolver for JS/TS.
 *
 * Handles:
 * - Absolute dotted imports: `import myapp.models.user`
 * - Relative imports: `from ..utils import helpers`
 * - Source root detection via pyproject.toml or src/ layout heuristic
 * - Package vs module distinction (__init__.py)
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, normalize } from 'node:path';

interface PyModuleResolveResult {
  path: string;
  isPackage: boolean;
}

export class PyModuleResolver {
  private sourceRoots: string[];

  constructor(
    private projectRoot: string,
    config?: { sourceRoots?: string[] },
  ) {
    if (config?.sourceRoots && config.sourceRoots.length > 0) {
      this.sourceRoots = [...config.sourceRoots];
    } else {
      this.sourceRoots = this.detectSourceRoots();
    }
  }

  /**
   * Resolve a dotted module name to a file path relative to project root.
   * Returns null if the module cannot be found in any source root (external/unresolved).
   */
  resolve(moduleName: string): string | null {
    const parts = moduleName.split('.');

    for (const root of this.sourceRoots) {
      const result = this.tryResolveInRoot(root, parts);
      if (result !== null) return result;
    }

    return null;
  }

  /**
   * Resolve a relative import (from . import X, from ..utils import Y)
   * given the importing file's path (relative to project root).
   *
   * @param dots - Number of leading dots (1 = current package, 2 = parent, etc.)
   * @param name - The module name after the dots, or null for bare relative (`from . import X`)
   * @param importingFile - Path of the file containing the import, relative to project root
   */
  resolveRelative(dots: number, name: string | null, importingFile: string): string | null {
    const normFile = importingFile.replace(/\\/g, '/');

    // Determine the package directory of the importing file.
    // If the file is __init__.py, its package is its own directory.
    // Otherwise, its package is its parent directory.
    let packageDir: string;
    const fileName = normFile.split('/').pop() ?? '';
    if (fileName === '__init__.py') {
      packageDir = dirname(normFile);
    } else {
      packageDir = dirname(normFile);
    }

    // Walk up (dots - 1) directories.
    // 1 dot = current package, 2 dots = parent package, etc.
    let targetDir = packageDir;
    for (let i = 1; i < dots; i++) {
      targetDir = dirname(targetDir);
      if (targetDir === '.') {
        // Cannot go above project root
        return null;
      }
    }

    if (!name) {
      // `from . import something` — resolve to the package __init__.py itself
      const initPath = join(targetDir, '__init__.py').replace(/\\/g, '/');
      if (existsSync(join(this.projectRoot, initPath))) {
        return initPath;
      }
      return null;
    }

    // Split the name on dots for sub-module access: `from .. import utils.helpers`
    const nameParts = name.split('.');
    return this.tryResolveInRoot(targetDir, nameParts);
  }

  /** Get source roots (for testing/debugging). */
  getSourceRoots(): string[] {
    return [...this.sourceRoots];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Try to resolve a sequence of module parts within a given root directory.
   * All paths are relative to projectRoot.
   */
  private tryResolveInRoot(root: string, parts: string[]): string | null {
    const modulePath = parts.join('/');
    const base = root === '.' ? modulePath : `${root}/${modulePath}`;

    // 1. Try as a direct .py file: <root>/myapp/models/user.py
    const pyFile = `${base}.py`;
    if (this.fileExists(pyFile)) {
      return pyFile;
    }

    // 2. Try as a package: <root>/myapp/models/user/__init__.py
    const initFile = `${base}/__init__.py`;
    if (this.fileExists(initFile)) {
      return initFile;
    }

    return null;
  }

  /** Check if a path (relative to projectRoot) exists and is a file. */
  private fileExists(relPath: string): boolean {
    const abs = join(this.projectRoot, relPath);
    try {
      return existsSync(abs) && statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  /** Check if a path (relative to projectRoot) exists and is a directory. */
  private dirExists(relPath: string): boolean {
    const abs = join(this.projectRoot, relPath);
    try {
      return existsSync(abs) && statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Detect source roots by reading pyproject.toml and inspecting directory layout.
   * Returns an array of paths relative to projectRoot.
   */
  private detectSourceRoots(): string[] {
    const roots: string[] = [];

    // Try pyproject.toml
    const pyprojectPath = join(this.projectRoot, 'pyproject.toml');
    if (existsSync(pyprojectPath)) {
      try {
        const content = readFileSync(pyprojectPath, 'utf-8');
        const tomlRoots = this.parseSourceRootsFromPyproject(content);
        roots.push(...tomlRoots);
      } catch {
        // ignore parse errors
      }
    }

    // Heuristic: src/ layout — if src/ exists and contains dirs with __init__.py
    if (!roots.includes('src') && this.dirExists('src')) {
      if (this.looksLikeSrcLayout('src')) {
        roots.push('src');
      }
    }

    // Always include project root as fallback
    if (!roots.includes('.')) {
      roots.push('.');
    }

    return roots;
  }

  /**
   * Very lightweight TOML parsing — just enough to extract source roots from
   * setuptools and poetry config. We avoid pulling in a full TOML parser.
   */
  private parseSourceRootsFromPyproject(content: string): string[] {
    const roots: string[] = [];

    // [tool.setuptools.packages.find] → where = ["src"]
    const setupToolsWhereMatch = content.match(
      /\[tool\.setuptools\.packages\.find\][^\[]*?where\s*=\s*\[([^\]]*)\]/s,
    );
    if (setupToolsWhereMatch) {
      const dirs = this.parseTomlStringArray(setupToolsWhereMatch[1]);
      roots.push(...dirs);
    }

    // [tool.poetry.packages] → [{include = "myapp", from = "src"}]
    // This is an array of inline tables — extract `from` values
    const poetryPkgSection = content.match(/\[tool\.poetry\][^\[]*?packages\s*=\s*\[([^\]]*)\]/s);
    if (poetryPkgSection) {
      const fromMatches = poetryPkgSection[1].matchAll(/from\s*=\s*"([^"]*)"/g);
      for (const m of fromMatches) {
        if (m[1] && !roots.includes(m[1])) {
          roots.push(m[1]);
        }
      }
    }

    return roots;
  }

  /** Parse a TOML-style string array like `"src", "lib"` into string[]. */
  private parseTomlStringArray(raw: string): string[] {
    const results: string[] = [];
    const matches = raw.matchAll(/"([^"]*)"/g);
    for (const m of matches) {
      if (m[1]) results.push(m[1]);
    }
    return results;
  }

  /** Check if a directory looks like a Python src/ layout (contains packages). */
  private looksLikeSrcLayout(dir: string): boolean {
    const abs = join(this.projectRoot, dir);
    try {
      const { readdirSync } = require('node:fs');
      const entries = readdirSync(abs, { withFileTypes: true }) as Array<{
        name: string;
        isDirectory(): boolean;
      }>;
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const initPath = `${dir}/${entry.name}/__init__.py`;
          if (this.fileExists(initPath)) {
            return true;
          }
        }
      }
    } catch {
      // ignore
    }
    return false;
  }
}
