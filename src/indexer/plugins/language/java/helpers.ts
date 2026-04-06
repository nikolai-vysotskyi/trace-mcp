/**
 * Helper utilities for the Java language plugin.
 * Extracts AST-walking logic to keep the main plugin concise.
 */
import type { RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';

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

/** Build a dotted fully-qualified name. */
export function makeFqn(parts: string[]): string {
  return parts.filter(Boolean).join('.');
}

/** Convert a file path to a Java-style dotted module path. */
export function filePathToModule(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\.java$/, '')
    .replace(/\//g, '.');
}

/** Extract the package name from the root AST node. */
export function extractPackageName(root: TSNode): string | undefined {
  for (const child of root.namedChildren) {
    if (child.type === 'package_declaration') {
      // The package_declaration contains a scoped_identifier or identifier
      for (const inner of child.namedChildren) {
        if (inner.type === 'scoped_identifier' || inner.type === 'identifier') {
          return inner.text;
        }
      }
    }
  }
  return undefined;
}

/** Extract signature (first line of a node). */
export function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  // Trim trailing opening brace
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

/** Extract annotation names from a modifiers node. */
export function extractAnnotations(node: TSNode): string[] {
  const annotations: string[] = [];
  const modifiers = node.childForFieldName('modifiers') ?? findChildByType(node, 'modifiers');
  if (!modifiers) return annotations;

  for (const child of modifiers.namedChildren) {
    if (child.type === 'marker_annotation' || child.type === 'annotation') {
      const nameNode = child.childForFieldName('name') ?? findChildByType(child, 'identifier') ?? findChildByType(child, 'scoped_identifier');
      if (nameNode) {
        annotations.push(nameNode.text);
      }
    }
  }
  return annotations;
}

/** Extract modifier keywords (public, static, final, abstract, etc.) from a modifiers node. */
function extractModifierKeywords(node: TSNode): string[] {
  const keywords: string[] = [];
  const modifiers = node.childForFieldName('modifiers') ?? findChildByType(node, 'modifiers');
  if (!modifiers) return keywords;

  for (let i = 0; i < modifiers.childCount; i++) {
    const child = modifiers.child(i);
    if (!child) continue;
    if (!child.isNamed && ['public', 'private', 'protected', 'static', 'final', 'abstract', 'default', 'synchronized', 'native', 'transient', 'volatile'].includes(child.text)) {
      keywords.push(child.text);
    }
  }
  return keywords;
}

/** Find extends/implements clauses on a class_declaration. */
export function extractSuperTypes(node: TSNode): { extends_?: string; implements_?: string[] } {
  const result: { extends_?: string; implements_?: string[] } = {};

  const superclass = node.childForFieldName('superclass');
  if (superclass) {
    // superclass node may be a type_identifier itself, or a wrapper containing one
    const typeNode = superclass.type === 'type_identifier' || superclass.type === 'generic_type' || superclass.type === 'scoped_type_identifier'
      ? superclass
      : superclass.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier');
    result.extends_ = typeNode ? typeNode.text : superclass.text.replace(/^extends\s+/, '').trim();
  }

  const interfaces = node.childForFieldName('interfaces');
  if (interfaces) {
    // super_interfaces / interface_type_list
    const types: string[] = [];
    for (const child of interfaces.namedChildren) {
      if (child.type === 'type_list') {
        for (const t of child.namedChildren) {
          types.push(t.text);
        }
      } else {
        types.push(child.text);
      }
    }
    if (types.length > 0) result.implements_ = types;
  }

  return result;
}

/** Find extends clauses on an interface_declaration. */
export function extractInterfaceExtends(node: TSNode): string[] {
  const result: string[] = [];
  const extendsNode = node.childForFieldName('extends');
  if (extendsNode) {
    // extends_interfaces / interface_type_list
    for (const child of extendsNode.namedChildren) {
      if (child.type === 'type_list') {
        for (const t of child.namedChildren) {
          result.push(t.text);
        }
      } else {
        result.push(child.text);
      }
    }
  }
  return result;
}

/** Extract import edges from the root program node. */
export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const node of root.namedChildren) {
    if (node.type === 'import_declaration') {
      // import_declaration contains a scoped_identifier and optionally asterisk
      let importPath = '';
      let isWildcard = false;

      for (const child of node.namedChildren) {
        if (child.type === 'scoped_identifier' || child.type === 'identifier') {
          importPath = child.text;
        }
        if (child.type === 'asterisk') {
          isWildcard = true;
        }
      }

      // Check for static import
      let isStatic = false;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.text === 'static') {
          isStatic = true;
          break;
        }
      }

      if (importPath) {
        const fullPath = isWildcard ? `${importPath}.*` : importPath;
        const lastDot = importPath.lastIndexOf('.');
        const simpleName = lastDot >= 0 ? importPath.substring(lastDot + 1) : importPath;

        edges.push({
          edgeType: 'imports',
          metadata: {
            from: fullPath,
            specifiers: isWildcard ? ['*'] : [simpleName],
            ...(isStatic ? { static: true } : {}),
          },
        });
      }
    }
  }

  return edges;
}

/** Extract methods from a class body. */
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

      const annotations = extractAnnotations(child);
      const modifiers = extractModifierKeywords(child);
      const meta: Record<string, unknown> = {};

      if (annotations.length > 0) meta.annotations = annotations;
      if (modifiers.includes('static')) meta.static = true;
      if (modifiers.includes('abstract')) meta.abstract = true;
      if (modifiers.includes('final')) meta.final = true;
      if (annotations.includes('Override')) meta.override = true;

      const visibility = modifiers.find((m) => ['public', 'private', 'protected'].includes(m));
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
      const annotations = extractAnnotations(child);
      const modifiers = extractModifierKeywords(child);
      const meta: Record<string, unknown> = {};

      if (annotations.length > 0) meta.annotations = annotations;
      meta.isConstructor = true;
      const visibility = modifiers.find((m) => ['public', 'private', 'protected'].includes(m));
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

/** Extract fields from a class body. */
export function extractClassFields(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'field_declaration') {
      const annotations = extractAnnotations(child);
      const modifiers = extractModifierKeywords(child);

      // A field_declaration can have multiple variable_declarators
      for (const vc of child.namedChildren) {
        if (vc.type === 'variable_declarator') {
          const name = getNodeName(vc);
          if (!name) continue;

          const isConstant = modifiers.includes('static') && modifiers.includes('final');
          const kind: SymbolKind = isConstant ? 'constant' : 'property';

          const meta: Record<string, unknown> = {};
          if (annotations.length > 0) meta.annotations = annotations;
          if (modifiers.includes('static')) meta.static = true;
          if (modifiers.includes('final')) meta.final = true;
          const visibility = modifiers.find((m) => ['public', 'private', 'protected'].includes(m));
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

/** Extract enum constants from an enum body. */
export function extractEnumConstants(
  body: TSNode,
  filePath: string,
  enumName: string,
  enumSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'enum_constant') {
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

/** Check if a name is ALL_CAPS (constant naming convention). */
function isAllCaps(name: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,}$/.test(name);
}

/** Find the first child of a given type. */
function findChildByType(node: TSNode, type: string): TSNode | undefined {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return undefined;
}
