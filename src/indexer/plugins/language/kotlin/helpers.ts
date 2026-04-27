/**
 * Helper utilities for the Kotlin language plugin.
 * Extracts AST-walking logic to keep the main plugin concise.
 */
import type { RawEdge, RawSymbol, SymbolKind } from '../../../../plugin-api/types.js';

export type { TSNode } from '../../../../parser/tree-sitter.js';

import type { TSNode } from '../../../../parser/tree-sitter.js';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

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

export function makeFqn(parts: string[]): string {
  return parts.filter(Boolean).join('.');
}

export function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  const braceIdx = firstLine.indexOf('{');
  if (braceIdx > 0) {
    return firstLine.substring(0, braceIdx).trim();
  }
  return firstLine.replace(/;$/, '').trim();
}

export function getNodeName(node: TSNode): string | undefined {
  // Kotlin tree-sitter uses different name node types depending on declaration
  // class_declaration  → type_identifier
  // function_declaration → simple_identifier
  // property_declaration → (inside variable_declaration → simple_identifier)
  // object_declaration → type_identifier
  // type_alias → type_identifier
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  // Fallback: first type_identifier or simple_identifier child
  for (const child of node.namedChildren) {
    if (child.type === 'type_identifier' || child.type === 'simple_identifier') {
      return child.text;
    }
  }
  return undefined;
}

function findChildByType(node: TSNode, type: string): TSNode | undefined {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return undefined;
}

function findChildrenByType(node: TSNode, type: string): TSNode[] {
  const results: TSNode[] = [];
  for (const child of node.namedChildren) {
    if (child.type === type) results.push(child);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

export function extractPackageName(root: TSNode): string | undefined {
  const pkgHeader = findChildByType(root, 'package_header');
  if (!pkgHeader) return undefined;
  // package_header contains an identifier child with the dotted name
  const ident = findChildByType(pkgHeader, 'identifier');
  if (ident) return ident.text;
  // Fallback: grab text and parse
  const match = pkgHeader.text.match(/^package\s+([\w.]+)/);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];

  const importList = findChildByType(root, 'import_list');
  const importNodes = importList
    ? findChildrenByType(importList, 'import_header')
    : findChildrenByType(root, 'import_header');

  for (const imp of importNodes) {
    const ident = findChildByType(imp, 'identifier');
    if (!ident) continue;

    const importPath = ident.text;
    const parts = importPath.split('.');
    const simpleName = parts[parts.length - 1];

    // Check for wildcard (import foo.bar.*)
    let isWildcard = false;
    for (let i = 0; i < imp.childCount; i++) {
      const child = imp.child(i);
      if (child && (child.type === 'wildcard_import' || child.text === '*')) {
        isWildcard = true;
        break;
      }
    }

    const fullPath = isWildcard ? `${importPath}.*` : importPath;

    edges.push({
      edgeType: 'imports',
      metadata: {
        from: fullPath,
        // Always store the original name, not the alias.
        // `import foo.Bar as Baz` → specifier = "Bar" (matches the export).
        specifiers: isWildcard ? ['*'] : [simpleName],
      },
    });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

/**
 * Extract modifier keyword strings from a declaration node's `modifiers` child.
 * Handles class_modifier, visibility_modifier, member_modifier, function_modifier,
 * property_modifier, inheritance_modifier, etc.
 */
export function extractModifiers(node: TSNode): string[] {
  const keywords: string[] = [];
  const modifiers = findChildByType(node, 'modifiers');
  if (!modifiers) return keywords;

  for (const child of modifiers.namedChildren) {
    // Each modifier node (e.g. class_modifier, visibility_modifier) has text like "data", "public", etc.
    const text = child.text.trim();
    if (text) keywords.push(text);
  }
  return keywords;
}

/**
 * Extract annotation names from a declaration node's `modifiers` child.
 */
export function extractAnnotations(node: TSNode): string[] {
  const annotations: string[] = [];
  const modifiers = findChildByType(node, 'modifiers');
  if (!modifiers) return annotations;

  for (const child of modifiers.namedChildren) {
    if (child.type === 'annotation') {
      // annotation contains user_type or constructor_invocation
      const userType =
        findChildByType(child, 'user_type') ?? findChildByType(child, 'constructor_invocation');
      if (userType) {
        annotations.push(userType.text.replace(/\(.*\)$/, '').trim());
      } else {
        // Fallback: strip @ prefix
        const text = child.text
          .replace(/^@/, '')
          .replace(/\(.*\)$/, '')
          .trim();
        if (text) annotations.push(text);
      }
    }
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// Detect class kind (class vs interface vs enum)
// ---------------------------------------------------------------------------

/**
 * Determine whether a class_declaration is actually an interface or enum class.
 * tree-sitter-kotlin uses `class_declaration` for all of: class, interface, enum class.
 * We distinguish them by looking at unnamed keyword children.
 */
export function detectClassKind(node: TSNode): 'class' | 'interface' | 'enum' {
  const modifiers = extractModifiers(node);

  // Check all children (named and unnamed) for the keyword token.
  // tree-sitter-kotlin represents `enum class` as: modifiers(class_modifier("enum")) + "class"
  // but also emits an `enum_class_body` instead of `class_body` — check that too.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.text === 'interface') return 'interface';
    if (child.type === 'enum_class_body') return 'enum';
  }

  if (modifiers.includes('enum')) return 'enum';

  return 'class';
}

// ---------------------------------------------------------------------------
// Heritage (extends / implements)
// ---------------------------------------------------------------------------

export function extractHeritage(node: TSNode): { extends_?: string; implements_?: string[] } {
  const result: { extends_?: string; implements_?: string[] } = {};
  const parents: string[] = [];

  // In tree-sitter-kotlin, delegation_specifier nodes are direct children
  // of class_declaration (not wrapped in a delegation_specifiers container).
  // Also check for a delegation_specifiers wrapper just in case.
  for (const child of node.namedChildren) {
    if (child.type === 'delegation_specifier') {
      extractDelegationSpecifier(child, parents);
    } else if (child.type === 'delegation_specifiers') {
      // Some grammar versions may use a wrapper
      for (const inner of child.namedChildren) {
        if (inner.type === 'delegation_specifier') {
          extractDelegationSpecifier(inner, parents);
        }
      }
    }
  }

  if (parents.length > 0) {
    // First parent with constructor invocation is typically the superclass
    result.extends_ = parents[0];
    if (parents.length > 1) {
      result.implements_ = parents.slice(1);
    }
  }

  return result;
}

function extractDelegationSpecifier(node: TSNode, parents: string[]): void {
  for (const inner of node.namedChildren) {
    if (inner.type === 'constructor_invocation') {
      const userType = findChildByType(inner, 'user_type');
      if (userType) parents.push(userType.text);
      else parents.push(inner.text.replace(/\(.*\)$/, '').trim());
    } else if (inner.type === 'user_type') {
      parents.push(inner.text);
    } else if (inner.type === 'explicit_delegation') {
      const userType = findChildByType(inner, 'user_type');
      if (userType) parents.push(userType.text);
    }
  }
}

// ---------------------------------------------------------------------------
// Class body members
// ---------------------------------------------------------------------------

export function extractClassMethods(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
  packageName: string | undefined,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'function_declaration') {
      const name = getNodeName(child);
      if (!name) continue;

      const modifiers = extractModifiers(child);
      const annotations = extractAnnotations(child);
      const meta: Record<string, unknown> = {};

      if (annotations.length > 0) meta.annotations = annotations;
      if (modifiers.includes('override')) meta.override = true;
      if (modifiers.includes('suspend')) meta.suspend = true;
      if (modifiers.includes('abstract')) meta.abstract = true;
      if (modifiers.includes('open')) meta.open = true;
      if (modifiers.includes('inline')) meta.inline = true;

      const visibility = modifiers.find((m) =>
        ['public', 'private', 'protected', 'internal'].includes(m),
      );
      if (visibility) meta.visibility = visibility;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'method', className),
        name,
        kind: 'method',
        fqn: makeFqn(packageName ? [packageName, className, name] : [className, name]),
        parentSymbolId: classSymbolId,
        signature: extractSignature(child),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    } else if (child.type === 'secondary_constructor') {
      const modifiers = extractModifiers(child);
      const meta: Record<string, unknown> = { isConstructor: true };

      const visibility = modifiers.find((m) =>
        ['public', 'private', 'protected', 'internal'].includes(m),
      );
      if (visibility) meta.visibility = visibility;

      symbols.push({
        symbolId: makeSymbolId(filePath, 'constructor', 'method', className),
        name: 'constructor',
        kind: 'method',
        parentSymbolId: classSymbolId,
        signature: extractSignature(child),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: meta,
      });
    }
  }

  return symbols;
}

export function extractClassProperties(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
  packageName: string | undefined,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'property_declaration') {
      const propInfo = extractPropertyInfo(child);
      if (!propInfo) continue;

      const { name, type, isConst, isVal } = propInfo;
      const modifiers = extractModifiers(child);

      // const val inside companion object or top-level are constants
      const kind: SymbolKind = isConst ? 'constant' : 'property';

      const meta: Record<string, unknown> = {};
      if (type) meta.type = type;
      if (isVal) meta.val = true;
      if (modifiers.includes('override')) meta.override = true;
      if (modifiers.includes('lateinit')) meta.lateinit = true;
      if (modifiers.includes('lazy')) meta.lazy = true;

      const visibility = modifiers.find((m) =>
        ['public', 'private', 'protected', 'internal'].includes(m),
      );
      if (visibility) meta.visibility = visibility;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, kind, className),
        name,
        kind,
        fqn: makeFqn(packageName ? [packageName, className, name] : [className, name]),
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

export function extractEnumEntries(
  body: TSNode,
  filePath: string,
  enumName: string,
  enumSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'enum_entry') {
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

// ---------------------------------------------------------------------------
// Property info extraction
// ---------------------------------------------------------------------------

function extractPropertyInfo(
  node: TSNode,
): { name: string; type?: string; isConst: boolean; isVal: boolean } | undefined {
  const modifiers = extractModifiers(node);
  const isConst = modifiers.includes('const');

  // Check if val or var by looking at unnamed children
  let isVal = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.text === 'val') {
      isVal = true;
      break;
    }
  }

  // property_declaration may contain variable_declaration with the name
  const varDecl = findChildByType(node, 'variable_declaration');
  if (varDecl) {
    const name = getNodeName(varDecl);
    if (!name) return undefined;
    // Type annotation is a sibling or child
    const typeNode =
      findChildByType(varDecl, 'user_type') ?? findChildByType(varDecl, 'nullable_type');
    return { name, type: typeNode?.text, isConst: isConst || (isVal && isAllCaps(name)), isVal };
  }

  // Fallback: name might be directly on the node
  const name = getNodeName(node);
  if (!name) return undefined;
  const typeNode = findChildByType(node, 'user_type') ?? findChildByType(node, 'nullable_type');
  return { name, type: typeNode?.text, isConst: isConst || (isVal && isAllCaps(name)), isVal };
}

function isAllCaps(name: string): boolean {
  return /^[A-Z][A-Z0-9_]+$/.test(name);
}

// ---------------------------------------------------------------------------
// Companion object
// ---------------------------------------------------------------------------

export function extractCompanionObject(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
  packageName: string | undefined,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'companion_object') {
      const companionName = getNodeName(child) ?? 'Companion';
      const companionId = makeSymbolId(filePath, companionName, 'class', className);

      symbols.push({
        symbolId: companionId,
        name: companionName,
        kind: 'class',
        fqn: makeFqn(
          packageName ? [packageName, className, companionName] : [className, companionName],
        ),
        parentSymbolId: classSymbolId,
        signature: extractSignature(child),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: { companion: true },
      });

      // Extract members of companion object
      const companionBody = findChildByType(child, 'class_body');
      if (companionBody) {
        symbols.push(
          ...extractClassMethods(
            companionBody,
            filePath,
            companionName,
            companionId,
            packageName ? `${packageName}.${className}` : className,
          ),
        );
        symbols.push(
          ...extractClassProperties(
            companionBody,
            filePath,
            companionName,
            companionId,
            packageName ? `${packageName}.${className}` : className,
          ),
        );
      }
    }
  }

  return symbols;
}
