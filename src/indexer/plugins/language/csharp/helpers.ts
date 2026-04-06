/**
 * Helper utilities for the C# language plugin.
 * Extracts AST-walking logic to keep the main plugin concise.
 */
import type { RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';

export type { TSNode } from '../../../../parser/tree-sitter.js';

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

/** Build a dotted fully-qualified name. */
export function makeFqn(parts: string[]): string {
  return parts.filter(Boolean).join('.');
}

/** Extract signature (first line of a node, trimmed of body brace). */
export function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  const braceIdx = firstLine.indexOf('{');
  if (braceIdx > 0) {
    return firstLine.substring(0, braceIdx).trim();
  }
  return firstLine.replace(/;$/, '').trim();
}

/** Get the name of a node from its 'name' field or 'identifier' child. */
export function getNodeName(node: TSNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;
  // Fallback: look for identifier child
  for (const child of node.namedChildren) {
    if (child.type === 'identifier') return child.text;
  }
  return undefined;
}

/** Extract modifier keywords from a node's children (public, static, abstract, etc.). */
export function extractModifiers(node: TSNode): string[] {
  const keywords: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'modifier') {
      keywords.push(child.text);
    }
    // Some modifiers appear as plain keywords before the declaration type
    if (!child.isNamed && [
      'public', 'private', 'protected', 'internal',
      'static', 'abstract', 'sealed', 'virtual', 'override',
      'readonly', 'const', 'new', 'partial', 'async', 'extern',
      'unsafe', 'volatile', 'ref', 'required', 'file',
    ].includes(child.text)) {
      keywords.push(child.text);
    }
  }
  return keywords;
}

/** Extract attribute (annotation) names from attribute_list children. */
export function extractAttributes(node: TSNode): string[] {
  const attrs: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'attribute_list') {
      for (const attr of child.namedChildren) {
        if (attr.type === 'attribute') {
          const nameNode = attr.childForFieldName('name') ?? findChildByType(attr, 'identifier') ?? findChildByType(attr, 'qualified_name');
          if (nameNode) attrs.push(nameNode.text);
        }
      }
    }
  }
  return attrs;
}

/** Extract base types from base_list (extends / implements in C#). */
export function extractBaseTypes(node: TSNode): string[] {
  const bases: string[] = [];
  const baseList = findChildByType(node, 'base_list');
  if (!baseList) return bases;

  for (const child of baseList.namedChildren) {
    // Each child is typically a simple_base_type, generic_name, qualified_name, or identifier
    if (child.type === 'identifier' || child.type === 'generic_name' || child.type === 'qualified_name') {
      bases.push(child.text);
    } else {
      // Nested type references — use the text
      const text = child.text.replace(/^:\s*/, '').trim();
      if (text) bases.push(text);
    }
  }
  return bases;
}

/** Extract using directive edges from the root compilation_unit. */
export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const node of root.namedChildren) {
    if (node.type === 'using_directive') {
      let namespaceName = '';
      let isStatic = false;
      let alias: string | undefined;

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.text === 'static') isStatic = true;
      }

      // Check for alias: using Alias = Namespace;
      const nameAssignment = node.childForFieldName('alias');
      if (nameAssignment) {
        alias = nameAssignment.text;
      }

      // The namespace/type name
      for (const child of node.namedChildren) {
        if (child.type === 'qualified_name' || child.type === 'identifier' || child.type === 'name') {
          namespaceName = child.text;
        }
      }

      // Fallback: extract from text if tree-sitter node types differ
      if (!namespaceName) {
        const match = node.text.match(/using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/);
        if (match) namespaceName = match[1];
      }

      if (namespaceName) {
        const parts = namespaceName.split('.');
        const simpleName = alias ?? parts[parts.length - 1];

        edges.push({
          edgeType: 'imports',
          metadata: {
            from: namespaceName,
            specifiers: [simpleName],
            ...(isStatic ? { static: true } : {}),
            ...(alias ? { alias } : {}),
          },
        });
      }
    }
  }

  return edges;
}

/** Extract methods from a class/struct/interface body. */
export function extractClassMethods(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'method_declaration') {
      const name = getNodeName(child);
      if (!name) continue;

      const modifiers = extractModifiers(child);
      const attrs = extractAttributes(child);
      const meta: Record<string, unknown> = {};

      if (attrs.length > 0) meta.attributes = attrs;
      if (modifiers.includes('static')) meta.static = true;
      if (modifiers.includes('abstract')) meta.abstract = true;
      if (modifiers.includes('virtual')) meta.virtual = true;
      if (modifiers.includes('override')) meta.override = true;
      if (modifiers.includes('async')) meta.async = true;

      const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
      if (visibility) meta.visibility = visibility;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'method', className),
        name,
        kind: 'method',
        parentSymbolId: classSymbolId,
        signature: extractSignature(child),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    } else if (child.type === 'constructor_declaration') {
      const name = getNodeName(child) ?? className;
      const modifiers = extractModifiers(child);
      const attrs = extractAttributes(child);
      const meta: Record<string, unknown> = {};

      meta.isConstructor = true;
      if (attrs.length > 0) meta.attributes = attrs;
      const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
      if (visibility) meta.visibility = visibility;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'method', className),
        name,
        kind: 'method',
        parentSymbolId: classSymbolId,
        signature: extractSignature(child),
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

/** Extract properties from a class/struct body. */
export function extractClassProperties(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'property_declaration') {
      const name = getNodeName(child);
      if (!name) continue;

      const modifiers = extractModifiers(child);
      const attrs = extractAttributes(child);
      const meta: Record<string, unknown> = {};

      if (attrs.length > 0) meta.attributes = attrs;
      if (modifiers.includes('static')) meta.static = true;
      if (modifiers.includes('abstract')) meta.abstract = true;
      if (modifiers.includes('virtual')) meta.virtual = true;
      if (modifiers.includes('override')) meta.override = true;
      if (modifiers.includes('required')) meta.required = true;

      const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
      if (visibility) meta.visibility = visibility;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'property', className),
        name,
        kind: 'property',
        parentSymbolId: classSymbolId,
        signature: extractSignature(child),
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

/** Extract fields from a class/struct body. */
export function extractClassFields(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'field_declaration') {
      const modifiers = extractModifiers(child);
      const attrs = extractAttributes(child);
      const isConst = modifiers.includes('const');

      // field_declaration contains variable_declaration which contains variable_declarator(s)
      const varDecl = findChildByType(child, 'variable_declaration');
      const declNode = varDecl ?? child;

      for (const vc of declNode.namedChildren) {
        if (vc.type === 'variable_declarator') {
          const name = getNodeName(vc);
          if (!name) continue;

          const kind: SymbolKind = isConst ? 'constant' : 'variable';
          const meta: Record<string, unknown> = {};

          if (attrs.length > 0) meta.attributes = attrs;
          if (modifiers.includes('static')) meta.static = true;
          if (modifiers.includes('readonly')) meta.readonly = true;
          if (isConst) meta.const = true;

          const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
          if (visibility) meta.visibility = visibility;

          symbols.push({
            symbolId: makeSymbolId(filePath, name, kind, className),
            name,
            kind,
            parentSymbolId: classSymbolId,
            signature: child.text.split('\n')[0].trim().replace(/;$/, ''),
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
            metadata: Object.keys(meta).length > 0 ? meta : undefined,
          });
        }
      }
    }
  }

  return symbols;
}

/** Extract event declarations from a class body. */
export function extractClassEvents(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'event_declaration' || child.type === 'event_field_declaration') {
      const modifiers = extractModifiers(child);
      const attrs = extractAttributes(child);
      const meta: Record<string, unknown> = { csharpKind: 'event' };

      if (attrs.length > 0) meta.attributes = attrs;
      if (modifiers.includes('static')) meta.static = true;
      if (modifiers.includes('abstract')) meta.abstract = true;
      if (modifiers.includes('virtual')) meta.virtual = true;
      if (modifiers.includes('override')) meta.override = true;

      const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
      if (visibility) meta.visibility = visibility;

      // event_field_declaration may have a variable_declaration with declarators
      const varDecl = findChildByType(child, 'variable_declaration');
      if (varDecl) {
        for (const vc of varDecl.namedChildren) {
          if (vc.type === 'variable_declarator') {
            const name = getNodeName(vc);
            if (!name) continue;

            symbols.push({
              symbolId: makeSymbolId(filePath, name, 'property', className),
              name,
              kind: 'property',
              parentSymbolId: classSymbolId,
              signature: child.text.split('\n')[0].trim().replace(/;$/, ''),
              byteStart: child.startIndex,
              byteEnd: child.endIndex,
              lineStart: child.startPosition.row + 1,
              lineEnd: child.endPosition.row + 1,
              metadata: { ...meta },
            });
          }
        }
      } else {
        // event_declaration with explicit accessors
        const name = getNodeName(child);
        if (name) {
          symbols.push({
            symbolId: makeSymbolId(filePath, name, 'property', className),
            name,
            kind: 'property',
            parentSymbolId: classSymbolId,
            signature: extractSignature(child),
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
            metadata: { ...meta },
          });
        }
      }
    }
  }

  return symbols;
}

/** Extract enum members from an enum body. */
export function extractEnumMembers(
  body: TSNode,
  filePath: string,
  enumName: string,
  enumSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'enum_member_declaration') {
      const name = getNodeName(child);
      if (!name) continue;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'enum_case', enumName),
        name,
        kind: 'enum_case',
        parentSymbolId: enumSymbolId,
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
      });
    }
  }

  return symbols;
}

/** Extract the namespace name from a namespace_declaration. */
export function extractNamespaceName(node: TSNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;
  // Fallback: look for qualified_name or identifier children
  for (const child of node.namedChildren) {
    if (child.type === 'qualified_name' || child.type === 'identifier') {
      return child.text;
    }
  }
  return undefined;
}

/** Find the first child of a given type. */
function findChildByType(node: TSNode, type: string): TSNode | undefined {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return undefined;
}
