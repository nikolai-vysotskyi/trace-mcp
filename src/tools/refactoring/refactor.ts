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
import { scanNonCodeFiles } from './non-code-scanner.js';
import { checkRenameSafe } from './rename-check.js';
import {
  BINARY_EXTENSIONS,
  buildRenameRegex,
  detectLanguage,
  extractIdentifiers,
  getImportingFiles,
  getIndent,
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

/**
 * Rename a symbol across all usages — the symbol's definition file and all
 * importing files. Runs check_rename first and aborts on conflicts.
 */
export function applyRename(
  store: Store,
  projectRoot: string,
  symbolId: string,
  newName: string,
  dryRun = false,
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

  // 4. Apply edits file by file
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
      if (!dryRun) {
        writeLines(filePath, lines);
      }
      modifiedFiles.add(toPosix(path.relative(projectRoot, filePath)));
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
 * Extract a range of lines from a file into a new named function.
 * Analyzes the extracted code for:
 * - Variables read but not defined in the range → become parameters
 * - Variables defined in the range and used after → become return values
 * - Imports needed by the extracted code
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

  // Detect language from file extension
  const ext = path.extname(filePath).toLowerCase();
  const lang = detectLanguage(ext);

  // Extract the target lines (0-indexed)
  const extractedLines = lines.slice(startLine - 1, endLine);
  const extractedText = extractedLines.join('\n');

  // Determine indentation of the extraction site
  const siteIndent = getIndent(lines[startLine - 1]);
  const baseIndent = siteIndent;

  // Analyze variables: identify free variables (params) and defined-then-used-later (returns)
  const identifiers = extractIdentifiers(extractedText);
  const beforeText = lines.slice(0, startLine - 1).join('\n');
  const afterText = lines.slice(endLine).join('\n');

  // Free variables: referenced in extracted code but defined before it
  const definedBefore = extractIdentifiers(beforeText);
  const usedAfter = extractIdentifiers(afterText);

  // Variables that the extracted code reads from the surrounding scope
  const params = identifiers.used.filter(
    (v) => definedBefore.defined.has(v) && !identifiers.defined.has(v),
  );

  // Variables that the extracted code defines and the remaining code uses
  const usedAfterSet = new Set(usedAfter.used);
  const returns = [...identifiers.defined].filter((v) => usedAfterSet.has(v));

  // Build the extracted function
  const bodyLines = extractedLines.map((l) => {
    // Re-indent: remove site indent, add one level
    const stripped = l.startsWith(siteIndent) ? l.slice(siteIndent.length) : l.trimStart();
    return `  ${stripped}`;
  });

  let functionDef: string;
  let callSite: string;

  if (lang === 'python') {
    // Python: def name(params): ... return
    const paramStr = params.join(', ');
    functionDef = `def ${functionName}(${paramStr}):\n${bodyLines.join('\n')}`;
    if (returns.length > 0) {
      const returnStr = returns.length === 1 ? returns[0] : `${returns.join(', ')}`;
      functionDef += `\n  return ${returnStr}`;
      const destructure = returns.length === 1 ? returns[0] : returns.join(', ');
      callSite = `${baseIndent}${destructure} = ${functionName}(${paramStr})`;
    } else {
      callSite = `${baseIndent}${functionName}(${paramStr})`;
    }
  } else if (lang === 'go') {
    // Go: func name(params) (returns) { ... }
    const paramStr = params.map((p) => `${p} interface{}`).join(', ');
    const returnTypes =
      returns.length > 0 ? ` (${returns.map(() => 'interface{}').join(', ')})` : '';
    functionDef = `func ${functionName}(${paramStr})${returnTypes} {\n${bodyLines.join('\n')}`;
    if (returns.length > 0) {
      functionDef += `\n  return ${returns.join(', ')}`;
    }
    functionDef += '\n}';
    if (returns.length > 0) {
      callSite = `${baseIndent}${returns.join(', ')} := ${functionName}(${params.join(', ')})`;
    } else {
      callSite = `${baseIndent}${functionName}(${params.join(', ')})`;
    }
  } else {
    // TypeScript / JavaScript default
    const paramStr = params.join(', ');
    functionDef = `function ${functionName}(${paramStr}) {\n${bodyLines.join('\n')}`;
    if (returns.length > 0) {
      if (returns.length === 1) {
        functionDef += `\n  return ${returns[0]};`;
      } else {
        functionDef += `\n  return { ${returns.join(', ')} };`;
      }
    }
    functionDef += '\n}';

    if (returns.length === 0) {
      callSite = `${baseIndent}${functionName}(${paramStr});`;
    } else if (returns.length === 1) {
      callSite = `${baseIndent}const ${returns[0]} = ${functionName}(${paramStr});`;
    } else {
      callSite = `${baseIndent}const { ${returns.join(', ')} } = ${functionName}(${paramStr});`;
    }
  }

  // Record edits
  result.edits.push({
    file: filePath,
    original_line: startLine,
    original_text: extractedLines.map((l) => l.trimStart()).join('\n'),
    new_text: `${callSite.trimStart()}\n\n// Extracted function:\n${functionDef}`,
  });

  if (!dryRun) {
    // Apply: replace extracted lines with call site, append function at end of file
    const newLines = [
      ...lines.slice(0, startLine - 1),
      callSite,
      ...lines.slice(endLine),
      '',
      functionDef,
      '',
    ];

    writeLines(absPath, newLines);
  }

  result.success = true;
  result.files_modified = [filePath];

  if (params.length > 0) {
    result.warnings.push(
      `Detected ${params.length} parameter(s): ${params.join(', ')} — verify types`,
    );
  }
  if (returns.length > 0) {
    result.warnings.push(
      `Detected ${returns.length} return value(s): ${returns.join(', ')} — verify correctness`,
    );
  }

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
  matches: CodemodMatch[];
  files_modified: string[];
  total_replacements: number;
  total_files: number;
  warnings: string[];
  error?: string;
}

const CODEMOD_MAX_PREVIEW = 20;
const CODEMOD_LARGE_THRESHOLD = 20;
const CODEMOD_CONTEXT_LINES = 2;

export function applyCodemod(
  projectRoot: string,
  pattern: string,
  replacement: string,
  filePattern: string,
  options: {
    dryRun: boolean;
    confirmLarge?: boolean;
    filterContent?: string;
    multiline?: boolean;
  },
): CodemodResult {
  const result: CodemodResult = {
    success: false,
    tool: 'apply_codemod',
    dry_run: options.dryRun,
    matches: [],
    files_modified: [],
    total_replacements: 0,
    total_files: 0,
    warnings: [],
  };

  // 1. Compile regex
  let regex: RegExp;
  try {
    const flags = options.multiline ? 'gms' : 'gm';
    regex = new RegExp(pattern, flags);
  } catch (e) {
    result.error = `Invalid regex pattern: ${(e as Error).message}`;
    return result;
  }

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

  // 3. Scan files for matches
  const allMatches: CodemodMatch[] = [];
  const filesWithMatches = new Set<string>();

  for (const relPath of files) {
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

    const lines = content.split('\n');

    // Find all matches line-by-line (non-multiline) or in full content (multiline)
    if (options.multiline) {
      // Multiline: work on full content
      regex.lastIndex = 0;
      if (!regex.test(content)) continue;

      filesWithMatches.add(relPath);

      // Count matches
      regex.lastIndex = 0;
      let matchCount = 0;
      const matchPositions: { index: number; match: string }[] = [];
      let m: RegExpExecArray | null;
      while ((m = regex.exec(content)) !== null) {
        matchPositions.push({ index: m.index, match: m[0] });
        matchCount++;
        if (m[0].length === 0) {
          regex.lastIndex++;
        }
      }

      // For preview, find line numbers of first few matches
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
          context_before: lines.slice(
            Math.max(0, lineNum - 1 - CODEMOD_CONTEXT_LINES),
            lineNum - 1,
          ),
          context_after: lines.slice(lineNum, lineNum + CODEMOD_CONTEXT_LINES),
        });
      }

      result.total_replacements += matchCount;
    } else {
      // Line-by-line matching
      let fileMatchCount = 0;
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[i])) continue;

        filesWithMatches.add(relPath);
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

  result.total_files = filesWithMatches.size;

  if (allMatches.length === 0) {
    result.error = `No matches found for pattern in ${files.length} files`;
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

  // 6. Apply changes
  for (const relPath of filesWithMatches) {
    const absPath = path.resolve(projectRoot, relPath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const flags = options.multiline ? 'gms' : 'gm';
      const freshRegex = new RegExp(pattern, flags);
      const newContent = content.replace(freshRegex, replacement);

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
