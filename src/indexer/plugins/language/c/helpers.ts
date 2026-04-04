/**
 * Helper utilities for the C language plugin (tree-sitter).
 */
import type { RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';

export type TSNode = {
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

export function makeSymbolId(filePath: string, name: string, kind: SymbolKind, parentName?: string): string {
  if (parentName) return `${filePath}::${parentName}::${name}#${kind}`;
  return `${filePath}::${name}#${kind}`;
}

export function makeFqn(parts: string[]): string {
  return parts.filter(Boolean).join('::');
}

export function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  const braceIdx = firstLine.indexOf('{');
  if (braceIdx > 0) return firstLine.substring(0, braceIdx).trim();
  return firstLine;
}

export function getNodeName(node: TSNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text;
}

/**
 * Walk up through storage-class and type-qualifier keywords preceding a
 * declaration / definition to collect qualifiers like static, inline, extern, volatile, const.
 */
export function extractQualifiers(node: TSNode): string[] {
  const qualifiers: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'storage_class_specifier' || c.type === 'type_qualifier') {
      qualifiers.push(c.text);
    }
  }
  return qualifiers;
}

/**
 * Recursively find the identifier inside a (potentially nested) declarator.
 * C declarators can nest: pointer_declarator -> function_declarator -> identifier
 */
export function findDeclaratorName(node: TSNode): string | undefined {
  if (node.type === 'identifier' || node.type === 'field_identifier' || node.type === 'type_identifier' || node.type === 'primitive_type') return node.text;
  const declarator = node.childForFieldName('declarator');
  if (declarator) return findDeclaratorName(declarator);
  // Fallback: look through named children
  for (const child of node.namedChildren) {
    if (child.type === 'identifier' || child.type === 'field_identifier' || child.type === 'type_identifier' || child.type === 'primitive_type') return child.text;
    if (child.type === 'pointer_declarator' || child.type === 'function_declarator' || child.type === 'array_declarator' || child.type === 'parenthesized_declarator') {
      const found = findDeclaratorName(child);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Check whether a declarator contains a function_declarator (meaning
 * this declaration declares a function, not a variable).
 */
export function containsFunctionDeclarator(node: TSNode): boolean {
  if (node.type === 'function_declarator') return true;
  const declarator = node.childForFieldName('declarator');
  if (declarator) return containsFunctionDeclarator(declarator);
  for (const child of node.namedChildren) {
    if (child.type === 'function_declarator') return true;
    if (child.type === 'pointer_declarator' || child.type === 'parenthesized_declarator') {
      if (containsFunctionDeclarator(child)) return true;
    }
  }
  return false;
}

/** Extract #include import edges from the root node. */
export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const child of root.namedChildren) {
    if (child.type === 'preproc_include') {
      const pathNode = child.childForFieldName('path');
      if (pathNode) {
        const raw = pathNode.text;
        const isSystem = raw.startsWith('<');
        // Strip quotes / angle brackets
        const module = raw.replace(/^["<]|[">]$/g, '');
        edges.push({
          edgeType: 'imports',
          metadata: { module, system: isSystem },
        });
      }
    }
  }
  return edges;
}

/** Extract fields from a struct / union body (field_declaration_list). */
export function extractStructFields(
  body: TSNode,
  filePath: string,
  parentName: string,
  parentSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'field_declaration') {
      const declarator = child.childForFieldName('declarator');
      if (!declarator) continue;
      const name = findDeclaratorName(declarator);
      if (!name) continue;

      const typeNode = child.childForFieldName('type');
      const meta: Record<string, unknown> = {};
      if (typeNode) meta.type = typeNode.text;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'property', parentName),
        name,
        kind: 'property',
        parentSymbolId,
        fqn: makeFqn([parentName, name]),
        signature: child.text.trim().replace(/\n/g, ' '),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    }
  }
  return symbols;
}

/** Extract enumerator constants from an enumerator_list. */
export function extractEnumConstants(
  body: TSNode,
  filePath: string,
  enumName: string,
  enumSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'enumerator') {
      const name = getNodeName(child);
      if (!name) continue;
      const valueNode = child.childForFieldName('value');
      const meta: Record<string, unknown> = {};
      if (valueNode) meta.value = valueNode.text;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'enum_case', enumName),
        name,
        kind: 'enum_case',
        parentSymbolId: enumSymbolId,
        fqn: makeFqn([enumName, name]),
        signature: child.text.trim(),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    }
  }
  return symbols;
}
