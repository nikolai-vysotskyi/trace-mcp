/**
 * Helper utilities for the Ruby language plugin.
 * Extracts AST-walking logic to keep the main plugin manageable.
 */
import type { RawSymbol, RawEdge, SymbolKind } from '../../../plugin-api/types.js';

// tree-sitter types (CJS interop — no type package available)
type TSNode = {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildCount: number;
  childCount: number;
  namedChildren: TSNode[];
  namedChild(index: number): TSNode | null;
  child(index: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  parent: TSNode | null;
  isNamed: boolean;
  hasError: boolean;
};

export type { TSNode };

/** Build a symbol ID following the convention: `path::Name#kind` */
export function makeSymbolId(
  relativePath: string,
  name: string,
  kind: SymbolKind,
  parentName?: string,
): string {
  if (parentName) {
    return `${relativePath}::${parentName}::${name}#${kind}`;
  }
  return `${relativePath}::${name}#${kind}`;
}

/**
 * Build a `::` separated fully-qualified name for a Ruby symbol.
 * Module/class parts use `::`, methods use `.`.
 */
export function makeFqn(namespaceParts: string[], methodName?: string): string {
  const base = namespaceParts.join('::');
  if (methodName) {
    return `${base}.${methodName}`;
  }
  return base;
}

/** Convert a file path to a Ruby module-style path (for FQN prefix). */
export function filePathToModule(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\.(rb|rake)$/, '');
}

/** Extract signature — first line of the node text. */
export function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  return firstLine;
}

/** Get the name field from a node. */
export function getNodeName(node: TSNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text;
}

/** Check if a name is ALL_CAPS (constant naming convention). */
export function isAllCaps(name: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,}$/.test(name);
}

/** Extract the superclass from a class definition. */
export function extractSuperclass(node: TSNode): string | undefined {
  const superNode = node.childForFieldName('superclass');
  if (superNode) {
    return superNode.text;
  }
  return undefined;
}

/** Extract methods from a class/module body node. */
export function extractMethods(
  body: TSNode,
  filePath: string,
  containerName: string,
  containerSymbolId: string,
  namespaceParts: string[],
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'method') {
      const name = getNodeName(child);
      if (!name) continue;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'method', containerName),
        name,
        kind: 'method',
        fqn: makeFqn(namespaceParts, name),
        parentSymbolId: containerSymbolId,
        signature: extractSignature(child),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
      });
    } else if (child.type === 'singleton_method') {
      // def self.method_name
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      const name = nameNode.text;

      symbols.push({
        symbolId: makeSymbolId(filePath, `self.${name}`, 'method', containerName),
        name: `self.${name}`,
        kind: 'method',
        fqn: makeFqn(namespaceParts, `self.${name}`),
        parentSymbolId: containerSymbolId,
        signature: extractSignature(child),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: { static: true },
      });
    }
  }

  return symbols;
}

/** Extract attr_accessor/attr_reader/attr_writer properties from a class/module body. */
export function extractAttributes(
  body: TSNode,
  filePath: string,
  containerName: string,
  containerSymbolId: string,
  namespaceParts: string[],
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type !== 'call') continue;

    const methodNode = child.childForFieldName('method');
    if (!methodNode) continue;
    const methodName = methodNode.text;

    if (methodName !== 'attr_accessor' && methodName !== 'attr_reader' && methodName !== 'attr_writer') {
      continue;
    }

    const args = child.childForFieldName('arguments');
    if (!args) continue;

    for (const arg of args.namedChildren) {
      let attrName: string | undefined;
      if (arg.type === 'simple_symbol') {
        // :name → strip the leading colon
        attrName = arg.text.replace(/^:/, '');
      } else if (arg.type === 'symbol') {
        attrName = arg.text.replace(/^:/, '');
      }
      if (!attrName) continue;

      symbols.push({
        symbolId: makeSymbolId(filePath, attrName, 'property', containerName),
        name: attrName,
        kind: 'property',
        fqn: makeFqn(namespaceParts, attrName),
        parentSymbolId: containerSymbolId,
        byteStart: arg.startIndex,
        byteEnd: arg.endIndex,
        lineStart: arg.startPosition.row + 1,
        lineEnd: arg.endPosition.row + 1,
        metadata: { accessor: methodName },
      });
    }
  }

  return symbols;
}

/**
 * Extract include/extend/prepend mixins from a class/module body.
 * Returns an array of module names.
 */
export function extractMixins(body: TSNode): Record<string, string[]> {
  const mixins: Record<string, string[]> = {};

  for (const child of body.namedChildren) {
    if (child.type !== 'call') continue;

    const methodNode = child.childForFieldName('method');
    if (!methodNode) continue;
    const methodName = methodNode.text;

    if (methodName !== 'include' && methodName !== 'extend' && methodName !== 'prepend') {
      continue;
    }

    const args = child.childForFieldName('arguments');
    if (!args) continue;

    for (const arg of args.namedChildren) {
      if (arg.type === 'constant' || arg.type === 'scope_resolution') {
        if (!mixins[methodName]) mixins[methodName] = [];
        mixins[methodName].push(arg.text);
      }
    }
  }

  return mixins;
}

/**
 * Extract import edges from require/require_relative statements.
 *
 * Patterns:
 * - `require 'path'` → { edgeType: 'imports', metadata: { from: 'path' } }
 * - `require_relative 'path'` → { edgeType: 'imports', metadata: { from: 'path', relative: true } }
 */
export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];

  walkForImports(root, edges);

  return edges;
}

function walkForImports(node: TSNode, edges: RawEdge[]): void {
  if (node.type === 'call') {
    const methodNode = node.childForFieldName('method');
    if (methodNode) {
      const methodName = methodNode.text;
      if (methodName === 'require' || methodName === 'require_relative') {
        const args = node.childForFieldName('arguments');
        if (args) {
          for (const arg of args.namedChildren) {
            if (arg.type === 'string') {
              const content = extractStringContent(arg);
              if (content) {
                edges.push({
                  edgeType: 'imports',
                  metadata: {
                    from: content,
                    ...(methodName === 'require_relative' ? { relative: true } : {}),
                  },
                });
              }
            }
          }
        }
      }
    }
  }

  for (const child of node.namedChildren) {
    walkForImports(child, edges);
  }
}

/** Extract string content, stripping quotes. */
function extractStringContent(node: TSNode): string | null {
  // string node children: string_beginning + string_content + string_end
  // OR it's a simple string whose text has quotes
  for (const child of node.namedChildren) {
    if (child.type === 'string_content') {
      return child.text;
    }
  }
  // Fallback: strip outer quotes from the text
  const text = node.text;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return null;
}

/** Extract UPPER_CASE constant assignments from a body. */
export function extractConstants(
  body: TSNode,
  filePath: string,
  containerName: string | undefined,
  containerSymbolId: string | undefined,
  namespaceParts: string[],
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'assignment') {
      const left = child.childForFieldName('left');
      if (left && left.type === 'constant') {
        const name = left.text;
        symbols.push({
          symbolId: makeSymbolId(filePath, name, 'constant', containerName),
          name,
          kind: 'constant',
          fqn: makeFqn([...namespaceParts, name]),
          parentSymbolId: containerSymbolId,
          signature: child.text.split('\n')[0].trim().slice(0, 120),
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
          lineStart: child.startPosition.row + 1,
          lineEnd: child.endPosition.row + 1,
        });
      }
    }
  }

  return symbols;
}
