/**
 * Helper utilities for the PHP language plugin.
 * Extracts AST-walking logic to keep the main plugin under 300 lines.
 */
import type { RawSymbol, SymbolKind } from '../../../plugin-api/types.js';

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

/** Extract the namespace string from the root program node. */
export function extractNamespace(rootNode: TSNode): string | undefined {
  for (const child of rootNode.namedChildren) {
    if (child.type === 'namespace_definition') {
      const nsName = child.namedChildren.find((c) => c.type === 'namespace_name');
      if (nsName) return nsName.text;
    }
  }
  return undefined;
}

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

/** Build a fully qualified name. */
export function makeFqn(namespace: string | undefined, className: string, memberName?: string): string {
  const base = namespace ? `${namespace}\\${className}` : className;
  return memberName ? `${base}::${memberName}` : base;
}

/** Extract visibility + modifiers + function/class signature from source (first line only). */
export function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  // Trim body openers: { or anything after {
  const braceIdx = firstLine.indexOf('{');
  if (braceIdx > 0) {
    return firstLine.substring(0, braceIdx).trim();
  }
  // For abstract/interface methods ending with ;
  const semiIdx = firstLine.indexOf(';');
  if (semiIdx > 0) {
    return firstLine.substring(0, semiIdx).trim();
  }
  return firstLine;
}

/** Check if a property_declaration has the readonly modifier. */
export function isReadonly(node: TSNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'readonly_modifier') return true;
  }
  return false;
}

/** Extract attribute names from an attribute_list node. */
export function extractAttributes(node: TSNode): string[] {
  const attrs: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'attribute_list') {
      for (const group of child.namedChildren) {
        if (group.type === 'attribute_group') {
          for (const attr of group.namedChildren) {
            if (attr.type === 'attribute') {
              const name = attr.childForFieldName('name') ?? attr.namedChildren[0];
              if (name) attrs.push(name.text);
            }
          }
        }
      }
    }
  }
  return attrs;
}

/** Extract visibility modifier text from a node's children. */
export function getVisibility(node: TSNode): string | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'visibility_modifier') return child.text;
  }
  return undefined;
}

/** Extract constructor-promoted parameters as property symbols. */
export function extractPromotedProperties(
  methodNode: TSNode,
  relativePath: string,
  className: string,
  namespace: string | undefined,
  classSymbolId: string,
): RawSymbol[] {
  const params = methodNode.childForFieldName('parameters');
  if (!params) return [];

  const symbols: RawSymbol[] = [];
  for (const param of params.namedChildren) {
    if (param.type === 'property_promotion_parameter') {
      const varName = param.childForFieldName('name')
        ?? param.namedChildren.find((c) => c.type === 'variable_name');
      if (!varName) continue;
      const propName = varName.text.replace(/^\$/, '');
      const readonly = isReadonly(param);
      const visibility = getVisibility(param);

      symbols.push({
        symbolId: makeSymbolId(relativePath, propName, 'property', className),
        name: propName,
        kind: 'property',
        fqn: makeFqn(namespace, className, propName),
        parentSymbolId: classSymbolId,
        signature: param.text.trim(),
        byteStart: param.startIndex,
        byteEnd: param.endIndex,
        lineStart: param.startPosition.row + 1,
        lineEnd: param.endPosition.row + 1,
        metadata: {
          ...(readonly ? { readonly: true } : {}),
          ...(visibility ? { visibility } : {}),
          promoted: true,
        },
      });
    }
  }
  return symbols;
}

/** Extract a property_declaration node into a RawSymbol. */
export function extractPropertySymbol(
  node: TSNode, filePath: string, className: string,
  namespace: string | undefined, classSymbolId: string,
): RawSymbol | undefined {
  const propElement = node.namedChildren.find((c) => c.type === 'property_element');
  if (!propElement) return undefined;
  const varName = propElement.namedChildren.find((c) => c.type === 'variable_name');
  if (!varName) return undefined;
  const name = varName.text.replace(/^\$/, '');
  const readonly = isReadonly(node);
  const visibility = getVisibility(node);

  return {
    symbolId: makeSymbolId(filePath, name, 'property', className),
    name,
    kind: 'property',
    fqn: makeFqn(namespace, className, name),
    parentSymbolId: classSymbolId,
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    metadata: {
      ...(readonly ? { readonly: true } : {}),
      ...(visibility ? { visibility } : {}),
    },
  };
}

/** Extract const_element children from a const_declaration node. */
export function extractConstantSymbols(
  node: TSNode, filePath: string, className: string,
  namespace: string | undefined, classSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'const_element') {
      const nameNode = child.childForFieldName('name')
        ?? child.namedChildren.find((c) => c.type === 'name');
      if (!nameNode) continue;
      const name = nameNode.text;
      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'constant', className),
        name,
        kind: 'constant',
        fqn: makeFqn(namespace, className, name),
        parentSymbolId: classSymbolId,
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
      });
    }
  }
  return symbols;
}
