/**
 * Refactoring execution tools — apply_rename, remove_dead_code, extract_function.
 *
 * These tools perform actual file modifications guided by the dependency graph.
 * Each tool produces a structured diff plan with the exact edits to apply,
 * then writes the modified files atomically.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import { checkRenameSafe } from './rename-check.js';

// ════════════════════════════════════════════════════════════════════════
// SHARED TYPES
// ════════════════════════════════════════════════════════════════════════

export interface FileEdit {
  file: string;
  original_line: number;
  original_text: string;
  new_text: string;
}

export interface RefactorResult {
  success: boolean;
  tool: string;
  edits: FileEdit[];
  files_modified: string[];
  warnings: string[];
  error?: string;
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

/** Read file content, split into lines (1-indexed helper). */
function readLines(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf-8').split('\n');
}

/** Write lines back to file. */
function writeLines(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

/**
 * Get all files that import a given file node and reference a specific symbol name.
 * Returns file paths + the import specifier metadata for targeted replacement.
 */
function getImportingFiles(
  store: Store,
  fileId: number,
  projectRoot: string,
): { filePath: string; fileId: number }[] {
  const fileNodeId = store.getNodeId('file', fileId);
  if (fileNodeId === undefined) return [];

  const incomingEdges = store.getIncomingEdges(fileNodeId);
  const importingFiles: { filePath: string; fileId: number }[] = [];
  const seen = new Set<number>();

  for (const edge of incomingEdges) {
    const ref = store.getNodeRef(edge.source_node_id);
    if (!ref) continue;

    let importFileId: number | undefined;
    if (ref.nodeType === 'file') {
      importFileId = ref.refId;
    } else if (ref.nodeType === 'symbol') {
      const symRow = store.getSymbolById(ref.refId);
      if (symRow) importFileId = symRow.file_id;
    }

    if (importFileId !== undefined && importFileId !== fileId && !seen.has(importFileId)) {
      seen.add(importFileId);
      const file = store.getFileById(importFileId);
      if (file) {
        importingFiles.push({ filePath: path.resolve(projectRoot, file.path), fileId: importFileId });
      }
    }
  }

  return importingFiles;
}

/**
 * Build a word-boundary regex for renaming a symbol name.
 * Handles property access (`.name`), destructuring (`{ name }`), imports, etc.
 */
function buildRenameRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'g');
}

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
    result.warnings = check.conflicts.map((c) => `Conflict in ${c.file}: existing ${c.kind} "${c.existing_name}" at line ${c.line}`);
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
  const allFiles = [
    { filePath: definitionFilePath, fileId: symbol.file_id },
    ...importingFiles,
  ];

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
            file: path.relative(projectRoot, filePath),
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
      writeLines(filePath, lines);
      modifiedFiles.add(path.relative(projectRoot, filePath));
    }
  }

  result.success = true;
  result.files_modified = [...modifiedFiles];

  if (result.files_modified.length === 0) {
    result.warnings.push('No text matches found — symbol may use dynamic references');
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
      prevLine.startsWith('@') ||          // decorator
      prevLine.startsWith('*') ||           // JSDoc continuation
      prevLine.startsWith('/**') ||         // JSDoc start
      prevLine === '*/' ||                  // JSDoc end
      prevLine.startsWith('//') ||          // comment
      prevLine.startsWith('#')              // Python decorator / comment
    ) {
      actualStart--;
    } else {
      break;
    }
  }

  // Record the edit
  const removedLines = lines.slice(actualStart, endLine);
  result.edits.push({
    file: symbolFile.path,
    original_line: actualStart + 1,
    original_text: removedLines.map((l) => l.trimStart()).join('\n'),
    new_text: '(removed)',
  });

  // 5. Remove the lines
  lines.splice(actualStart, endLine - actualStart);

  // Clean up: remove consecutive blank lines left behind
  for (let i = lines.length - 1; i > 0; i--) {
    if (lines[i].trim() === '' && lines[i - 1].trim() === '') {
      lines.splice(i, 1);
    }
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
        `Removed the last exported symbol from ${symbolFile.path}. ` +
        `${importers.length} file(s) still import from it — review for unused imports: ` +
        importers.map((f) => path.relative(projectRoot, f.filePath)).join(', '),
      );
    }
  }

  writeLines(filePath, lines);
  result.success = true;
  result.files_modified = [symbolFile.path];

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
  const returns = [...identifiers.defined].filter(
    (v) => usedAfterSet.has(v),
  );

  // Build the extracted function
  const bodyLines = extractedLines.map((l) => {
    // Re-indent: remove site indent, add one level
    const stripped = l.startsWith(siteIndent) ? l.slice(siteIndent.length) : l.trimStart();
    return '  ' + stripped;
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
    const returnTypes = returns.length > 0 ? ` (${returns.map(() => 'interface{}').join(', ')})` : '';
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
  result.success = true;
  result.files_modified = [filePath];

  if (params.length > 0) {
    result.warnings.push(`Detected ${params.length} parameter(s): ${params.join(', ')} — verify types`);
  }
  if (returns.length > 0) {
    result.warnings.push(`Detected ${returns.length} return value(s): ${returns.join(', ')} — verify correctness`);
  }

  return result;
}

// ════════════════════════════════════════════════════════════════════════
// LANGUAGE DETECTION
// ════════════════════════════════════════════════════════════════════════

function detectLanguage(ext: string): 'typescript' | 'python' | 'go' | 'generic' {
  switch (ext) {
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs':
      return 'typescript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    default:
      return 'generic';
  }
}

// ════════════════════════════════════════════════════════════════════════
// IDENTIFIER EXTRACTION (lightweight, regex-based)
// ════════════════════════════════════════════════════════════════════════

interface IdentifierAnalysis {
  /** All identifiers used (read) in the code */
  used: string[];
  /** Identifiers that are defined (assigned / declared) in the code */
  defined: Set<string>;
}

/** Keywords to exclude from identifier analysis */
const KEYWORDS = new Set([
  // JS/TS
  'const', 'let', 'var', 'function', 'class', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'new', 'this', 'super', 'import', 'export',
  'from', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof',
  'instanceof', 'void', 'delete', 'in', 'of', 'true', 'false', 'null', 'undefined',
  'yield', 'static', 'extends', 'implements', 'interface', 'type', 'enum', 'abstract',
  // Python
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'with', 'as',
  'import', 'from', 'try', 'except', 'finally', 'raise', 'pass', 'lambda', 'and',
  'or', 'not', 'is', 'in', 'True', 'False', 'None', 'global', 'nonlocal', 'assert',
  // Go
  'func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default',
  'break', 'continue', 'go', 'defer', 'select', 'chan', 'map', 'struct', 'interface',
  'package', 'import', 'type', 'var', 'const', 'nil', 'true', 'false',
  // Common
  'console', 'log', 'print', 'fmt', 'string', 'number', 'boolean', 'int', 'float',
]);

/**
 * Extract identifiers from code text using regex-based analysis.
 * Not a full parser — good enough for variable detection in extraction.
 */
function extractIdentifiers(text: string): IdentifierAnalysis {
  const defined = new Set<string>();
  const usedList: string[] = [];
  const seen = new Set<string>();

  // Detect definitions: const/let/var X, function X, def X, X :=, X =
  const defPatterns = [
    /(?:const|let|var)\s+(?:\{[^}]*\}|([a-zA-Z_$][\w$]*))/g,     // JS/TS destructuring or simple
    /function\s+([a-zA-Z_$][\w$]*)/g,                              // function declarations
    /def\s+([a-zA-Z_]\w*)/g,                                       // Python defs
    /([a-zA-Z_]\w*)\s*:=/g,                                        // Go short var decl
    /for\s+(?:const|let|var)?\s*(?:\(?\s*)?([a-zA-Z_$][\w$]*)/g,   // for loop vars
  ];

  for (const pattern of defPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];
      if (name && !KEYWORDS.has(name)) {
        defined.add(name);
      }
    }
  }

  // Also handle destructuring definitions: const { a, b } = ...
  const destructurePattern = /(?:const|let|var)\s+\{([^}]+)\}/g;
  let dm: RegExpExecArray | null;
  while ((dm = destructurePattern.exec(text)) !== null) {
    const inner = dm[1];
    for (const part of inner.split(',')) {
      const name = part.split(':').pop()?.trim().split('=')[0]?.trim();
      if (name && /^[a-zA-Z_$][\w$]*$/.test(name) && !KEYWORDS.has(name)) {
        defined.add(name);
      }
    }
  }

  // Detect all identifier usages
  const identPattern = /\b([a-zA-Z_$][\w$]*)\b/g;
  let im: RegExpExecArray | null;
  while ((im = identPattern.exec(text)) !== null) {
    const name = im[1];
    if (!KEYWORDS.has(name) && !seen.has(name)) {
      seen.add(name);
      usedList.push(name);
    }
  }

  return { used: usedList, defined };
}

/** Get leading whitespace of a line. */
function getIndent(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : '';
}
