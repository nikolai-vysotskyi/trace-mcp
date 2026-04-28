/**
 * Alias-aware import path rewriting for refactoring tools.
 *
 * Computes new import specifiers when files/symbols move, respecting
 * tsconfig paths, Nuxt/Vite aliases, and language-specific conventions.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EsModuleResolver } from '../../indexer/resolvers/es-modules.js';
import type { FileEdit } from './shared.js';
import { readLines, writeLines } from './shared.js';

// Extensions to strip when generating import specifiers (TS/JS convention)
const STRIP_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

// Regex patterns for TS/JS import/export/require statements
const IMPORT_PATTERNS = [
  // import ... from 'specifier'
  /(?:import\s+(?:[\s\S]*?)\s+from\s+)(['"])([^'"]+)\1/g,
  // export ... from 'specifier'
  /(?:export\s+(?:[\s\S]*?)\s+from\s+)(['"])([^'"]+)\1/g,
  // require('specifier')
  /require\(\s*(['"])([^'"]+)\1\s*\)/g,
  // dynamic import('specifier')
  /import\(\s*(['"])([^'"]+)\1\s*\)/g,
];

/**
 * Compute the new import specifier after a target has moved.
 *
 * Strategy:
 * 1. If resolver is available and the old specifier was NOT a relative path,
 *    try to find an alias that covers the new target location.
 * 2. Otherwise, compute relative path from importer to new target.
 */
export function computeNewImportSpecifier(
  importingFilePath: string,
  oldSpecifier: string,
  newTargetAbsPath: string,
  projectRoot: string,
  resolver?: EsModuleResolver,
): string {
  const isRelative = oldSpecifier.startsWith('.') || oldSpecifier.startsWith('/');

  // If old specifier was alias-based, try to preserve alias style
  if (!isRelative && resolver) {
    // Check if the resolver can resolve the new path from the same alias prefix
    // e.g. if old was '@/utils/foo' and new is at src/utils/bar,
    // try '@/utils/bar'
    const aliasPrefix = oldSpecifier.split('/').slice(0, 1).join('/');
    if (aliasPrefix.startsWith('@') || aliasPrefix.startsWith('~')) {
      const _oldSuffix = oldSpecifier.slice(aliasPrefix.length);
      // Compute what the suffix would be for the new path
      const resolved = resolver.resolve(aliasPrefix, importingFilePath);
      if (resolved) {
        const aliasRoot = path.dirname(resolved);
        const newRelToAlias = path.relative(aliasRoot, newTargetAbsPath);
        if (!newRelToAlias.startsWith('..')) {
          const newSpecifier = `${aliasPrefix}/${stripExtension(newRelToAlias)}`;
          // Verify it resolves correctly
          const check = resolver.resolve(newSpecifier, importingFilePath);
          if (check && normalizePath(check) === normalizePath(newTargetAbsPath)) {
            return newSpecifier;
          }
        }
      }
    }
  }

  // Fall back to relative path computation
  return computeRelativeSpecifier(importingFilePath, newTargetAbsPath);
}

/**
 * Compute a relative import specifier from one file to another.
 * Strips extensions per TS/JS convention and ensures leading './'.
 */
export function computeRelativeSpecifier(fromFile: string, toFile: string): string {
  const fromDir = path.dirname(fromFile);
  let rel = path.relative(fromDir, toFile);

  // Strip extension if it's a TS/JS file
  rel = stripExtension(rel);

  // Handle index files: ./utils/index → ./utils
  if (rel.endsWith('/index') || rel === 'index') {
    rel = rel === 'index' ? '.' : rel.slice(0, -6);
  }

  // Ensure leading './' for same-directory or child imports
  if (!rel.startsWith('.') && !rel.startsWith('/')) {
    rel = `./${rel}`;
  }

  // Normalize separators to forward slashes
  return rel.replace(/\\/g, '/');
}

/**
 * Strip file extension if it's a standard TS/JS extension.
 */
function stripExtension(filePath: string): string {
  const ext = path.extname(filePath);
  if (STRIP_EXTENSIONS.has(ext)) {
    return filePath.slice(0, -ext.length);
  }
  return filePath;
}

/** Normalize path for comparison. */
function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/');
}

/**
 * Scan a file for import/require/export-from statements that match `oldSpecifier`
 * and rewrite them to `newSpecifier`.
 *
 * Returns the edits and the modified lines (for chaining or dry-run).
 */
export function rewriteImportSpecifiers(
  filePath: string,
  projectRoot: string,
  oldSpecifier: string,
  newSpecifier: string,
  dryRun: boolean,
): { edits: FileEdit[]; lines: string[] } {
  const edits: FileEdit[] = [];

  if (!fs.existsSync(filePath)) {
    return { edits, lines: [] };
  }

  const lines = readLines(filePath);
  const relPath = path.relative(projectRoot, filePath);
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Quick check: does this line contain the old specifier at all?
    if (!line.includes(oldSpecifier)) continue;

    // Try replacing the specifier in import/export/require statements
    let newLine = line;
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      newLine = newLine.replace(new RegExp(pattern.source, pattern.flags), (match, quote, spec) => {
        if (spec === oldSpecifier) {
          return match.replace(spec, newSpecifier);
        }
        return match;
      });
    }

    if (newLine !== line) {
      edits.push({
        file: relPath,
        original_line: i + 1,
        original_text: line.trimStart(),
        new_text: newLine.trimStart(),
      });
      lines[i] = newLine;
      modified = true;
    }
  }

  if (modified && !dryRun) {
    writeLines(filePath, lines);
  }

  return { edits, lines };
}

/**
 * Given an absolute file path that's being imported, compute what specifier
 * is used in a given source file's imports.
 *
 * Scans the source file for imports that resolve to `targetAbsPath`.
 * Returns the specifier string if found, or undefined.
 */
export function findImportSpecifier(
  sourceFilePath: string,
  targetAbsPath: string,
  projectRoot: string,
  resolver?: EsModuleResolver,
): string | undefined {
  if (!fs.existsSync(sourceFilePath)) return undefined;

  const lines = readLines(sourceFilePath);
  const fullText = lines.join('\n');

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(fullText)) !== null) {
      const specifier = match[2];
      if (!specifier) continue;

      // Try to resolve this specifier to see if it points to our target
      let resolvedPath: string | undefined;

      if (resolver) {
        resolvedPath = resolver.resolve(specifier, sourceFilePath);
      }

      if (!resolvedPath && (specifier.startsWith('.') || specifier.startsWith('/'))) {
        // Manual resolution for relative paths
        const fromDir = path.dirname(sourceFilePath);
        const candidate = path.resolve(fromDir, specifier);
        // Try with various extensions
        for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
          const full = candidate + ext;
          if (fs.existsSync(full)) {
            resolvedPath = full;
            break;
          }
        }
      }

      if (resolvedPath && normalizePath(resolvedPath) === normalizePath(targetAbsPath)) {
        return specifier;
      }
    }
  }

  return undefined;
}

/**
 * Rewrite a single import specifier in a file using the resolved target path.
 *
 * This is a higher-level helper that:
 * 1. Finds what specifier the file uses to import from `oldTargetAbsPath`
 * 2. Computes the new specifier for `newTargetAbsPath`
 * 3. Rewrites the import
 */
export function rewriteImportForMovedTarget(
  importerAbsPath: string,
  oldTargetAbsPath: string,
  newTargetAbsPath: string,
  projectRoot: string,
  dryRun: boolean,
  resolver?: EsModuleResolver,
): FileEdit[] {
  const oldSpecifier = findImportSpecifier(
    importerAbsPath,
    oldTargetAbsPath,
    projectRoot,
    resolver,
  );
  if (!oldSpecifier) return [];

  const newSpecifier = computeNewImportSpecifier(
    importerAbsPath,
    oldSpecifier,
    newTargetAbsPath,
    projectRoot,
    resolver,
  );

  if (oldSpecifier === newSpecifier) return [];

  const { edits } = rewriteImportSpecifiers(
    importerAbsPath,
    projectRoot,
    oldSpecifier,
    newSpecifier,
    dryRun,
  );

  return edits;
}
