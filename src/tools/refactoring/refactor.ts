/**
 * Refactoring execution tools — apply_rename, remove_dead_code, extract_function, apply_codemod.
 *
 * These tools perform actual file modifications guided by the dependency graph.
 * Each tool produces a structured diff plan with the exact edits to apply,
 * then writes the modified files atomically.
 */

import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Store } from '../../db/store.js';
import { maybeYield } from '../../utils/event-loop.js';
import {
  type AstCodemodFileResult,
  astLangForFile,
  looksLikeAstPattern,
  runAstCodemodOnSource,
} from './codemod-ast.js';
import { isExtractError, planExtractFunction } from './extract-function-ast.js';
import { scanNonCodeFiles } from './non-code-scanner.js';
import { checkRenameSafe } from './rename-check.js';
import {
  BINARY_EXTENSIONS,
  buildRenameRegex,
  getImportingFiles,
  type RefactorResult,
  readLines,
  SKIP_DIRS,
  toPosix,
  writeLines,
} from './shared.js';

// Re-export shared types for consumers
export type { FileEdit, RefactorResult } from './shared.js';

// ════════════════════════════════════════════════════════════════════════
// TOOL 1: APPLY RENAME
// ════════════════════════════════════════════════════════════════════════

const RENAME_LARGE_THRESHOLD = 20;

/**
 * Rename a symbol across all usages — the symbol's definition file and all
 * importing files. Runs check_rename first and aborts on conflicts.
 *
 * Dry-run safeguard: when `dryRun=false` and the rename would touch more than
 * 20 files, callers must pass `options.confirmLarge=true` to proceed. Without
 * confirmation the call returns a preview (no files written) so the agent has
 * to acknowledge the blast radius before the destructive apply.
 */
export function applyRename(
  store: Store,
  projectRoot: string,
  symbolId: string,
  newName: string,
  dryRun = false,
  options: { confirmLarge?: boolean } = {},
): RefactorResult {
  const result: RefactorResult = {
    success: false,
    tool: 'apply_rename',
    edits: [],
    files_modified: [],
    warnings: [],
  };

  // 1. Resolve the symbol
  const symbol = store.getSymbolBySymbolId(symbolId);
  if (!symbol) {
    result.error = `Symbol not found: ${symbolId}`;
    return result;
  }

  const oldName = symbol.name;
  if (oldName === newName) {
    result.error = 'New name is the same as the current name';
    return result;
  }

  // 2. Safety check — abort on conflicts
  const check = checkRenameSafe(store, symbolId, newName);
  if (!check.safe) {
    result.error = `Rename conflicts detected: ${check.conflicts.map((c) => `${c.file}:${c.existing_name} (${c.reason})`).join('; ')}`;
    result.warnings = check.conflicts.map(
      (c) => `Conflict in ${c.file}: existing ${c.kind} "${c.existing_name}" at line ${c.line}`,
    );
    return result;
  }

  // 3. Gather files to modify
  const symbolFile = store.getFileById(symbol.file_id);
  if (!symbolFile) {
    result.error = `File not found for symbol ${symbolId}`;
    return result;
  }

  const definitionFilePath = path.resolve(projectRoot, symbolFile.path);
  const importingFiles = getImportingFiles(store, symbol.file_id, projectRoot);
  const allFiles = [{ filePath: definitionFilePath, fileId: symbol.file_id }, ...importingFiles];

  const regex = buildRenameRegex(oldName);
  const modifiedFiles = new Set<string>();
  // Buffer pending writes so the >20-file safeguard can abort BEFORE any
  // file is mutated on disk.
  const pendingWrites: Array<{ filePath: string; lines: string[] }> = [];

  // 4. Compute edits file by file
  for (const { filePath } of allFiles) {
    if (!fs.existsSync(filePath)) {
      result.warnings.push(`File not found on disk: ${filePath}`);
      continue;
    }

    const lines = readLines(filePath);
    let fileModified = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (regex.test(line)) {
        const newLine = line.replace(regex, newName);
        // Reset regex lastIndex since we used .test()
        regex.lastIndex = 0;
        if (newLine !== line) {
          result.edits.push({
            file: toPosix(path.relative(projectRoot, filePath)),
            original_line: i + 1,
            original_text: line.trimStart(),
            new_text: newLine.trimStart(),
          });
          lines[i] = newLine;
          fileModified = true;
        }
      }
      regex.lastIndex = 0;
    }

    if (fileModified) {
      modifiedFiles.add(toPosix(path.relative(projectRoot, filePath)));
      pendingWrites.push({ filePath, lines });
    }
  }

  // 4a. Large-change safeguard — refuse to mutate >20 files without an
  // explicit acknowledgement from the caller. The preview (edits +
  // files_modified) is still returned so the caller can re-issue the call
  // with confirm_large: true.
  if (!dryRun && modifiedFiles.size > RENAME_LARGE_THRESHOLD && !options.confirmLarge) {
    result.success = false;
    result.error =
      `Rename affects ${modifiedFiles.size} files (>${RENAME_LARGE_THRESHOLD}). ` +
      `Pass confirm_large: true to proceed.`;
    result.files_modified = [...modifiedFiles];
    result.warnings.push(
      `Large rename blocked: ${modifiedFiles.size} files would be modified. ` +
        `Re-run with confirm_large: true to apply, or narrow the rename scope.`,
    );
    return result;
  }

  // 4b. Flush writes (skipped on dry_run)
  if (!dryRun) {
    for (const { filePath, lines } of pendingWrites) {
      writeLines(filePath, lines);
    }
  }

  result.success = true;
  result.files_modified = [...modifiedFiles];

  if (result.files_modified.length === 0) {
    result.warnings.push('No text matches found — symbol may use dynamic references');
  }

  // Scan non-code files for mentions (suggestions only, not auto-applied)
  const nonCodeMentions = scanNonCodeFiles(projectRoot, oldName, newName);
  if (nonCodeMentions.length > 0) {
    result.non_code_suggestions = nonCodeMentions;
    result.warnings.push(
      `Found ${nonCodeMentions.length} mention(s) in non-code files — review suggestions in non_code_suggestions`,
    );
  }

  return result;
}

// ════════════════════════════════════════════════════════════════════════
// TOOL 2: REMOVE DEAD CODE
// ════════════════════════════════════════════════════════════════════════

/**
 * Safely remove a dead symbol from its file.
 * Verifies the symbol is actually dead (via multi-signal detection) before removal.
 * Removes the symbol's lines and cleans up empty lines around it.
 */
export function removeDeadCode(
  store: Store,
  projectRoot: string,
  symbolId: string,
  dryRun = false,
): RefactorResult {
  const result: RefactorResult = {
    success: false,
    tool: 'remove_dead_code',
    edits: [],
    files_modified: [],
    warnings: [],
  };

  // 1. Resolve the symbol
  const symbol = store.getSymbolBySymbolId(symbolId);
  if (!symbol) {
    result.error = `Symbol not found: ${symbolId}`;
    return result;
  }

  // 2. Verify symbol is safe to remove — targeted check via incoming edges
  const symNodeId = store.getNodeId('symbol', symbol.id);
  if (symNodeId !== undefined) {
    const incoming = store.getIncomingEdges(symNodeId);
    if (incoming.length > 0) {
      const edgeDescriptions = incoming.slice(0, 5).map((e) => {
        const sourceRef = store.getNodeRef(e.source_node_id);
        if (!sourceRef) return `edge#${e.id}`;
        if (sourceRef.nodeType === 'symbol') {
          const srcSym = store.getSymbolById(sourceRef.refId);
          return srcSym ? `${srcSym.symbol_id}` : `symbol#${sourceRef.refId}`;
        }
        if (sourceRef.nodeType === 'file') {
          const srcFile = store.getFileById(sourceRef.refId);
          return srcFile ? srcFile.path : `file#${sourceRef.refId}`;
        }
        return `${sourceRef.nodeType}#${sourceRef.refId}`;
      });
      const suffix = incoming.length > 5 ? ` (and ${incoming.length - 5} more)` : '';
      result.error = `Symbol "${symbol.name}" has ${incoming.length} incoming reference(s) — not safe to remove. Referenced by: ${edgeDescriptions.join(', ')}${suffix}`;
      return result;
    }
  }

  // 3. Get file info
  const symbolFile = store.getFileById(symbol.file_id);
  if (!symbolFile) {
    result.error = `File not found for symbol ${symbolId}`;
    return result;
  }

  if (symbol.line_start == null || symbol.line_end == null) {
    result.error = `Symbol "${symbol.name}" has no line range — cannot remove`;
    return result;
  }

  const filePath = path.resolve(projectRoot, symbolFile.path);
  if (!fs.existsSync(filePath)) {
    result.error = `File not found on disk: ${filePath}`;
    return result;
  }

  const lines = readLines(filePath);
  const startLine = symbol.line_start - 1; // 0-indexed
  const endLine = symbol.line_end; // line_end is inclusive, but slice end is exclusive

  if (startLine < 0 || endLine > lines.length) {
    result.error = `Line range ${symbol.line_start}-${symbol.line_end} out of bounds (file has ${lines.length} lines)`;
    return result;
  }

  // 4. Check for decorators/JSDoc above the symbol
  let actualStart = startLine;
  // Walk backwards to include decorators (@...) and JSDoc (/** ... */)
  while (actualStart > 0) {
    const prevLine = lines[actualStart - 1].trim();
    if (
      prevLine.startsWith('@') || // decorator
      prevLine.startsWith('*') || // JSDoc continuation
      prevLine.startsWith('/**') || // JSDoc start
      prevLine === '*/' || // JSDoc end
      prevLine.startsWith('//') || // comment
      prevLine.startsWith('#') // Python decorator / comment
    ) {
      actualStart--;
    } else {
      break;
    }
  }

  // Record the edit
  const removedLines = lines.slice(actualStart, endLine);
  result.edits.push({
    file: toPosix(symbolFile.path),
    original_line: actualStart + 1,
    original_text: removedLines.map((l) => l.trimStart()).join('\n'),
    new_text: '(removed)',
  });

  if (!dryRun) {
    // 5. Remove the lines
    lines.splice(actualStart, endLine - actualStart);

    // Clean up: remove consecutive blank lines left behind
    for (let i = lines.length - 1; i > 0; i--) {
      if (lines[i].trim() === '' && lines[i - 1].trim() === '') {
        lines.splice(i, 1);
      }
    }

    writeLines(filePath, lines);
  }

  // 6. Check for orphaned imports — if the symbol was the only export
  // used from its file, importing files may have unused imports.
  // We only warn about this; the user can run dead-code detection again.
  const fileSymbols = store.getSymbolsByFile(symbol.file_id);
  const remainingExports = fileSymbols.filter((s) => {
    if (s.id === symbol.id) return false;
    if (!s.metadata) return false;
    const meta = typeof s.metadata === 'string' ? JSON.parse(s.metadata) : s.metadata;
    return meta?.exported;
  });

  if (remainingExports.length === 0) {
    const importers = getImportingFiles(store, symbol.file_id, projectRoot);
    if (importers.length > 0) {
      result.warnings.push(
        `Removed the last exported symbol from ${toPosix(symbolFile.path)}. ` +
          `${importers.length} file(s) still import from it — review for unused imports: ` +
          importers.map((f) => toPosix(path.relative(projectRoot, f.filePath))).join(', '),
      );
    }
  }

  result.success = true;
  result.files_modified = [toPosix(symbolFile.path)];

  return result;
}

// ════════════════════════════════════════════════════════════════════════
// TOOL 3: EXTRACT FUNCTION
// ════════════════════════════════════════════════════════════════════════

/**
 * Extract a range of lines [startLine, endLine] (1-based, inclusive) from a file
 * into a new named function, computing the parameter list and return value via
 * AST free-variable analysis (see extract-function-ast.ts).
 *
 *  - parameters  = identifiers read in the slice but declared outside it
 *                  (including closure captures of outer variables)
 *  - return value = a binding declared in the slice and used after it
 *
 * The new helper is inserted immediately after the enclosing function, and the
 * slice is replaced by a call (binding the return value when present). dry_run
 * returns the edit preview without writing.
 */
export function extractFunction(
  store: Store,
  projectRoot: string,
  filePath: string,
  startLine: number,
  endLine: number,
  functionName: string,
  dryRun = false,
): RefactorResult {
  // `store` is unused for now — extraction is purely AST-driven. Kept on the
  // signature for parity with the other refactor tools and future binding
  // resolution (SCIP/LSP) to raise confidence.
  void store;

  const result: RefactorResult = {
    success: false,
    tool: 'extract_function',
    edits: [],
    files_modified: [],
    warnings: [],
  };

  const absPath = path.resolve(projectRoot, filePath);
  if (!fs.existsSync(absPath)) {
    result.error = `File not found: ${filePath}`;
    return result;
  }

  const lines = readLines(absPath);
  if (startLine < 1 || endLine > lines.length || startLine > endLine) {
    result.error = `Invalid line range ${startLine}-${endLine} (file has ${lines.length} lines)`;
    return result;
  }

  const source = fs.readFileSync(absPath, 'utf-8');
  const plan = planExtractFunction(filePath, source, startLine, endLine, functionName);
  if (isExtractError(plan)) {
    result.error = plan.error;
    return result;
  }

  // Build the new file content: replace the slice with the call site and insert
  // the helper after the enclosing function.
  const srcLines = source.split('\n');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  // 1. Replace the slice (startLine..endLine, 1-based) with the call site.
  const before = srcLines.slice(0, startLine - 1);
  const after = srcLines.slice(endLine);
  const callSiteLines = plan.callSite.split('\n');

  // 2. Insert the helper after the enclosing function's end line. Because we
  //    removed (endLine - startLine + 1) lines and added callSite lines, the
  //    enclosing end line shifts. Compute the new index in the rebuilt array.
  const removedCount = endLine - startLine + 1;
  const addedCount = callSiteLines.length;
  const shift = addedCount - removedCount;
  // enclosingEndLine is 0-based; convert to 1-based array index after the slice
  // replacement.
  const enclosingEnd1 = plan.enclosingEndLine + 1 + shift;

  const rebuilt = [...before, ...callSiteLines, ...after];

  // Insert a blank line + helper after the enclosing function.
  const helperBlock = ['', ...plan.helperSource.split('\n')];
  const insertAt = Math.min(enclosingEnd1, rebuilt.length);
  const finalLines = [...rebuilt.slice(0, insertAt), ...helperBlock, ...rebuilt.slice(insertAt)];

  const newContent = finalLines.join(eol);

  // Record the structured edits for preview.
  result.edits.push({
    file: toPosix(path.relative(projectRoot, absPath)),
    original_line: startLine,
    original_text: lines.slice(startLine - 1, endLine).join('\n'),
    new_text: plan.callSite.trimStart(),
  });
  result.edits.push({
    file: toPosix(path.relative(projectRoot, absPath)),
    original_line: enclosingEnd1,
    original_text: '',
    new_text: plan.helperSource,
  });

  result.extracted_params = plan.params;
  result.return_value = plan.returnValue;
  result.confidence = plan.confidence;
  if (plan.confidence === 'low') {
    result.warnings.push(
      'Low confidence: scope analysis could not fully resolve bindings — review the parameter list.',
    );
  }

  if (!dryRun) {
    try {
      fs.writeFileSync(absPath, newContent, 'utf-8');
      result.files_modified.push(toPosix(path.relative(projectRoot, absPath)));
    } catch (e) {
      result.error = `Failed to write ${filePath}: ${(e as Error).message}`;
      return result;
    }
  }

  result.success = true;
  return result;
}

// ════════════════════════════════════════════════════════════════════════
// TOOL 4: APPLY CODEMOD
// ════════════════════════════════════════════════════════════════════════

interface CodemodMatch {
  file: string;
  line: number;
  original: string;
  replaced: string;
  context_before: string[];
  context_after: string[];
}

interface CodemodResult {
  success: boolean;
  tool: 'apply_codemod';
  dry_run: boolean;
  /** Which engine ran: 'ast' (ast-grep, syntax-aware) or 'regex' (text). */
  engine_used: 'ast' | 'regex';
  matches: CodemodMatch[];
  files_modified: string[];
  total_replacements: number;
  total_files: number;
  warnings: string[];
  error?: string;
}

/**
 * Codemod engine selection.
 *  - 'auto'  (default): AST for supported code files when `pattern` looks like a
 *    valid ast-grep pattern (contains metavariables, no regex metacharacters);
 *    otherwise the regex engine. Per-file: a non-AST file always uses regex.
 *  - 'ast'   : force the ast-grep engine (errors if no supported files match).
 *  - 'regex' : force the legacy text-regex engine.
 */
export type CodemodEngine = 'auto' | 'ast' | 'regex';

const CODEMOD_MAX_PREVIEW = 20;
const CODEMOD_LARGE_THRESHOLD = 20;
const CODEMOD_CONTEXT_LINES = 2;

export async function applyCodemod(
  projectRoot: string,
  pattern: string,
  replacement: string,
  filePattern: string,
  options: {
    dryRun: boolean;
    confirmLarge?: boolean;
    filterContent?: string;
    multiline?: boolean;
    engine?: CodemodEngine;
  },
): Promise<CodemodResult> {
  const requestedEngine: CodemodEngine = options.engine ?? 'auto';
  const result: CodemodResult = {
    success: false,
    tool: 'apply_codemod',
    dry_run: options.dryRun,
    // Provisional — refined once we know which engine actually ran on the
    // matched files. For 'regex'/'ast' it's fixed; for 'auto' we report the
    // engine that produced the matches (AST when any AST pattern fired).
    engine_used: requestedEngine === 'ast' ? 'ast' : 'regex',
    matches: [],
    files_modified: [],
    total_replacements: 0,
    total_files: 0,
    warnings: [],
  };

  // 1. Pre-compile regex when the regex engine may be used. In 'ast' mode we
  // never touch regex, so an invalid regex there is irrelevant.
  let regex: RegExp | null = null;
  if (requestedEngine !== 'ast') {
    try {
      const flags = options.multiline ? 'gms' : 'gm';
      regex = new RegExp(pattern, flags);
    } catch (e) {
      result.error = `Invalid regex pattern: ${(e as Error).message}`;
      return result;
    }
  }

  // Decide, for 'auto', whether the pattern is AST-shaped at all. When it is
  // not, no file should use the AST engine even if it is a supported language.
  const patternIsAstShaped =
    requestedEngine === 'ast' || (requestedEngine === 'auto' && looksLikeAstPattern(pattern));

  // 2. Glob files
  let files: string[];
  try {
    files = fg.sync(filePattern, {
      cwd: projectRoot,
      ignore: SKIP_DIRS.map((d) => `**/${d}/**`),
      onlyFiles: true,
      absolute: false,
    });
  } catch (e) {
    result.error = `Invalid file pattern: ${(e as Error).message}`;
    return result;
  }

  // Filter out binary files
  files = files.filter((f) => !BINARY_EXTENSIONS.has(path.extname(f).toLowerCase()));

  if (files.length === 0) {
    result.error = `No files matched pattern: ${filePattern}`;
    return result;
  }

  // 3. Scan files for matches. Each file is routed to the AST engine (when its
  //    language is supported AND the pattern is AST-shaped) or the regex engine.
  const allMatches: CodemodMatch[] = [];
  const filesWithMatches = new Set<string>();
  // Remember which engine handled each matched file so apply mode re-runs the
  // same transform (AST commitEdits vs regex replace).
  const fileEngine = new Map<string, 'ast' | 'regex'>();
  let anyAstUsed = false;
  let anyRegexUsed = false;

  let scanned = 0;
  for (const relPath of files) {
    // Yield to the event loop every 64 files so large monorepos don't block stdio.
    await maybeYield(scanned, 64);
    scanned++;
    const absPath = path.resolve(projectRoot, relPath);
    if (!fs.existsSync(absPath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      result.warnings.push(`Could not read: ${relPath}`);
      continue;
    }

    // Optional content filter — skip files that don't contain the filter string
    if (options.filterContent && !content.includes(options.filterContent)) {
      continue;
    }

    const lang = patternIsAstShaped ? astLangForFile(relPath) : null;
    const useAst = lang !== null && requestedEngine !== 'regex';

    if (useAst && lang !== null) {
      // ── AST engine ──────────────────────────────────────────────────────
      let astRes: AstCodemodFileResult;
      try {
        astRes = runAstCodemodOnSource(lang, content, pattern, replacement);
      } catch (e) {
        // Pattern not parseable as ast-grep on this file.
        if (requestedEngine === 'ast') {
          result.warnings.push(`AST parse failed for ${relPath}: ${(e as Error).message}`);
          continue;
        }
        // 'auto' with an AST-shaped pattern that nonetheless failed to parse:
        // fall back to regex for this file if we have one.
        if (regex) {
          scanFileWithRegex(
            relPath,
            content,
            regex,
            replacement,
            options.multiline ?? false,
            allMatches,
            filesWithMatches,
            fileEngine,
            result,
          );
          if (filesWithMatches.has(relPath)) anyRegexUsed = true;
        }
        continue;
      }

      if (astRes.matchCount === 0) continue;

      filesWithMatches.add(relPath);
      fileEngine.set(relPath, 'ast');
      anyAstUsed = true;
      result.total_replacements += astRes.matchCount;

      const lines = content.split('\n');
      for (const m of astRes.matches) {
        if (allMatches.length >= CODEMOD_MAX_PREVIEW) break;
        allMatches.push({
          file: relPath,
          line: m.line,
          original: m.original.length > 200 ? `${m.original.slice(0, 200)}…` : m.original,
          replaced: m.replaced.length > 200 ? `${m.replaced.slice(0, 200)}…` : m.replaced,
          context_before: lines.slice(Math.max(0, m.line - 1 - CODEMOD_CONTEXT_LINES), m.line - 1),
          context_after: lines.slice(m.line, m.line + CODEMOD_CONTEXT_LINES),
        });
      }
    } else if (regex) {
      // ── Regex engine ────────────────────────────────────────────────────
      scanFileWithRegex(
        relPath,
        content,
        regex,
        replacement,
        options.multiline ?? false,
        allMatches,
        filesWithMatches,
        fileEngine,
        result,
      );
      if (filesWithMatches.has(relPath) && fileEngine.get(relPath) === 'regex') {
        anyRegexUsed = true;
      }
    }
  }

  result.total_files = filesWithMatches.size;

  // Report the engine that actually produced matches. AST wins when any AST
  // file matched; otherwise regex. (In 'ast'/'regex' modes this is fixed.)
  if (requestedEngine === 'ast') {
    result.engine_used = 'ast';
  } else if (requestedEngine === 'regex') {
    result.engine_used = 'regex';
  } else {
    result.engine_used = anyAstUsed ? 'ast' : 'regex';
    void anyRegexUsed;
  }

  if (allMatches.length === 0 && filesWithMatches.size === 0) {
    // Zero matches is a normal, non-exceptional outcome (e.g. checking whether
    // a migration was already applied) — it must NOT be reported as a failure.
    // Doing so previously set `success: false`, which the MCP tool handler
    // (src/tools/register/refactoring.ts) surfaces as `isError: true`, turning
    // "nothing to change here" into a hard tool-call error. Report success
    // with an informational warning instead.
    result.success = true;
    result.warnings.push(`No matches found for pattern in ${files.length} files scanned`);
    return result;
  }

  // 4. Large change guard
  if (filesWithMatches.size > CODEMOD_LARGE_THRESHOLD && !options.confirmLarge) {
    result.matches = allMatches;
    result.warnings.push(
      `Affects ${filesWithMatches.size} files (>${CODEMOD_LARGE_THRESHOLD}). ` +
        `Re-run with confirm_large: true to proceed, or narrow file_pattern.`,
    );
    // Return as dry_run preview regardless
    result.dry_run = true;
    result.success = true;
    return result;
  }

  // 5. Dry run — just return preview
  if (options.dryRun) {
    result.matches = allMatches;
    result.success = true;
    return result;
  }

  // 6. Apply changes — re-run the same engine that matched each file.
  for (const relPath of filesWithMatches) {
    const absPath = path.resolve(projectRoot, relPath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      let newContent = content;

      if (fileEngine.get(relPath) === 'ast') {
        const lang = astLangForFile(relPath);
        if (lang !== null) {
          newContent = runAstCodemodOnSource(lang, content, pattern, replacement).newSource;
        }
      } else {
        const flags = options.multiline ? 'gms' : 'gm';
        const freshRegex = new RegExp(pattern, flags);
        newContent = content.replace(freshRegex, replacement);
      }

      if (newContent !== content) {
        fs.writeFileSync(absPath, newContent, 'utf-8');
        result.files_modified.push(relPath);
      }
    } catch (e) {
      result.warnings.push(`Failed to write ${relPath}: ${(e as Error).message}`);
    }
  }

  result.matches = allMatches;
  result.success = true;
  return result;
}

/**
 * Regex-engine scan of a single file. Mirrors the original line-by-line /
 * multiline behaviour. Mutates `allMatches`, `filesWithMatches`, `fileEngine`,
 * and `result.total_replacements` in place to keep the caller flat.
 */
function scanFileWithRegex(
  relPath: string,
  content: string,
  regex: RegExp,
  replacement: string,
  multiline: boolean,
  allMatches: CodemodMatch[],
  filesWithMatches: Set<string>,
  fileEngine: Map<string, 'ast' | 'regex'>,
  result: CodemodResult,
): void {
  const lines = content.split('\n');

  if (multiline) {
    regex.lastIndex = 0;
    if (!regex.test(content)) return;

    filesWithMatches.add(relPath);
    fileEngine.set(relPath, 'regex');

    regex.lastIndex = 0;
    let matchCount = 0;
    const matchPositions: { index: number; match: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      matchPositions.push({ index: m.index, match: m[0] });
      matchCount++;
      if (m[0].length === 0) regex.lastIndex++;
    }

    for (const pos of matchPositions.slice(0, CODEMOD_MAX_PREVIEW - allMatches.length)) {
      const lineNum = content.slice(0, pos.index).split('\n').length;
      const original = pos.match;
      regex.lastIndex = 0;
      const replaced = original.replace(regex, replacement);
      allMatches.push({
        file: relPath,
        line: lineNum,
        original: original.length > 200 ? `${original.slice(0, 200)}…` : original,
        replaced: replaced.length > 200 ? `${replaced.slice(0, 200)}…` : replaced,
        context_before: lines.slice(Math.max(0, lineNum - 1 - CODEMOD_CONTEXT_LINES), lineNum - 1),
        context_after: lines.slice(lineNum, lineNum + CODEMOD_CONTEXT_LINES),
      });
    }
    result.total_replacements += matchCount;
  } else {
    let fileMatchCount = 0;
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;

      filesWithMatches.add(relPath);
      fileEngine.set(relPath, 'regex');
      fileMatchCount++;

      regex.lastIndex = 0;
      const newLine = lines[i].replace(regex, replacement);

      if (allMatches.length < CODEMOD_MAX_PREVIEW) {
        allMatches.push({
          file: relPath,
          line: i + 1,
          original: lines[i],
          replaced: newLine,
          context_before: lines.slice(Math.max(0, i - CODEMOD_CONTEXT_LINES), i),
          context_after: lines.slice(i + 1, i + 1 + CODEMOD_CONTEXT_LINES),
        });
      }
    }
    result.total_replacements += fileMatchCount;
  }
}
