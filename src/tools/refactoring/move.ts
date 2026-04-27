/**
 * Move refactoring — move a symbol between files or rename/move a file,
 * updating all import paths across the codebase.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';
import type { EsModuleResolver } from '../../indexer/resolvers/es-modules.js';
import type { FileEdit, RefactorResult } from './shared.js';
import { readLines, writeLines, getImportingFiles } from './shared.js';
import { rewriteImportForMovedTarget, computeRelativeSpecifier } from './import-rewriter.js';

export interface MoveSymbolParams {
  symbol_id: string;
  target_file: string; // relative to project root
  dry_run?: boolean;
}

export interface MoveFileParams {
  source_file: string; // relative to project root
  new_path: string; // relative to project root
  dry_run?: boolean;
}

export type MoveParams =
  | ({ mode: 'symbol' } & MoveSymbolParams)
  | ({ mode: 'file' } & MoveFileParams);

/**
 * Move a symbol to a different file, or rename/move a file.
 * Updates all import paths across the codebase.
 */
export function applyMove(
  store: Store,
  projectRoot: string,
  params: MoveParams,
  resolver?: EsModuleResolver,
): RefactorResult {
  if (params.mode === 'symbol') {
    return moveSymbol(store, projectRoot, params, resolver);
  }
  return moveFile(store, projectRoot, params, resolver);
}

// ════════════════════════════════════════════════════════════════════════
// MODE 1: MOVE SYMBOL
// ════════════════════════════════════════════════════════════════════════

function moveSymbol(
  store: Store,
  projectRoot: string,
  params: MoveSymbolParams,
  resolver?: EsModuleResolver,
): RefactorResult {
  const dryRun = params.dry_run ?? true;
  const result: RefactorResult = {
    success: false,
    tool: 'apply_move',
    edits: [],
    files_modified: [],
    warnings: [],
  };

  // 1. Resolve the symbol
  const symbol = store.getSymbolBySymbolId(params.symbol_id);
  if (!symbol) {
    result.error = `Symbol not found: ${params.symbol_id}`;
    return result;
  }

  if (symbol.line_start == null || symbol.line_end == null) {
    result.error = `Symbol "${symbol.name}" has no line range — cannot move`;
    return result;
  }

  // 2. Get source file
  const sourceFile = store.getFileById(symbol.file_id);
  if (!sourceFile) {
    result.error = `Source file not found for symbol ${params.symbol_id}`;
    return result;
  }

  const sourceAbsPath = path.resolve(projectRoot, sourceFile.path);
  const targetAbsPath = path.resolve(projectRoot, params.target_file);

  if (!fs.existsSync(sourceAbsPath)) {
    result.error = `Source file not found on disk: ${sourceFile.path}`;
    return result;
  }

  // 3. Collision detection in target file
  if (fs.existsSync(targetAbsPath)) {
    const targetFile = store.getFile(params.target_file);
    if (targetFile) {
      const targetSymbols = store.getSymbolsByFile(targetFile.id);
      const collision = targetSymbols.find((s) => s.name === symbol.name);
      if (collision) {
        result.error = `Name collision: "${symbol.name}" already exists in ${params.target_file} at line ${collision.line_start}`;
        return result;
      }
    }
  }

  // 4. Extract symbol source text (including decorators/JSDoc above)
  const sourceLines = readLines(sourceAbsPath);
  let extractStart = symbol.line_start - 1; // 0-indexed

  // Walk backwards to include decorators and JSDoc
  while (extractStart > 0) {
    const prevLine = sourceLines[extractStart - 1].trim();
    if (
      prevLine.startsWith('@') ||
      prevLine.startsWith('*') ||
      prevLine.startsWith('/**') ||
      prevLine === '*/' ||
      prevLine.startsWith('//') ||
      prevLine.startsWith('#')
    ) {
      extractStart--;
    } else {
      break;
    }
  }

  const extractEnd = symbol.line_end; // inclusive in DB, exclusive for slice
  const extractedLines = sourceLines.slice(extractStart, extractEnd);
  const extractedText = extractedLines.join('\n');

  // Check if symbol is exported
  const meta = symbol.metadata
    ? typeof symbol.metadata === 'string'
      ? JSON.parse(symbol.metadata)
      : symbol.metadata
    : {};
  const isExported = !!meta?.exported;

  // 5. Prepare target file content
  let targetLines: string[];
  const targetExists = fs.existsSync(targetAbsPath);

  if (targetExists) {
    targetLines = readLines(targetAbsPath);
  } else {
    targetLines = [];
  }

  // Find insertion point in target: after last import, or at end
  let insertIdx = targetLines.length;
  for (let i = targetLines.length - 1; i >= 0; i--) {
    const trimmed = targetLines[i].trim();
    if (
      trimmed.startsWith('import ') ||
      trimmed.startsWith('from ') ||
      trimmed.startsWith('require(')
    ) {
      insertIdx = i + 1;
      break;
    }
  }

  // Determine if we need to add an import for dependencies the symbol has
  // from its original file's other symbols
  const fileSymbols = store.getSymbolsByFile(symbol.file_id);
  const siblingNames = new Set(fileSymbols.filter((s) => s.id !== symbol.id).map((s) => s.name));
  const referencedSiblings = findReferencedNames(extractedText, siblingNames);

  // Build the import line for sibling dependencies
  let siblingImport = '';
  if (referencedSiblings.length > 0) {
    const relSpec = computeRelativeSpecifier(targetAbsPath, sourceAbsPath);
    siblingImport = `import { ${referencedSiblings.join(', ')} } from '${relSpec}';`;
  }

  // 6. Build the text to insert in target
  const insertLines: string[] = [];
  if (siblingImport) {
    insertLines.push(siblingImport);
  }
  if (insertLines.length > 0 || insertIdx > 0) {
    insertLines.push(''); // blank line separator
  }
  insertLines.push(...extractedLines);
  insertLines.push('');

  // Record edit for target file
  result.edits.push({
    file: params.target_file,
    original_line: insertIdx + 1,
    original_text: '(insertion point)',
    new_text: insertLines.join('\n').trimEnd(),
  });

  // 7. Record edit for source file: remove the symbol
  result.edits.push({
    file: sourceFile.path,
    original_line: extractStart + 1,
    original_text: extractedText
      .split('\n')
      .map((l) => l.trimStart())
      .join('\n'),
    new_text: '(removed)',
  });

  // 8. Update all importing files
  if (isExported) {
    const importingFiles = getImportingFiles(store, symbol.file_id, projectRoot);
    for (const { filePath: importerAbsPath } of importingFiles) {
      if (!fs.existsSync(importerAbsPath)) continue;

      // Check if this importer references the moved symbol
      const importerLines = readLines(importerAbsPath);
      const importerContent = importerLines.join('\n');
      const nameRegex = new RegExp(`\\b${escapeRegex(symbol.name)}\\b`);

      if (!nameRegex.test(importerContent)) continue;

      // Find the import line for the source file and check if it includes our symbol
      const importEdits = rewriteSymbolImport(
        importerAbsPath,
        sourceAbsPath,
        targetAbsPath,
        symbol.name,
        projectRoot,
        dryRun,
        resolver,
      );
      result.edits.push(...importEdits);
      if (importEdits.length > 0) {
        result.files_modified.push(path.relative(projectRoot, importerAbsPath));
      }
    }

    // Check if we need a re-export in the source file for backwards compatibility
    const remainingExports = fileSymbols.filter((s) => {
      if (s.id === symbol.id) return false;
      if (!s.metadata) return false;
      const m = typeof s.metadata === 'string' ? JSON.parse(s.metadata) : s.metadata;
      return m?.exported;
    });

    if (remainingExports.length > 0) {
      // Source file still has other exports — importing files may import multiple things
      // We'll add a re-export to avoid breaking imports that pull multiple symbols
      result.warnings.push(
        `Source file has ${remainingExports.length} other export(s). ` +
          `Consider adding a re-export: export { ${symbol.name} } from '${computeRelativeSpecifier(sourceAbsPath, targetAbsPath)}';`,
      );
    }
  }

  // 9. Apply changes if not dry run
  if (!dryRun) {
    // Remove from source
    sourceLines.splice(extractStart, extractEnd - extractStart);
    // Clean up consecutive blank lines
    for (let i = sourceLines.length - 1; i > 0; i--) {
      if (sourceLines[i].trim() === '' && sourceLines[i - 1].trim() === '') {
        sourceLines.splice(i, 1);
      }
    }
    writeLines(sourceAbsPath, sourceLines);

    // Write to target
    if (targetExists) {
      const tLines = readLines(targetAbsPath);
      tLines.splice(insertIdx, 0, ...insertLines);
      writeLines(targetAbsPath, tLines);
    } else {
      // Create parent directories
      const targetDir = path.dirname(targetAbsPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      writeLines(targetAbsPath, insertLines);
    }

    result.files_modified.push(sourceFile.path, params.target_file);
  } else {
    result.files_modified.push(sourceFile.path, params.target_file);
  }

  result.success = true;
  return result;
}

// ════════════════════════════════════════════════════════════════════════
// MODE 2: MOVE FILE
// ════════════════════════════════════════════════════════════════════════

function moveFile(
  store: Store,
  projectRoot: string,
  params: MoveFileParams,
  resolver?: EsModuleResolver,
): RefactorResult {
  const dryRun = params.dry_run ?? true;
  const result: RefactorResult = {
    success: false,
    tool: 'apply_move',
    edits: [],
    files_modified: [],
    warnings: [],
  };

  const sourceAbsPath = path.resolve(projectRoot, params.source_file);
  const targetAbsPath = path.resolve(projectRoot, params.new_path);

  if (!fs.existsSync(sourceAbsPath)) {
    result.error = `Source file not found: ${params.source_file}`;
    return result;
  }

  if (fs.existsSync(targetAbsPath)) {
    result.error = `Target path already exists: ${params.new_path}`;
    return result;
  }

  // 1. Find all importers of this file
  const fileRow = store.getFile(params.source_file);
  if (!fileRow) {
    result.error = `File not in index: ${params.source_file}. Run reindex first.`;
    return result;
  }

  const importingFiles = getImportingFiles(store, fileRow.id, projectRoot);

  // 2. Rewrite import paths in all importers
  for (const { filePath: importerAbsPath } of importingFiles) {
    if (!fs.existsSync(importerAbsPath)) continue;

    const edits = rewriteImportForMovedTarget(
      importerAbsPath,
      sourceAbsPath,
      targetAbsPath,
      projectRoot,
      dryRun,
      resolver,
    );
    result.edits.push(...edits);
    if (edits.length > 0) {
      result.files_modified.push(path.relative(projectRoot, importerAbsPath));
    }
  }

  // 3. Rewrite the file's own relative imports (its location changes)
  const selfEdits = rewriteOwnImports(
    sourceAbsPath,
    targetAbsPath,
    projectRoot,
    store,
    dryRun,
    resolver,
  );
  result.edits.push(...selfEdits);

  // 4. Move the file
  result.edits.push({
    file: params.source_file,
    original_line: 0,
    original_text: `(file at ${params.source_file})`,
    new_text: `(moved to ${params.new_path})`,
  });

  if (!dryRun) {
    const targetDir = path.dirname(targetAbsPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // If we rewrote own imports, read the modified content; otherwise move as-is
    if (selfEdits.length > 0) {
      // Content was already modified on disk by rewriteImportSpecifiers
      fs.renameSync(sourceAbsPath, targetAbsPath);
    } else {
      fs.renameSync(sourceAbsPath, targetAbsPath);
    }
  }

  result.files_modified.push(params.source_file, params.new_path);
  result.success = true;
  return result;
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Rewrite the file's own relative imports after its location changes.
 * E.g., if the file moves from src/a/foo.ts to src/b/foo.ts,
 * its import '../utils/bar' needs to become '../../a/../utils/bar' → normalized.
 */
function rewriteOwnImports(
  currentAbsPath: string,
  newAbsPath: string,
  projectRoot: string,
  store: Store,
  dryRun: boolean,
  resolver?: EsModuleResolver,
): FileEdit[] {
  const lines = readLines(currentAbsPath);
  const edits: FileEdit[] = [];
  const relPath = path.relative(projectRoot, currentAbsPath);
  const currentDir = path.dirname(currentAbsPath);
  const newDir = path.dirname(newAbsPath);

  if (currentDir === newDir) return edits; // same directory, no change needed

  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match import specifiers in this line
    const specifierMatch = extractSpecifierFromLine(line);
    if (!specifierMatch || !specifierMatch.startsWith('.')) continue;

    // Resolve the old specifier to an absolute path
    const resolvedAbs = resolveRelativeSpecifier(currentDir, specifierMatch);
    if (!resolvedAbs) continue;

    // Compute new specifier from the new location
    const newSpecifier = computeRelativeSpecifier(newAbsPath, resolvedAbs);
    if (newSpecifier === specifierMatch) continue;

    const newLine = line.replace(specifierMatch, newSpecifier);
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
    writeLines(currentAbsPath, lines);
  }

  return edits;
}

/** Extract the import specifier string from a line (first match). */
function extractSpecifierFromLine(line: string): string | undefined {
  // import ... from 'spec'
  const fromMatch = line.match(/from\s+(['"])([^'"]+)\1/);
  if (fromMatch) return fromMatch[2];

  // require('spec')
  const requireMatch = line.match(/require\(\s*(['"])([^'"]+)\1\s*\)/);
  if (requireMatch) return requireMatch[2];

  // dynamic import('spec')
  const dynamicMatch = line.match(/import\(\s*(['"])([^'"]+)\1\s*\)/);
  if (dynamicMatch) return dynamicMatch[2];

  return undefined;
}

/** Resolve a relative specifier to an absolute path, trying common extensions. */
function resolveRelativeSpecifier(fromDir: string, specifier: string): string | undefined {
  const candidate = path.resolve(fromDir, specifier);
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
  for (const ext of extensions) {
    const full = candidate + ext;
    if (fs.existsSync(full)) {
      return full;
    }
  }
  return candidate; // Return even if not found on disk (may be in graph)
}

/**
 * Rewrite a specific symbol's import in an importing file.
 * Handles the case where the import pulls multiple symbols from the source —
 * splits the import into two: one for remaining symbols (old source) and one
 * for the moved symbol (new target).
 */
function rewriteSymbolImport(
  importerAbsPath: string,
  sourceAbsPath: string,
  targetAbsPath: string,
  symbolName: string,
  projectRoot: string,
  dryRun: boolean,
  resolver?: EsModuleResolver,
): FileEdit[] {
  const edits: FileEdit[] = [];
  const lines = readLines(importerAbsPath);
  const relPath = path.relative(projectRoot, importerAbsPath);
  const importerDir = path.dirname(importerAbsPath);
  let modified = false;

  // Find the import line that imports from the source file
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const specifier = extractSpecifierFromLine(line);
    if (!specifier) continue;

    // Check if this specifier resolves to the source file
    const resolvedAbs = resolver
      ? resolver.resolve(specifier, importerAbsPath)
      : resolveRelativeSpecifier(importerDir, specifier);

    if (!resolvedAbs) continue;
    const normalizedResolved = path.resolve(resolvedAbs).replace(/\\/g, '/');
    const normalizedSource = path.resolve(sourceAbsPath).replace(/\\/g, '/');
    if (normalizedResolved !== normalizedSource) continue;

    // Found an import from the source file — check if it references our symbol
    const nameRegex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);
    if (!nameRegex.test(line)) continue;

    // Check if this import has multiple symbols
    const namedImportMatch = line.match(/\{([^}]+)\}/);
    if (namedImportMatch) {
      const names = namedImportMatch[1]
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      const otherNames = names.filter((n) => {
        // Handle `name as alias` patterns
        const baseName = n.split(/\s+as\s+/)[0].trim();
        return baseName !== symbolName;
      });

      const movedName = names.find((n) => {
        const baseName = n.split(/\s+as\s+/)[0].trim();
        return baseName === symbolName;
      });

      if (!movedName) continue;

      // Compute new import specifier for the target
      const newSpecifier = computeRelativeSpecifier(importerAbsPath, targetAbsPath);

      if (otherNames.length > 0) {
        // Split: keep old import with remaining symbols, add new import for moved symbol
        const oldImportRewritten = line.replace(
          namedImportMatch[0],
          `{ ${otherNames.join(', ')} }`,
        );
        const newImportLine = `import { ${movedName} } from '${newSpecifier}';`;

        edits.push({
          file: relPath,
          original_line: i + 1,
          original_text: line.trimStart(),
          new_text: `${oldImportRewritten.trimStart()}\n${newImportLine}`,
        });
        lines[i] = oldImportRewritten + '\n' + newImportLine;
      } else {
        // This import only had the moved symbol — rewrite the whole specifier
        const newLine = line.replace(specifier, newSpecifier);
        edits.push({
          file: relPath,
          original_line: i + 1,
          original_text: line.trimStart(),
          new_text: newLine.trimStart(),
        });
        lines[i] = newLine;
      }
      modified = true;
    } else {
      // Default export or namespace import — rewrite the specifier
      const newSpecifier = computeRelativeSpecifier(importerAbsPath, targetAbsPath);
      const newLine = line.replace(specifier, newSpecifier);
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
  }

  if (modified && !dryRun) {
    writeLines(importerAbsPath, lines);
  }

  return edits;
}

/** Find which names from a set are referenced in the given text. */
function findReferencedNames(text: string, names: Set<string>): string[] {
  const found: string[] = [];
  for (const name of names) {
    const regex = new RegExp(`\\b${escapeRegex(name)}\\b`);
    if (regex.test(text)) {
      found.push(name);
    }
  }
  return found;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
