/**
 * Elixir Language Plugin — tree-sitter-based symbol extraction.
 *
 * Extracts: modules (defmodule), protocols (defprotocol), implementations (defimpl),
 * delegates (defdelegate), structs (defstruct), public/private functions (def/defp),
 * macros (defmacro/defmacrop), guards (defguard/defguardp), type specs (@type/@typep/@opaque),
 * callbacks (@callback), and import edges (import, alias, use, require).
 */
import { err, ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawEdge,
  RawSymbol,
  SymbolKind,
} from '../../../../plugin-api/types.js';

function makeSymbolId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode): string {
  return node.text.split('\n')[0].trim().slice(0, 120);
}

/**
 * Get the text of the `target` (first identifier) of a `call` node.
 * In Elixir's tree-sitter grammar, `defmodule`, `def`, `import`, etc. are all
 * `call` nodes whose target is an `identifier`.
 */
function getCallTarget(node: TSNode): string | null {
  // The target is the first named child that is an identifier
  const target = node.childForFieldName('target');
  if (target && target.type === 'identifier') return target.text;
  // Fallback: first child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'identifier') return child.text;
  }
  return null;
}

/**
 * Extract the arguments node from a call. In tree-sitter-elixir, the call
 * node has an `arguments` named child (not a field), so we find it by type.
 */
function getCallArguments(node: TSNode): TSNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'arguments') return child;
  }
  return null;
}

/**
 * Extract module name from the first argument of defmodule/defprotocol/defimpl.
 * The first argument is typically an `alias` node (e.g. `Foo.Bar.Baz`).
 */
function extractModuleName(node: TSNode): string | null {
  const args = getCallArguments(node);
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (!child) continue;
    if (child.type === 'alias') return child.text;
    // Sometimes the name might be nested in an `arguments` wrapper
    if (child.type === 'arguments') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const inner = child.namedChild(j);
        if (inner?.type === 'alias') return inner.text;
      }
    }
  }
  return null;
}

/**
 * Extract function name from the first argument of def/defp/defmacro/etc.
 * For `def foo(a, b)` the arguments contain a `call` with target `foo`.
 * For `def foo` (no-args) it's just an `identifier`.
 */
function extractFunctionName(node: TSNode): string | null {
  const args = getCallArguments(node);
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (!child) continue;
    // def foo(args) → child is a `call` whose target is `foo`
    if (child.type === 'call') {
      const target = getCallTarget(child);
      if (target) return target;
    }
    // def foo → child is an `identifier`
    if (child.type === 'identifier') return child.text;
    // Sometimes wrapped in `arguments`
    if (child.type === 'arguments') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const inner = child.namedChild(j);
        if (inner?.type === 'call') {
          const target = getCallTarget(inner);
          if (target) return target;
        }
        if (inner?.type === 'identifier') return inner.text;
      }
    }
  }
  return null;
}

/**
 * Extract the module name from a `use`, `import`, `alias`, or `require` call.
 * The first argument is usually an `alias` node like `Ecto.Changeset`.
 */
function extractImportTarget(node: TSNode): string | null {
  const args = getCallArguments(node);
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (!child) continue;
    if (child.type === 'alias') return child.text;
    // Could also be a dotted access or __MODULE__ etc — grab text
    if (child.type === 'dot' || child.type === 'identifier') return child.text;
    if (child.type === 'arguments') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const inner = child.namedChild(j);
        if (inner?.type === 'alias') return inner.text;
      }
    }
  }
  return null;
}

/**
 * Extract the attribute name from a unary_operator @ node.
 * `@type foo :: bar` → the operand is a call to `type` with args.
 * `@callback foo(...)` → operand is a call to `callback`.
 */
function extractAttributeInfo(
  node: TSNode,
): { attrName: string; symbolName: string | null } | null {
  // The operator should be '@'
  const op = node.childForFieldName('operator');
  if (!op || op.text !== '@') return null;

  const operand = node.childForFieldName('operand');
  if (!operand) return null;

  if (operand.type === 'call') {
    const target = getCallTarget(operand);
    if (!target) return null;

    // Extract the name from the call's arguments
    const symbolName = extractAttributeSymbolName(operand);
    return { attrName: target, symbolName };
  }

  if (operand.type === 'identifier') {
    return { attrName: operand.text, symbolName: null };
  }

  return null;
}

/**
 * Extract the type/callback name from an attribute call.
 * For `@type foo :: bar`, the call is `type(foo :: bar)` and we want `foo`.
 * For `@callback foo(arg) :: result`, we want `foo`.
 */
function extractAttributeSymbolName(callNode: TSNode): string | null {
  const args = getCallArguments(callNode);
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (!child) continue;

    // @type foo :: bar → first arg is a binary_operator (::) with left = identifier `foo`
    if (child.type === 'binary_operator') {
      const left = child.childForFieldName('left');
      if (left) {
        // left could be a call like `foo(arg)` or an identifier `foo`
        if (left.type === 'call') {
          const target = getCallTarget(left);
          if (target) return target;
        }
        if (left.type === 'identifier') return left.text;
      }
    }

    // @callback foo(arg) :: result → first arg could be a call
    if (child.type === 'call') {
      const target = getCallTarget(child);
      if (target) return target;
    }
    if (child.type === 'identifier') return child.text;

    // Wrapped in arguments
    if (child.type === 'arguments') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const inner = child.namedChild(j);
        if (inner?.type === 'binary_operator') {
          const left = inner.childForFieldName('left');
          if (left?.type === 'call') return getCallTarget(left);
          if (left?.type === 'identifier') return left.text;
        }
        if (inner?.type === 'call') return getCallTarget(inner);
        if (inner?.type === 'identifier') return inner.text;
      }
    }
  }
  return null;
}

/** Known def-family call targets and their symbol mappings. */
const DEF_TARGETS: Record<string, { kind: SymbolKind; meta?: Record<string, unknown> }> = {
  defmodule: { kind: 'class', meta: { module: true } },
  defprotocol: { kind: 'interface' },
  defimpl: { kind: 'class', meta: { impl: true } },
  defdelegate: { kind: 'function', meta: { delegate: true } },
  defstruct: { kind: 'type', meta: { struct: true } },
  def: { kind: 'function' },
  defp: { kind: 'function', meta: { private: true } },
  defmacro: { kind: 'function', meta: { macro: true } },
  defmacrop: { kind: 'function', meta: { macro: true, private: true } },
  defguard: { kind: 'function', meta: { guard: true } },
  defguardp: { kind: 'function', meta: { guard: true, private: true } },
};

/** Attribute names that produce type symbols. */
const TYPE_ATTRS: Record<string, Record<string, unknown> | undefined> = {
  type: undefined,
  typep: { private: true },
  opaque: { opaque: true },
};

const IMPORT_TARGETS = new Set(['import', 'alias', 'use', 'require']);

export class ElixirLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'elixir-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.ex', '.exs'];
  supportedVersions = ['1.12', '1.13', '1.14', '1.15', '1.16', '1.17'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('elixir');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      try {
        const root: TSNode = tree.rootNode;

        const hasError = root.hasError;
        const symbols: RawSymbol[] = [];
        const edges: RawEdge[] = [];
        const warnings: string[] = [];
        const seen = new Set<string>();

        if (hasError) {
          warnings.push('Source contains syntax errors; extraction may be incomplete');
        }

        this.walkNode(root, filePath, null, symbols, edges, seen);

        return ok({
          language: 'elixir',
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
      return err(parseError(filePath, `Elixir parse failed: ${msg}`));
    }
  }

  /**
   * Recursively walk the AST, extracting symbols and edges.
   * @param moduleCtx - The enclosing module name (for FQN construction), or null at top level.
   */
  private walkNode(
    node: TSNode,
    filePath: string,
    moduleCtx: string | null,
    symbols: RawSymbol[],
    edges: RawEdge[],
    seen: Set<string>,
  ): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (child.type === 'call') {
        this.processCall(child, filePath, moduleCtx, symbols, edges, seen);
      } else if (child.type === 'unary_operator') {
        this.processAttribute(child, filePath, moduleCtx, symbols, seen);
      } else {
        // Recurse into other node types (do blocks, etc.)
        this.walkNode(child, filePath, moduleCtx, symbols, edges, seen);
      }
    }
  }

  /**
   * Process a `call` node — this is where defmodule, def, import, etc. live.
   */
  private processCall(
    node: TSNode,
    filePath: string,
    moduleCtx: string | null,
    symbols: RawSymbol[],
    edges: RawEdge[],
    seen: Set<string>,
  ): void {
    const target = getCallTarget(node);
    if (!target) {
      // Not a simple call — recurse into children
      this.walkNode(node, filePath, moduleCtx, symbols, edges, seen);
      return;
    }

    // --- Import edges ---
    if (IMPORT_TARGETS.has(target)) {
      const mod = extractImportTarget(node);
      if (mod) {
        edges.push({ edgeType: 'imports', metadata: { module: mod, kind: target } });
      }
      return;
    }

    // --- def-family symbols ---
    const defInfo = DEF_TARGETS[target];
    if (!defInfo) {
      // Unknown call — recurse to find nested defs
      this.walkNode(node, filePath, moduleCtx, symbols, edges, seen);
      return;
    }

    // Module-level definitions: defmodule, defprotocol, defimpl
    if (target === 'defmodule' || target === 'defprotocol' || target === 'defimpl') {
      const name = extractModuleName(node);
      if (!name) return;

      const fqn = moduleCtx ? `${moduleCtx}.${name}` : name;
      const symbolId = makeSymbolId(filePath, fqn, defInfo.kind);

      if (!seen.has(symbolId)) {
        seen.add(symbolId);
        const parentId = moduleCtx ? makeSymbolId(filePath, moduleCtx, 'class') : undefined;
        symbols.push({
          symbolId,
          name,
          kind: defInfo.kind,
          fqn,
          parentSymbolId: parentId,
          signature: extractSignature(node),
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          metadata: defInfo.meta ? { ...defInfo.meta } : undefined,
        });
      }

      // Recurse into the module body with updated context
      this.walkNode(node, filePath, fqn, symbols, edges, seen);
      return;
    }

    // defstruct — name comes from enclosing module
    if (target === 'defstruct') {
      const structName = moduleCtx ? `${moduleCtx}.defstruct` : 'defstruct';
      const symbolId = makeSymbolId(filePath, structName, 'type');

      if (!seen.has(symbolId)) {
        seen.add(symbolId);
        const parentId = moduleCtx ? makeSymbolId(filePath, moduleCtx, 'class') : undefined;
        symbols.push({
          symbolId,
          name: 'defstruct',
          kind: 'type',
          fqn: structName,
          parentSymbolId: parentId,
          signature: extractSignature(node),
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          metadata: { struct: true },
        });
      }
      return;
    }

    // Function-like definitions: def, defp, defmacro, defmacrop, defguard, defguardp, defdelegate
    const funcName = extractFunctionName(node);
    if (!funcName) return;

    const fqn = moduleCtx ? `${moduleCtx}.${funcName}` : funcName;
    const symbolId = makeSymbolId(filePath, fqn, 'function');

    if (!seen.has(symbolId)) {
      seen.add(symbolId);
      const parentId = moduleCtx ? makeSymbolId(filePath, moduleCtx, 'class') : undefined;
      symbols.push({
        symbolId,
        name: funcName,
        kind: 'function',
        fqn,
        parentSymbolId: parentId,
        signature: extractSignature(node),
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        metadata: defInfo.meta ? { ...defInfo.meta } : undefined,
      });
    }

    // Don't recurse into function bodies — no nested defs expected there normally
  }

  /**
   * Process a `unary_operator` node — handles @type, @typep, @opaque, @callback.
   */
  private processAttribute(
    node: TSNode,
    filePath: string,
    moduleCtx: string | null,
    symbols: RawSymbol[],
    seen: Set<string>,
  ): void {
    const info = extractAttributeInfo(node);
    if (!info) return;

    const { attrName, symbolName } = info;

    // @type, @typep, @opaque
    if (attrName in TYPE_ATTRS && symbolName) {
      const fqn = moduleCtx ? `${moduleCtx}.${symbolName}` : symbolName;
      const symbolId = makeSymbolId(filePath, fqn, 'type');
      if (!seen.has(symbolId)) {
        seen.add(symbolId);
        const parentId = moduleCtx ? makeSymbolId(filePath, moduleCtx, 'class') : undefined;
        symbols.push({
          symbolId,
          name: symbolName,
          kind: 'type',
          fqn,
          parentSymbolId: parentId,
          signature: extractSignature(node),
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          metadata: TYPE_ATTRS[attrName] ? { ...TYPE_ATTRS[attrName] } : undefined,
        });
      }
      return;
    }

    // @callback
    if (attrName === 'callback' && symbolName) {
      const fqn = moduleCtx ? `${moduleCtx}.${symbolName}` : symbolName;
      const symbolId = makeSymbolId(filePath, fqn, 'function');
      if (!seen.has(symbolId)) {
        seen.add(symbolId);
        const parentId = moduleCtx ? makeSymbolId(filePath, moduleCtx, 'class') : undefined;
        symbols.push({
          symbolId,
          name: symbolName,
          kind: 'function',
          fqn,
          parentSymbolId: parentId,
          signature: extractSignature(node),
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          metadata: { callback: true },
        });
      }
    }
  }
}
