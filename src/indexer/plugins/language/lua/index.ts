/**
 * Lua Language Plugin — tree-sitter-based symbol extraction.
 *
 * Uses tree-sitter-lua (tree-sitter-wasms) for function/method extraction,
 * with regex fallback for patterns the grammar parses as ERROR nodes
 * (table field function assignments, local variable assignments, require calls).
 *
 * Extracts: global/local functions, module methods (Module.name / Module:name),
 * table field function assignments, local variables.
 * Imports: require() calls.
 */

import { createRequire } from 'node:module';
import { err, ok } from 'neverthrow';
import Parser from 'web-tree-sitter';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import type { TSNode } from '../../../../parser/tree-sitter.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawEdge,
  RawSymbol,
  SymbolKind,
} from '../../../../plugin-api/types.js';

const _require = createRequire(import.meta.url);
let _initPromise: Promise<void> | null = null;

/**
 * Create a fresh Lua parser for each parse call.
 *
 * The tree-sitter-lua WASM grammar has a bug where the Language instance
 * becomes corrupted after the first parse — subsequent parses produce ERROR
 * root nodes for valid code (e.g. `local function`). Loading the language
 * fresh each time is the only reliable workaround.
 */
async function createLuaParser(): Promise<Parser> {
  if (!_initPromise) _initPromise = Parser.init();
  await _initPromise;
  const wasmPath = _require.resolve('tree-sitter-wasms/out/tree-sitter-lua.wasm');
  const lang = await Parser.Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

function makeSymbolId(filePath: string, name: string, kind: string, parent?: string): string {
  if (parent) return `${filePath}::${parent}.${name}#${kind}`;
  return `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode): string {
  return node.text.split('\n')[0].trim();
}

export class LuaLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'lua-language',
    version: '2.1.0',
    priority: 5,
  };

  // .luau is Roblox's Lua dialect; tree-sitter-lua parses it correctly so we
  // accept the extension here rather than ship a separate plugin (matches
  // graphify v0.7.8).
  supportedExtensions = ['.lua', '.luau'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await createLuaParser();
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      try {
        const root = tree.rootNode as TSNode;

        const hasError = root.hasError;
        const symbols: RawSymbol[] = [];
        const edges: RawEdge[] = [];
        const warnings: string[] = [];
        const seen = new Set<string>();

        // Tree-sitter pass: extract well-parsed constructs
        this.walkStatements(root, filePath, symbols, seen);

        // Regex fallback: extract patterns the grammar handles poorly or misses
        // due to tree-sitter-lua WASM Language corruption across multiple parses.
        // The `seen` set deduplicates symbols already found by tree-sitter.
        this.extractModuleMethods(sourceCode, filePath, symbols, seen);
        this.extractLocalFunctions(sourceCode, filePath, symbols, seen);
        this.extractGlobalFunctions(sourceCode, filePath, symbols, seen);
        this.extractTableFieldAssignments(sourceCode, filePath, symbols, seen);
        this.extractLocalVariables(sourceCode, filePath, symbols, seen);
        this.extractRequireEdges(sourceCode, edges);

        return ok({
          language: 'lua',
          status: hasError ? 'partial' : 'ok',
          symbols,
          edges: edges.length > 0 ? edges : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } finally {
        tree.delete();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Lua parse failed: ${msg}`));
    }
  }

  /**
   * Walk top-level tree-sitter nodes.
   *
   * Actual grammar node types (tree-sitter-wasms lua):
   * - function_definition_statement: `function name(...)` or `function Mod.name(...)` / `function Mod:name(...)`
   * - local_function_definition_statement: `local function name(...)`
   * - local_variable_declaration: `local name` (without assignment — assignments parse as ERROR)
   */
  private walkStatements(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    for (const child of node.namedChildren) {
      switch (child.type) {
        case 'function_definition_statement':
          this.extractFunctionDef(child, filePath, symbols, seen);
          break;
        case 'local_function_definition_statement':
          this.extractLocalFunctionDef(child, filePath, symbols, seen);
          break;
        // We don't extract local_variable_declaration here because the grammar
        // doesn't reliably parse the `= value` part. Regex handles it instead.
      }
    }
  }

  /**
   * Handle `function_definition_statement`:
   * - `function name(...)` -> global function (name field is identifier)
   * - `function Module.name(...)` -> method with parent (name field is variable with table/field)
   * - `function Module:name(...)` -> method with parent (name field is variable with table/method)
   */
  private extractFunctionDef(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    if (nameNode.type === 'identifier') {
      // Global function: function name(...)
      const name = nameNode.text;
      const kind: SymbolKind = 'function';
      const id = makeSymbolId(filePath, name, kind);
      if (seen.has(id)) return;
      seen.add(id);

      symbols.push({
        symbolId: id,
        name,
        kind,
        signature: extractSignature(node),
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
      });
    } else if (nameNode.type === 'variable') {
      // Module.func or Module:method
      // The variable node has table/field or table/method children
      const tableNode = nameNode.childForFieldName('table');
      const fieldNode = nameNode.childForFieldName('field');
      const methodNode = nameNode.childForFieldName('method');
      const memberNode = fieldNode ?? methodNode;

      if (!tableNode || !memberNode) return;

      const tableName = tableNode.text;
      const memberName = memberNode.text;
      const kind: SymbolKind = 'method';
      const parentId = makeSymbolId(filePath, tableName, 'variable');
      const id = makeSymbolId(filePath, memberName, kind, tableName);
      if (seen.has(id)) return;
      seen.add(id);

      const meta: Record<string, unknown> = {};
      if (methodNode) {
        meta.selfMethod = true;
      }

      symbols.push({
        symbolId: id,
        name: memberName,
        kind,
        parentSymbolId: parentId,
        signature: extractSignature(node),
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    }
  }

  /**
   * Handle `local_function_definition_statement`:
   * `local function name(...)` -> local function
   */
  private extractLocalFunctionDef(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode || nameNode.type !== 'identifier') return;

    const name = nameNode.text;
    const kind: SymbolKind = 'function';
    const id = makeSymbolId(filePath, name, kind);
    if (seen.has(id)) return;
    seen.add(id);

    symbols.push({
      symbolId: id,
      name,
      kind,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { local: true },
    });
  }

  // ── Regex fallbacks ──────────────────────────────────────────────────
  // The tree-sitter-lua WASM grammar has a known bug where the Language
  // instance corrupts global WASM state after the first parse, causing
  // subsequent parses to produce ERROR root nodes for valid code.
  // These regex fallbacks ensure all patterns are extracted reliably.
  // The `seen` set prevents duplicates when tree-sitter already extracted them.

  /**
   * Module methods: function Module.name( or function Module:name(
   */
  private extractModuleMethods(
    source: string,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const re = /\bfunction\s+([a-zA-Z_][a-zA-Z0-9_]*)([.:])([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const tableName = m[1];
      const sep = m[2];
      const memberName = m[3];
      const kind: SymbolKind = 'method';
      const parentId = makeSymbolId(filePath, tableName, 'variable');
      const id = makeSymbolId(filePath, memberName, kind, tableName);
      if (seen.has(id)) continue;
      seen.add(id);

      const lineStart = source.substring(0, m.index).split('\n').length;
      const meta: Record<string, unknown> = {};
      if (sep === ':') meta.selfMethod = true;

      symbols.push({
        symbolId: id,
        name: memberName,
        kind,
        parentSymbolId: parentId,
        signature: m[0],
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart,
        lineEnd: lineStart,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    }
  }

  /**
   * Local functions: local function name(
   */
  private extractLocalFunctions(
    source: string,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const re = /\blocal\s+function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1];
      const kind: SymbolKind = 'function';
      const id = makeSymbolId(filePath, name, kind);
      if (seen.has(id)) continue;
      seen.add(id);

      const lineStart = source.substring(0, m.index).split('\n').length;

      symbols.push({
        symbolId: id,
        name,
        kind,
        signature: m[0],
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart,
        lineEnd: lineStart,
        metadata: { local: true },
      });
    }
  }

  /**
   * Global functions: function name( (but not Module.name which is matched above)
   */
  private extractGlobalFunctions(
    source: string,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const re = /\bfunction\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1];
      const kind: SymbolKind = 'function';
      const id = makeSymbolId(filePath, name, kind);
      if (seen.has(id)) continue;
      seen.add(id);

      const lineStart = source.substring(0, m.index).split('\n').length;

      symbols.push({
        symbolId: id,
        name,
        kind,
        signature: m[0],
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart,
        lineEnd: lineStart,
      });
    }
  }

  /**
   * Table field function assignments: Module.name = function( or Module:name = function(
   */
  private extractTableFieldAssignments(
    source: string,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const re = /\b([a-zA-Z_]\w*)[.:]\s*([a-zA-Z_]\w*)\s*=\s*function\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const tableName = m[1];
      const memberName = m[2];
      const kind: SymbolKind = 'method';
      const parentId = makeSymbolId(filePath, tableName, 'variable');
      const id = makeSymbolId(filePath, memberName, kind, tableName);
      if (seen.has(id)) continue;
      seen.add(id);

      const lineStart = source.substring(0, m.index).split('\n').length;

      symbols.push({
        symbolId: id,
        name: memberName,
        kind,
        parentSymbolId: parentId,
        signature: m[0],
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart,
        lineEnd: lineStart,
      });
    }
  }

  /**
   * Local variable declarations: local name = ...
   * The grammar doesn't parse the `= value` part reliably, so we use regex.
   */
  private extractLocalVariables(
    source: string,
    filePath: string,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const re = /\blocal\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1];
      // Skip if this is actually `local function name` (handled by tree-sitter)
      if (name === 'function') continue;

      const kind: SymbolKind = 'variable';
      const id = makeSymbolId(filePath, name, kind);
      if (seen.has(id)) continue;
      seen.add(id);

      const lineStart = source.substring(0, m.index).split('\n').length;

      symbols.push({
        symbolId: id,
        name,
        kind,
        signature: m[0],
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart,
        lineEnd: lineStart,
        metadata: { local: true },
      });
    }
  }

  /**
   * require() import edges.
   * The grammar doesn't reliably parse require() calls, so we use regex.
   */
  private extractRequireEdges(source: string, edges: RawEdge[]): void {
    const re = /\brequire\s*\(?["']([^"']+)["']\)?/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const mod = m[1];
      if (mod) {
        edges.push({ edgeType: 'imports', metadata: { module: mod } });
      }
    }
  }
}
