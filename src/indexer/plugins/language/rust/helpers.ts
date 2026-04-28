/**
 * Helper utilities for the Rust language plugin (tree-sitter).
 */
import type { RawEdge, RawSymbol, SymbolKind } from '../../../../plugin-api/types.js';

export type { TSNode } from '../../../../parser/tree-sitter.js';

export function makeSymbolId(
  filePath: string,
  name: string,
  kind: SymbolKind,
  parentName?: string,
): string {
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

/** Check if a node has `pub` visibility. */
export function isPublic(node: TSNode): boolean {
  for (const child of node.namedChildren) {
    if (child.type === 'visibility_modifier') return true;
  }
  // Also check non-named children for `pub`
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === 'visibility_modifier') return true;
  }
  return false;
}

/** Extract use/extern crate import edges from root. */
export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const child of root.namedChildren) {
    if (child.type === 'use_declaration') {
      const arg = child.childForFieldName('argument');
      if (arg) {
        edges.push({ edgeType: 'imports', metadata: { module: arg.text } });
      }
    } else if (child.type === 'extern_crate_declaration') {
      const name = getNodeName(child);
      if (name) {
        edges.push({ edgeType: 'imports', metadata: { module: name, extern_crate: true } });
      }
    }
  }
  return edges;
}

/** Extract fields from a struct body (field_declaration_list). */
export function extractStructFields(
  body: TSNode,
  filePath: string,
  structName: string,
  structSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'field_declaration') {
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      const name = nameNode.text;
      const typeNode = child.childForFieldName('type');
      const meta: Record<string, unknown> = {};
      if (typeNode) meta.type = typeNode.text;
      if (isPublic(child)) meta.exported = 1;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'property', structName),
        name,
        kind: 'property',
        parentSymbolId: structSymbolId,
        fqn: makeFqn([structName, name]),
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

/** Extract methods from an impl block body (declaration_list). */
export function extractImplMethods(
  body: TSNode,
  filePath: string,
  typeName: string,
  typeSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'function_item') {
      const name = getNodeName(child);
      if (!name) continue;
      const meta: Record<string, unknown> = {};
      if (isPublic(child)) meta.exported = 1;
      // Check for &self / &mut self / self parameter
      const params = child.childForFieldName('parameters');
      if (params) {
        for (const p of params.namedChildren) {
          if (p.type === 'self_parameter') {
            meta.receiver = p.text;
            break;
          }
        }
      }

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'method', typeName),
        name,
        kind: 'method',
        parentSymbolId: typeSymbolId,
        fqn: makeFqn([typeName, name]),
        signature: extractSignature(child),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    } else if (child.type === 'type_item') {
      // Associated type
      const name = getNodeName(child);
      if (!name) continue;
      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'type', typeName),
        name,
        kind: 'type',
        parentSymbolId: typeSymbolId,
        fqn: makeFqn([typeName, name]),
        signature: child.text.split('\n')[0].trim(),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
      });
    } else if (child.type === 'const_item') {
      const name = getNodeName(child);
      if (!name) continue;
      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'constant', typeName),
        name,
        kind: 'constant',
        parentSymbolId: typeSymbolId,
        fqn: makeFqn([typeName, name]),
        signature: child.text.split('\n')[0].trim(),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
      });
    }
  }
  return symbols;
}

/** Extract enum variants from an enum_variant_list. */
export function extractEnumVariants(
  body: TSNode,
  filePath: string,
  enumName: string,
  enumSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'enum_variant') {
      const name = getNodeName(child);
      if (!name) continue;
      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'enum_case', enumName),
        name,
        kind: 'enum_case',
        parentSymbolId: enumSymbolId,
        fqn: makeFqn([enumName, name]),
        signature: child.text.split('\n')[0].trim(),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
      });
    }
  }
  return symbols;
}

/** Extract trait method signatures. */
export function extractTraitMethods(
  body: TSNode,
  filePath: string,
  traitName: string,
  traitSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'function_signature_item' || child.type === 'function_item') {
      const name = getNodeName(child);
      if (!name) continue;
      const meta: Record<string, unknown> = {};
      if (child.type === 'function_signature_item') meta.abstract = true;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'method', traitName),
        name,
        kind: 'method',
        parentSymbolId: traitSymbolId,
        fqn: makeFqn([traitName, name]),
        signature: extractSignature(child),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    } else if (child.type === 'associated_type') {
      const name = getNodeName(child);
      if (!name) continue;
      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'type', traitName),
        name,
        kind: 'type',
        parentSymbolId: traitSymbolId,
        fqn: makeFqn([traitName, name]),
        signature: child.text.split('\n')[0].trim(),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
      });
    }
  }
  return symbols;
}
