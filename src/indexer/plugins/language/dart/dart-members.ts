/**
 * Dart class/mixin/extension body member extractors.
 * Extracted from DartLanguagePlugin to reduce cyclomatic complexity of the main file.
 */
import type { TSNode } from '../../../../parser/tree-sitter.js';
import type { RawSymbol, SymbolKind } from '../../../../plugin-api/types.js';

// ── Module-level helpers (no class dependency) ────────────────────────────────

export function makeSymbolId(
  filePath: string,
  name: string,
  kind: string,
  parent?: string,
): string {
  return parent ? `${filePath}::${parent}.${name}#${kind}` : `${filePath}::${name}#${kind}`;
}

export function extractSignature(node: TSNode): string {
  return node.text.split('{')[0].split('\n')[0].trim().slice(0, 120);
}

export function getNodeName(node: TSNode): string | undefined {
  const nameChild =
    node.childForFieldName?.('name') ??
    node.namedChildren.find((c) => c.type === 'identifier' || c.type === 'type_identifier');
  return nameChild?.text || undefined;
}

export function findChildByType(node: TSNode, ...types: string[]): TSNode | null {
  for (const child of node.namedChildren) {
    if (types.includes(child.type)) return child;
  }
  for (const type of types) {
    const byField = node.childForFieldName?.(type);
    if (byField) return byField;
  }
  return null;
}

function extractGetterName(node: TSNode): string | undefined {
  const m = node.text.match(/get\s+(\w+)/);
  return m?.[1];
}

function extractSetterName(node: TSNode): string | undefined {
  const m = node.text.match(/set\s+(\w+)/);
  return m?.[1];
}

// ── Class body extractors ─────────────────────────────────────────────────────

export function extractClassMembers(
  body: TSNode,
  filePath: string,
  parentName: string,
  parentSymbolId: string,
  symbols: RawSymbol[],
): void {
  for (const child of body.namedChildren) {
    switch (child.type) {
      case 'method_signature':
      case 'function_definition':
      case 'function_signature':
        extractMethod(child, filePath, parentName, parentSymbolId, symbols);
        break;
      case 'getter_signature':
        extractMemberGetter(child, filePath, parentName, parentSymbolId, symbols);
        break;
      case 'setter_signature':
        extractMemberSetter(child, filePath, parentName, parentSymbolId, symbols);
        break;
      case 'constructor_signature':
        extractConstructor(child, filePath, parentName, parentSymbolId, symbols);
        break;
      case 'factory_constructor_signature':
        extractFactoryConstructor(child, filePath, parentName, parentSymbolId, symbols);
        break;
      case 'constant_declaration':
      case 'initialized_variable_definition':
        extractMemberVariable(child, filePath, parentName, parentSymbolId, symbols);
        break;
      case 'declaration':
        extractMemberDeclaration(child, filePath, parentName, parentSymbolId, symbols);
        break;
      default:
        if (child.namedChildren.length > 0) {
          extractMemberDeclaration(child, filePath, parentName, parentSymbolId, symbols);
        }
        break;
    }
  }
}

function extractMemberDeclaration(
  node: TSNode,
  filePath: string,
  parentName: string,
  parentSymbolId: string,
  symbols: RawSymbol[],
): void {
  const text = node.text.trimStart();

  if (text.match(/^(?:(?:static|late|external|const|final|var|@\w+)\s+)/)) {
    extractMemberVariable(node, filePath, parentName, parentSymbolId, symbols);
    return;
  }

  for (const child of node.namedChildren) {
    switch (child.type) {
      case 'method_signature':
      case 'function_definition':
      case 'function_signature':
        extractMethod(child, filePath, parentName, parentSymbolId, symbols);
        break;
      case 'getter_signature':
        extractMemberGetter(child, filePath, parentName, parentSymbolId, symbols);
        break;
      case 'setter_signature':
        extractMemberSetter(child, filePath, parentName, parentSymbolId, symbols);
        break;
      case 'constructor_signature':
        extractConstructor(child, filePath, parentName, parentSymbolId, symbols);
        break;
      case 'factory_constructor_signature':
        extractFactoryConstructor(child, filePath, parentName, parentSymbolId, symbols);
        break;
    }
  }
}

function extractMethod(
  node: TSNode,
  filePath: string,
  parentName: string,
  parentSymbolId: string,
  symbols: RawSymbol[],
): void {
  const name = getNodeName(node);
  if (!name) return;

  const meta: Record<string, unknown> = {};
  const text = node.text.trimStart();
  if (text.startsWith('static ') || text.includes(' static ')) meta.static = true;
  if (text.startsWith('abstract ') || text.includes(' abstract ')) meta.abstract = true;
  if (text.startsWith('override ') || text.includes('@override')) meta.override = true;

  symbols.push({
    symbolId: makeSymbolId(filePath, name, 'method', parentName),
    name,
    kind: 'method',
    parentSymbolId,
    signature: extractSignature(node),
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    metadata: Object.keys(meta).length > 0 ? meta : undefined,
  });
}

function extractMemberGetter(
  node: TSNode,
  filePath: string,
  parentName: string,
  parentSymbolId: string,
  symbols: RawSymbol[],
): void {
  const name = getNodeName(node) ?? extractGetterName(node);
  if (!name) return;

  symbols.push({
    symbolId: makeSymbolId(filePath, name, 'property', parentName),
    name,
    kind: 'property',
    parentSymbolId,
    signature: extractSignature(node),
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    metadata: { dartKind: 'getter' },
  });
}

function extractMemberSetter(
  node: TSNode,
  filePath: string,
  parentName: string,
  parentSymbolId: string,
  symbols: RawSymbol[],
): void {
  const name = getNodeName(node) ?? extractSetterName(node);
  if (!name) return;

  symbols.push({
    symbolId: makeSymbolId(filePath, name, 'property', parentName),
    name,
    kind: 'property',
    parentSymbolId,
    signature: extractSignature(node),
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    metadata: { dartKind: 'setter' },
  });
}

function extractConstructor(
  node: TSNode,
  filePath: string,
  parentName: string,
  parentSymbolId: string,
  symbols: RawSymbol[],
): void {
  const name = getNodeName(node) ?? parentName;

  symbols.push({
    symbolId: makeSymbolId(filePath, name, 'method', parentName),
    name,
    kind: 'method',
    parentSymbolId,
    signature: extractSignature(node),
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    metadata: { dartKind: 'constructor' },
  });
}

function extractFactoryConstructor(
  node: TSNode,
  filePath: string,
  parentName: string,
  parentSymbolId: string,
  symbols: RawSymbol[],
): void {
  const name = getNodeName(node) ?? parentName;

  symbols.push({
    symbolId: makeSymbolId(filePath, name, 'method', parentName),
    name,
    kind: 'method',
    parentSymbolId,
    signature: extractSignature(node),
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    metadata: { dartKind: 'factory' },
  });
}

function extractMemberVariable(
  node: TSNode,
  filePath: string,
  parentName: string,
  parentSymbolId: string,
  symbols: RawSymbol[],
): void {
  const text = node.text.trimStart();
  const isConst = text.match(/^(?:static\s+)?const\s/) !== null;
  const kind: SymbolKind = isConst ? 'constant' : 'property';

  let name = getNodeName(node);
  if (!name) {
    const m = text.match(
      /^(?:(?:static|late|external|const|final|var|@\w+)\s+)*(?:[\w<>,?\s]+\s+)?(\w+)\s*[=;]/,
    );
    name = m?.[1];
  }
  if (!name) {
    for (const child of node.namedChildren) {
      if (child.type === 'identifier') {
        name = child.text;
        break;
      }
    }
  }
  if (!name) return;

  symbols.push({
    symbolId: makeSymbolId(filePath, name, kind, parentName),
    name,
    kind,
    parentSymbolId,
    signature: text.split('\n')[0].trim().slice(0, 120),
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
  });
}
