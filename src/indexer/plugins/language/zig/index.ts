/**
 * Zig Language Plugin — tree-sitter-based symbol extraction.
 *
 * Extracts: functions, structs, enums, unions, constants, variables, test declarations, and import edges.
 */
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';

function makeSymbolId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  const braceIdx = firstLine.indexOf('{');
  if (braceIdx > 0) return firstLine.substring(0, braceIdx).trim();
  return firstLine;
}

/**
 * Check whether a node has a `pub` keyword among its children.
 */
function isPub(node: TSNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.type === 'pub') return true;
  }
  return false;
}

/**
 * Check whether a variable_declaration uses `const` vs `var`.
 */
function isConst(node: TSNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.type === 'const') return true;
  }
  return false;
}

/**
 * Get the identifier name from a node that has a named `identifier` child.
 */
function getIdentifierName(node: TSNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'identifier') return child.text;
  }
  return undefined;
}

/**
 * Determine the container kind from the initializer of a variable_declaration.
 * Returns 'struct', 'enum', or 'union' if the initializer is one of those,
 * otherwise returns undefined.
 */
function getContainerKind(node: TSNode): 'struct' | 'enum' | 'union' | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'struct_declaration') return 'struct';
    if (child.type === 'enum_declaration') return 'enum';
    if (child.type === 'union_declaration') return 'union';
  }
  return undefined;
}

/**
 * Get the test name from a test_declaration node.
 * The name is either a string literal or an identifier.
 */
function getTestName(node: TSNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'string') {
      // Extract the content between quotes
      for (const sc of child.namedChildren) {
        if (sc.type === 'string_content') return sc.text;
      }
      return child.text.replace(/^"|"$/g, '');
    }
    if (child.type === 'identifier') return child.text;
  }
  return undefined;
}

/**
 * Walk the entire tree to find @import calls and extract import edges.
 */
function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];
  const stack: TSNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.type === 'builtin_function') {
      // Check if it's @import
      let isImport = false;
      let importPath: string | undefined;

      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (!c) continue;
        if (c.type === 'builtin_identifier' && c.text === '@import') {
          isImport = true;
        }
        if (isImport && c.type === 'arguments') {
          // Find the string argument
          for (const arg of c.namedChildren) {
            if (arg.type === 'string') {
              for (const sc of arg.namedChildren) {
                if (sc.type === 'string_content') {
                  importPath = sc.text;
                  break;
                }
              }
              if (!importPath) {
                importPath = arg.text.replace(/^"|"$/g, '');
              }
              break;
            }
          }
        }
      }

      if (isImport && importPath) {
        edges.push({ edgeType: 'imports', metadata: { module: importPath } });
      }
    }

    // Push children in reverse order so left-to-right traversal is maintained
    for (let i = node.childCount - 1; i >= 0; i--) {
      const c = node.child(i);
      if (c) stack.push(c);
    }
  }

  return edges;
}

export class ZigLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'zig-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.zig'];

  async extractSymbols(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('zig');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walkTopLevel(root, filePath, symbols);

      const edges = extractImportEdges(root);

      return ok({
        language: 'zig',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Zig parse failed: ${msg}`));
    }
  }

  private walkTopLevel(root: TSNode, filePath: string, symbols: RawSymbol[]): void {
    for (const child of root.namedChildren) {
      switch (child.type) {
        case 'function_declaration':
          this.extractFunction(child, filePath, symbols);
          break;
        case 'variable_declaration':
          this.extractVariable(child, filePath, symbols);
          break;
        case 'test_declaration':
          this.extractTest(child, filePath, symbols);
          break;
      }
    }
  }

  private extractFunction(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getIdentifierName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    if (isPub(node)) meta.exported = true;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn: name,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractVariable(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getIdentifierName(node);
    if (!name) return;

    const containerKind = getContainerKind(node);
    const pub = isPub(node);
    const constDecl = isConst(node);

    if (containerKind) {
      // struct / enum / union declaration
      const kind: SymbolKind = containerKind === 'enum' ? 'enum' : 'class';
      const meta: Record<string, unknown> = { zigKind: containerKind };
      if (pub) meta.exported = true;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, kind),
        name,
        kind,
        fqn: name,
        signature: extractSignature(node),
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        metadata: meta,
      });
    } else if (constDecl) {
      // plain const
      const meta: Record<string, unknown> = {};
      if (pub) meta.exported = true;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'constant'),
        name,
        kind: 'constant',
        fqn: name,
        signature: extractSignature(node),
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    } else {
      // var declaration
      const meta: Record<string, unknown> = {};
      if (pub) meta.exported = true;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'variable'),
        name,
        kind: 'variable',
        fqn: name,
        signature: extractSignature(node),
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    }
  }

  private extractTest(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getTestName(node);
    if (!name) return;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn: name,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { test: true },
    });
  }
}
