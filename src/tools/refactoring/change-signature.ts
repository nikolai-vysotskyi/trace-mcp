/**
 * Change signature refactoring — modify function parameters and update all call sites.
 *
 * Supports: add_param, remove_param, rename_param, reorder_params.
 * Works by parsing parameter lists with paren-balancing, then rewriting
 * both the definition and all call sites found via the dependency graph.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';
import type { FileEdit, RefactorResult } from './shared.js';
import { detectLanguage, readLines, toPosix, writeLines } from './shared.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface SignatureChange {
  add_param?: { name: string; type?: string; default_value?: string; position?: number };
  remove_param?: { name: string };
  rename_param?: { old_name: string; new_name: string };
  reorder_params?: string[];
}

export interface ParsedParam {
  name: string;
  type?: string;
  default_value?: string;
  spread: boolean;
  /** Full original text of this parameter */
  raw: string;
}

// ════════════════════════════════════════════════════════════════════════
// MAIN FUNCTION
// ════════════════════════════════════════════════════════════════════════

export function changeSignature(
  store: Store,
  projectRoot: string,
  symbolId: string,
  changes: SignatureChange[],
  dryRun = true,
): RefactorResult {
  const result: RefactorResult = {
    success: false,
    tool: 'change_signature',
    edits: [],
    files_modified: [],
    warnings: [],
  };

  if (changes.length === 0) {
    result.error = 'No changes specified';
    return result;
  }

  // 1. Resolve the symbol
  const symbol = store.getSymbolBySymbolId(symbolId);
  if (!symbol) {
    result.error = `Symbol not found: ${symbolId}`;
    return result;
  }

  const validKinds = new Set(['function', 'method', 'arrow_function', 'constructor']);
  if (!validKinds.has(symbol.kind)) {
    result.error = `Symbol "${symbol.name}" is a ${symbol.kind}, not a function/method — cannot change signature`;
    return result;
  }

  if (symbol.line_start == null || symbol.line_end == null) {
    result.error = `Symbol "${symbol.name}" has no line range`;
    return result;
  }

  // 2. Get the file and read the definition
  const symbolFile = store.getFileById(symbol.file_id);
  if (!symbolFile) {
    result.error = `File not found for symbol ${symbolId}`;
    return result;
  }

  const filePath = path.resolve(projectRoot, symbolFile.path);
  if (!fs.existsSync(filePath)) {
    result.error = `File not found on disk: ${symbolFile.path}`;
    return result;
  }

  const ext = path.extname(symbolFile.path).toLowerCase();
  const lang = detectLanguage(ext);

  const lines = readLines(filePath);

  // 3. Extract the parameter list from the definition
  // Find the opening paren starting from the symbol's line_start
  const defStartIdx = symbol.line_start - 1;
  const defRegion = lines.slice(defStartIdx, symbol.line_end).join('\n');

  const parenResult = extractParenContent(defRegion);
  if (!parenResult) {
    result.error = `Could not find parameter list in definition of "${symbol.name}"`;
    return result;
  }

  // 4. Parse existing parameters
  const existingParams = parseParamList(parenResult.content, lang);

  // 5. Apply changes
  let newParams = [...existingParams];

  for (const change of changes) {
    if (change.add_param) {
      const { name, type, default_value, position } = change.add_param;
      const newParam: ParsedParam = {
        name,
        type,
        default_value,
        spread: false,
        raw: buildParamText(name, type, default_value, lang),
      };
      const idx = position != null ? Math.min(position, newParams.length) : newParams.length;
      newParams.splice(idx, 0, newParam);
    }

    if (change.remove_param) {
      const idx = newParams.findIndex((p) => p.name === change.remove_param!.name);
      if (idx === -1) {
        result.warnings.push(
          `Parameter "${change.remove_param.name}" not found in signature — skipped`,
        );
      } else {
        newParams.splice(idx, 1);
      }
    }

    if (change.rename_param) {
      const param = newParams.find((p) => p.name === change.rename_param!.old_name);
      if (!param) {
        result.warnings.push(
          `Parameter "${change.rename_param.old_name}" not found in signature — skipped`,
        );
      } else {
        param.name = change.rename_param.new_name;
        param.raw = buildParamText(param.name, param.type, param.default_value, lang);
      }
    }

    if (change.reorder_params) {
      const ordered: ParsedParam[] = [];
      for (const name of change.reorder_params) {
        const param = newParams.find((p) => p.name === name);
        if (param) {
          ordered.push(param);
        } else {
          result.warnings.push(`Parameter "${name}" not found during reorder — skipped`);
        }
      }
      // Add any params not in the reorder list at the end
      for (const p of newParams) {
        if (!ordered.includes(p)) {
          ordered.push(p);
        }
      }
      newParams = ordered;
    }
  }

  // 6. Build new parameter list text
  const newParamText = newParams.map((p) => p.raw).join(', ');
  const _oldParamText = parenResult.content;

  // Build the new definition region
  const newDefRegion =
    defRegion.slice(0, parenResult.openOffset + 1) +
    newParamText +
    defRegion.slice(parenResult.closeOffset);

  // Record the edit for the definition
  const newDefLines = newDefRegion.split('\n');
  result.edits.push({
    file: toPosix(symbolFile.path),
    original_line: symbol.line_start,
    original_text: defRegion
      .split('\n')
      .map((l) => l.trimStart())
      .join('\n'),
    new_text: newDefLines.map((l) => l.trimStart()).join('\n'),
  });

  // Apply definition change
  if (!dryRun) {
    // Replace the definition lines
    lines.splice(defStartIdx, symbol.line_end - defStartIdx, ...newDefLines);
    writeLines(filePath, lines);
    result.files_modified.push(toPosix(symbolFile.path));
  } else {
    result.files_modified.push(toPosix(symbolFile.path));
  }

  // 7. Find and update all call sites
  const callSiteEdits = updateCallSites(
    store,
    projectRoot,
    symbol,
    existingParams,
    newParams,
    changes,
    lang,
    dryRun,
  );
  result.edits.push(...callSiteEdits.edits);
  result.files_modified.push(...callSiteEdits.files);
  result.warnings.push(...callSiteEdits.warnings);

  // Deduplicate files_modified
  result.files_modified = [...new Set(result.files_modified)];
  result.success = true;
  return result;
}

// ════════════════════════════════════════════════════════════════════════
// PARAMETER PARSING
// ════════════════════════════════════════════════════════════════════════

/**
 * Extract content between matched parentheses, handling nesting.
 * Returns the content and offsets.
 */
function extractParenContent(
  text: string,
): { content: string; openOffset: number; closeOffset: number } | null {
  const openIdx = text.indexOf('(');
  if (openIdx === -1) return null;

  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) {
        return {
          content: text.slice(openIdx + 1, i),
          openOffset: openIdx,
          closeOffset: i,
        };
      }
    }
  }
  return null;
}

/**
 * Parse a comma-separated parameter list into structured params.
 * Handles type annotations, default values, spread/rest, and nested generics.
 */
export function parseParamList(paramText: string, lang: string): ParsedParam[] {
  const trimmed = paramText.trim();
  if (!trimmed) return [];

  const parts = splitArgs(trimmed);
  return parts.map((raw) => parseOneParam(raw.trim(), lang));
}

/**
 * Split argument/parameter text by commas, respecting nested parens, brackets, generics.
 */
export function splitArgs(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';
  let inString: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Track string literals
    if (inString) {
      current += ch;
      if (ch === inString && text[i - 1] !== '\\') {
        inString = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      current += ch;
      continue;
    }

    // Track nesting
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}' || ch === '>') {
      depth--;
      current += ch;
      continue;
    }

    // Split on comma at depth 0
    if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}

function parseOneParam(raw: string, lang: string): ParsedParam {
  const spread = raw.startsWith('...') || raw.startsWith('*');
  const cleanRaw = spread ? raw.replace(/^\.{3}|\*/, '') : raw;

  let name = '';
  let type: string | undefined;
  let default_value: string | undefined;

  if (lang === 'python') {
    // Python: name: type = default  OR  name=default  OR  *args  OR  **kwargs
    const eqIdx = cleanRaw.indexOf('=');
    const colonIdx = cleanRaw.indexOf(':');

    if (colonIdx !== -1 && (eqIdx === -1 || colonIdx < eqIdx)) {
      name = cleanRaw.slice(0, colonIdx).trim();
      const rest = cleanRaw.slice(colonIdx + 1).trim();
      if (eqIdx !== -1) {
        type = rest.slice(0, rest.indexOf('=')).trim();
        default_value = rest.slice(rest.indexOf('=') + 1).trim();
      } else {
        type = rest;
      }
    } else if (eqIdx !== -1) {
      name = cleanRaw.slice(0, eqIdx).trim();
      default_value = cleanRaw.slice(eqIdx + 1).trim();
    } else {
      name = cleanRaw.trim();
    }
  } else if (lang === 'go') {
    // Go: name type
    const parts = cleanRaw.trim().split(/\s+/);
    name = parts[0] ?? cleanRaw.trim();
    type = parts.slice(1).join(' ') || undefined;
  } else {
    // TypeScript/JavaScript: name: type = default  OR  name = default
    const eqIdx = findTopLevelChar(cleanRaw, '=');
    const colonIdx = findTopLevelChar(cleanRaw, ':');

    if (colonIdx !== -1 && (eqIdx === -1 || colonIdx < eqIdx)) {
      name = cleanRaw.slice(0, colonIdx).trim();
      const rest = cleanRaw.slice(colonIdx + 1);
      if (eqIdx !== -1) {
        type = rest.slice(0, rest.indexOf('=')).trim();
        default_value = rest.slice(rest.indexOf('=') + 1).trim();
      } else {
        type = rest.trim();
      }
    } else if (eqIdx !== -1) {
      name = cleanRaw.slice(0, eqIdx).trim();
      default_value = cleanRaw.slice(eqIdx + 1).trim();
    } else {
      name = cleanRaw.trim();
    }
  }

  return { name, type, default_value, spread, raw };
}

/** Find position of a character at nesting depth 0. */
function findTopLevelChar(text: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(' || text[i] === '<' || text[i] === '[' || text[i] === '{') depth++;
    else if (text[i] === ')' || text[i] === '>' || text[i] === ']' || text[i] === '}') depth--;
    else if (text[i] === ch && depth === 0) return i;
  }
  return -1;
}

function buildParamText(
  name: string,
  type?: string,
  default_value?: string,
  lang?: string,
): string {
  if (lang === 'python') {
    let text = name;
    if (type) text += `: ${type}`;
    if (default_value) text += ` = ${default_value}`;
    return text;
  }
  if (lang === 'go') {
    return type ? `${name} ${type}` : name;
  }
  // TypeScript/JavaScript
  let text = name;
  if (type) text += `: ${type}`;
  if (default_value) text += ` = ${default_value}`;
  return text;
}

// ════════════════════════════════════════════════════════════════════════
// CALL SITE UPDATES
// ════════════════════════════════════════════════════════════════════════

interface CallSiteResult {
  edits: FileEdit[];
  files: string[];
  warnings: string[];
}

function updateCallSites(
  store: Store,
  projectRoot: string,
  symbol: { id: number; name: string; file_id: number },
  oldParams: ParsedParam[],
  newParams: ParsedParam[],
  changes: SignatureChange[],
  lang: string,
  dryRun: boolean,
): CallSiteResult {
  const result: CallSiteResult = { edits: [], files: [], warnings: [] };

  // Find all files that reference this symbol via the dependency graph
  const symNodeId = store.getNodeId('symbol', symbol.id);
  if (symNodeId === undefined) return result;

  const incomingEdges = store.getIncomingEdges(symNodeId);
  const fileIds = new Set<number>();

  for (const edge of incomingEdges) {
    const ref = store.getNodeRef(edge.source_node_id);
    if (!ref) continue;
    if (ref.nodeType === 'symbol') {
      const s = store.getSymbolById(ref.refId);
      if (s) fileIds.add(s.file_id);
    } else if (ref.nodeType === 'file') {
      fileIds.add(ref.refId);
    }
  }

  // Also check the definition file itself (for recursive calls, etc.)
  fileIds.add(symbol.file_id);

  // Build the argument transformation plan
  const argPlan = buildArgTransformPlan(oldParams, newParams, changes);

  for (const fileId of fileIds) {
    const file = store.getFileById(fileId);
    if (!file) continue;

    const filePath = path.resolve(projectRoot, file.path);
    if (!fs.existsSync(filePath)) continue;

    const lines = readLines(filePath);
    let fileModified = false;

    // Scan for call sites: symbolName(
    const callPattern = new RegExp(`\\b${escapeRegex(symbol.name)}\\s*\\(`, 'g');

    for (let i = 0; i < lines.length; i++) {
      // Skip the definition line itself
      if (fileId === symbol.file_id && i === (symbol as { line_start: number }).line_start - 1)
        continue;

      callPattern.lastIndex = 0;
      const match = callPattern.exec(lines[i]);
      if (!match) continue;

      // Extract the full call arguments (may span multiple lines)
      const callStartCol = match.index + match[0].length - 1; // position of (
      const { args: callArgText, endLine, endCol } = extractCallArgs(lines, i, callStartCol);

      if (callArgText === null) {
        result.warnings.push(
          `Could not parse call args at ${toPosix(file.path)}:${i + 1} — skipped`,
        );
        continue;
      }

      // Parse existing call arguments
      const oldArgs = splitArgs(callArgText);

      // Transform arguments
      const newArgs = transformArgs(oldArgs, argPlan);

      // Rebuild the call
      const newArgText = newArgs.join(', ');
      if (callArgText === newArgText) continue;

      // Single-line case
      if (endLine === i) {
        const oldLine = lines[i];
        const before = oldLine.slice(0, callStartCol + 1);
        const after = oldLine.slice(endCol); // endCol points past ')'
        const newLine = `${before + newArgText})${after}`;

        result.edits.push({
          file: toPosix(file.path),
          original_line: i + 1,
          original_text: oldLine.trimStart(),
          new_text: newLine.trimStart(),
        });
        lines[i] = newLine;
        fileModified = true;
      } else {
        // Multi-line: replace from start to end
        const firstLine = lines[i];
        const newFirstLine = `${firstLine.slice(0, callStartCol + 1) + newArgText})`;
        result.edits.push({
          file: toPosix(file.path),
          original_line: i + 1,
          original_text: lines
            .slice(i, endLine + 1)
            .map((l) => l.trimStart())
            .join('\n'),
          new_text: newFirstLine.trimStart(),
        });
        // Replace multi-line with single line
        lines.splice(i, endLine - i + 1, newFirstLine);
        fileModified = true;
      }
    }

    if (fileModified) {
      if (!dryRun) {
        writeLines(filePath, lines);
      }
      result.files.push(toPosix(file.path));
    }
  }

  return result;
}

interface ArgTransformPlan {
  /** For each position in the old arg list, what to do */
  removals: Set<number>;
  /** Renames: old position → new arg text */
  renames: Map<number, string>;
  /** Additions: position → text */
  additions: { position: number; text: string }[];
  /** Reorder: new order of old indices */
  reorder: number[] | null;
}

function buildArgTransformPlan(
  oldParams: ParsedParam[],
  newParams: ParsedParam[],
  changes: SignatureChange[],
): ArgTransformPlan {
  const removals = new Set<number>();
  const renames = new Map<number, string>();
  const additions: { position: number; text: string }[] = [];
  let reorder: number[] | null = null;

  for (const change of changes) {
    if (change.remove_param) {
      const idx = oldParams.findIndex((p) => p.name === change.remove_param!.name);
      if (idx !== -1) removals.add(idx);
    }

    if (change.rename_param) {
      // For call sites, rename only matters for named/keyword args
      // Positional args don't need changes for rename
    }

    if (change.add_param) {
      const { name, type, default_value, position } = change.add_param;
      // Only add arg at call site if there's no default value
      if (!default_value) {
        const text = type ? `undefined /* ${name}: ${type} */` : `undefined /* ${name} */`;
        const pos = position != null ? position : oldParams.length;
        additions.push({ position: pos, text });
      }
    }

    if (change.reorder_params) {
      // Build mapping: new position index → old position index
      const order: number[] = [];
      for (const name of change.reorder_params) {
        const idx = oldParams.findIndex((p) => p.name === name);
        if (idx !== -1) order.push(idx);
      }
      // Add any remaining old params not in reorder list
      for (let i = 0; i < oldParams.length; i++) {
        if (!order.includes(i)) order.push(i);
      }
      reorder = order;
    }
  }

  return { removals, renames, additions, reorder };
}

function transformArgs(oldArgs: string[], plan: ArgTransformPlan): string[] {
  let args = oldArgs.map((a) => a.trim());

  // Apply reorder first
  if (plan.reorder) {
    const reordered: string[] = [];
    for (const idx of plan.reorder) {
      if (idx < args.length) {
        reordered.push(args[idx]);
      }
    }
    // If there were more args than params (e.g. rest args), keep extras
    for (let i = 0; i < args.length; i++) {
      if (!plan.reorder.includes(i)) {
        reordered.push(args[i]);
      }
    }
    args = reordered;
  }

  // Apply removals (by original index, so adjust after reorder)
  if (plan.removals.size > 0) {
    if (plan.reorder) {
      // After reorder, the removal indices need mapping
      const removalPositions = new Set<number>();
      for (const idx of plan.reorder) {
        if (plan.removals.has(idx)) {
          removalPositions.add(plan.reorder.indexOf(idx));
        }
      }
      args = args.filter((_, i) => !removalPositions.has(i));
    } else {
      args = args.filter((_, i) => !plan.removals.has(i));
    }
  }

  // Apply additions
  for (const { position, text } of plan.additions.sort((a, b) => b.position - a.position)) {
    // Insert in reverse order of position to keep indices stable
    const idx = Math.min(position, args.length);
    args.splice(idx, 0, text);
  }

  return args;
}

/**
 * Extract call arguments from a call expression starting at a given `(`.
 * Handles multi-line calls with paren balancing.
 */
function extractCallArgs(
  lines: string[],
  startLine: number,
  startCol: number,
): { args: string | null; endLine: number; endCol: number } {
  let depth = 0;
  let argText = '';

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    const startJ = i === startLine ? startCol : 0;

    for (let j = startJ; j < line.length; j++) {
      const ch = line[j];
      if (ch === '(') {
        depth++;
        if (depth === 1) continue; // Skip opening paren
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          return { args: argText, endLine: i, endCol: j + 1 };
        }
      }
      if (depth >= 1) {
        argText += ch;
      }
    }
    if (depth >= 1 && i < lines.length - 1) {
      argText += '\n';
    }
  }

  return { args: null, endLine: startLine, endCol: startCol };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
