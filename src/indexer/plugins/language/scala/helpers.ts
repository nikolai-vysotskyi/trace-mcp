/**
 * Helper utilities for the Scala language plugin.
 * Extracts AST-walking logic to keep the main plugin manageable.
 */
import type { RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';

export type { TSNode } from '../../../../parser/tree-sitter.js';

/** Build a symbol ID following the convention: `path::Name#kind` */
export function makeSymbolId(
  filePath: string,
  name: string,
  kind: SymbolKind,
  parentName?: string,
): string {
  if (parentName) {
    return `${filePath}::${parentName}::${name}#${kind}`;
  }
  return `${filePath}::${name}#${kind}`;
}

/** Build a dotted fully-qualified name for a Scala symbol. */
export function makeFqn(parts: string[]): string {
  return parts.filter(Boolean).join('.');
}

/**
 * Extract signature — first line of the node text, trimmed of body braces.
 * For Scala: `class Foo extends Bar {` → `class Foo extends Bar`
 */
export function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  const braceIdx = firstLine.lastIndexOf('{');
  if (braceIdx > 0) {
    return firstLine.substring(0, braceIdx).trim();
  }
  return firstLine;
}

/** Get the name field from a node. Falls back to finding an identifier child. */
export function getNodeName(node: TSNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;
  // Fallback: find the first identifier child
  for (const child of node.namedChildren) {
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      return child.text;
    }
  }
  return undefined;
}

/**
 * Extract the package name from a package_clause node.
 * tree-sitter-scala uses `package_identifier` or nested identifiers.
 */
export function extractPackageName(node: TSNode): string | undefined {
  // Try field 'name' first
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  // Fallback: look for package_identifier or identifier children
  for (const child of node.namedChildren) {
    if (child.type === 'package_identifier' || child.type === 'identifier') {
      return child.text;
    }
  }
  return undefined;
}

/**
 * Check if a node's text starts with `case` keyword (for case class / case object detection).
 */
export function isCaseDefinition(node: TSNode): boolean {
  // Walk backward through non-named children looking for 'case' keyword
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'case') return true;
    // In some grammars, case appears as a plain text token
    if (!child.isNamed && child.text === 'case') return true;
    // Stop once we reach the main keyword
    if (child.text === 'class' || child.text === 'object') break;
  }
  return false;
}

/**
 * Extract modifiers from a Scala definition node.
 * Returns an array of modifier strings like ['sealed', 'abstract', 'final', 'implicit', 'lazy', 'override', 'private', 'protected'].
 */
export function extractModifiers(node: TSNode): string[] {
  const modifiers: string[] = [];
  const modifierTypes = new Set([
    'sealed',
    'abstract',
    'final',
    'implicit',
    'lazy',
    'override',
    'private',
    'protected',
    'open',
    'transparent',
    'inline',
    'opaque',
    'export',
  ]);

  // Check non-named children (keywords) and named children (access_modifier, etc.)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    // Stop at the main definition keyword
    if (
      child.text === 'class' ||
      child.text === 'object' ||
      child.text === 'trait' ||
      child.text === 'def' ||
      child.text === 'val' ||
      child.text === 'var' ||
      child.text === 'type' ||
      child.text === 'enum' ||
      child.text === 'given'
    ) {
      break;
    }
    if (modifierTypes.has(child.text)) {
      modifiers.push(child.text);
    }
    // Handle modifiers node wrapping multiple modifier keywords
    if (
      child.type === 'modifiers' ||
      child.type === 'access_modifier' ||
      child.type === 'annotation'
    ) {
      for (const inner of child.isNamed ? [child] : []) {
        if (modifierTypes.has(inner.text)) modifiers.push(inner.text);
      }
      // Also check text-based children within modifier nodes
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner && modifierTypes.has(inner.text)) {
          modifiers.push(inner.text);
        }
      }
    }
  }

  return modifiers;
}

/**
 * Extract extends/with clauses from a class/trait/object definition.
 * Returns { extends?: string[], with?: string[] }
 */
export function extractInheritance(node: TSNode): { extends?: string[]; mixins?: string[] } {
  const result: { extends?: string[]; mixins?: string[] } = {};
  const extendsNames: string[] = [];
  const mixinNames: string[] = [];

  // Look for extends_clause or template_body or parent nodes
  for (const child of node.namedChildren) {
    if (child.type === 'extends_clause') {
      // The extends clause contains the parent type(s)
      for (const grandchild of child.namedChildren) {
        if (
          grandchild.type === 'type_identifier' ||
          grandchild.type === 'generic_type' ||
          grandchild.type === 'stable_type_identifier'
        ) {
          const name =
            grandchild.type === 'generic_type'
              ? (grandchild.childForFieldName('name')?.text ??
                grandchild.namedChildren[0]?.text ??
                grandchild.text)
              : grandchild.text;
          extendsNames.push(name);
        }
      }
    }
  }

  // Some grammars put 'with' clauses as separate children
  let seenWith = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.text === 'with') {
      seenWith = true;
      continue;
    }
    if (seenWith && child.isNamed) {
      if (
        child.type === 'type_identifier' ||
        child.type === 'generic_type' ||
        child.type === 'stable_type_identifier'
      ) {
        const name =
          child.type === 'generic_type'
            ? (child.childForFieldName('name')?.text ?? child.namedChildren[0]?.text ?? child.text)
            : child.text;
        mixinNames.push(name);
      }
      seenWith = false;
    }
  }

  if (extendsNames.length > 0) result.extends = extendsNames;
  if (mixinNames.length > 0) result.mixins = mixinNames;
  return result;
}

/**
 * Extract type parameters from a class/trait/def definition.
 * e.g. `class Foo[A, B <: Bar]` → ['A', 'B']
 */
export function extractTypeParams(node: TSNode): string[] | undefined {
  const typeParams = node.childForFieldName('type_parameters');
  if (!typeParams) {
    // Fallback: look for type_parameters child by type
    for (const child of node.namedChildren) {
      if (child.type === 'type_parameters') {
        return extractTypeParamNames(child);
      }
    }
    return undefined;
  }
  return extractTypeParamNames(typeParams);
}

function extractTypeParamNames(typeParams: TSNode): string[] | undefined {
  const params: string[] = [];
  for (const child of typeParams.namedChildren) {
    const name = child.childForFieldName('name');
    if (name) {
      params.push(name.text);
    } else if (child.type === 'identifier' || child.type === 'type_identifier') {
      params.push(child.text);
    } else if (
      child.type === '_variant_type_parameter' ||
      child.type === 'covariant_type_parameter' ||
      child.type === 'contravariant_type_parameter'
    ) {
      // Variance annotations: +A or -B — get the inner name
      const innerName =
        child.childForFieldName('name') ??
        child.namedChildren.find((c) => c.type === 'identifier' || c.type === 'type_identifier');
      if (innerName) params.push(innerName.text);
    }
  }
  return params.length > 0 ? params : undefined;
}

/**
 * Extract import edges from import_declaration nodes.
 *
 * Scala imports:
 * - `import scala.collection.mutable` → { from: 'scala.collection.mutable', specifiers: ['mutable'] }
 * - `import scala.collection.mutable.{Map, Set}` → { from: 'scala.collection.mutable', specifiers: ['Map', 'Set'] }
 * - `import scala.collection.mutable._` → { from: 'scala.collection.mutable', specifiers: ['*'] }
 * - `import scala.collection.mutable.{Map => MMap}` → { from: 'scala.collection.mutable', specifiers: ['MMap'] }
 */
export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const child of root.namedChildren) {
    if (child.type === 'import_declaration') {
      // The import text is the most reliable way to parse Scala imports
      const importText = child.text.replace(/^import\s+/, '').trim();

      // Handle brace imports: path.{A, B, C}
      const braceMatch = importText.match(/^([\w.]+)\.\{([^}]+)\}$/);
      if (braceMatch) {
        const from = braceMatch[1];
        const specifiers = braceMatch[2]
          .split(',')
          .map((s) => {
            const renamed = s.trim().split(/\s*(?:=>|as)\s*/);
            // Always store the original name, not the rename target.
            // `import mutable.{Map => MMap}` → specifier = "Map" (matches the export).
            return renamed[0].trim();
          })
          .filter((s) => s !== '_' && s.length > 0);
        const hasWildcard = braceMatch[2].includes('_');

        edges.push({
          edgeType: 'imports',
          metadata: {
            from,
            specifiers: hasWildcard ? [...specifiers, '*'] : specifiers,
          },
        });
        continue;
      }

      // Handle wildcard import: path._
      const wildcardMatch = importText.match(/^([\w.]+)\._$/);
      if (wildcardMatch) {
        edges.push({
          edgeType: 'imports',
          metadata: { from: wildcardMatch[1], specifiers: ['*'] },
        });
        continue;
      }

      // Handle simple import: path.Name
      const parts = importText.split('.');
      if (parts.length > 0) {
        const specifier = parts[parts.length - 1];
        const from = parts.length > 1 ? parts.slice(0, -1).join('.') : importText;
        edges.push({
          edgeType: 'imports',
          metadata: { from, specifiers: [specifier] },
        });
      }
    }
  }

  return edges;
}

/** Extract methods/functions from a class/object/trait body. */
export function extractMethods(
  body: TSNode,
  filePath: string,
  containerName: string,
  containerSymbolId: string,
  fqnParts: string[],
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'function_definition' || child.type === 'function_declaration') {
      const name = getNodeName(child);
      if (!name) continue;

      const meta: Record<string, unknown> = {};
      if (child.type === 'function_declaration') meta.abstract = true;
      const mods = extractModifiers(child);
      if (mods.includes('override')) meta.override = true;
      if (mods.includes('implicit')) meta.implicit = true;
      if (mods.includes('private')) meta.private = true;
      if (mods.includes('protected')) meta.protected = true;
      if (mods.length > 0) meta.modifiers = mods;

      const typeParams = extractTypeParams(child);
      if (typeParams) meta.typeParams = typeParams;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'method', containerName),
        name,
        kind: 'method',
        fqn: makeFqn([...fqnParts, name]),
        parentSymbolId: containerSymbolId,
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

/** Extract val/var definitions from a class/object/trait body. */
export function extractValVarMembers(
  body: TSNode,
  filePath: string,
  containerName: string,
  containerSymbolId: string,
  fqnParts: string[],
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'val_definition' || child.type === 'val_declaration') {
      const name = extractValVarName(child);
      if (!name) continue;

      const meta: Record<string, unknown> = {};
      const mods = extractModifiers(child);
      if (mods.includes('lazy')) meta.lazy = true;
      if (mods.includes('override')) meta.override = true;
      if (mods.includes('implicit')) meta.implicit = true;
      if (mods.length > 0) meta.modifiers = mods;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'constant', containerName),
        name,
        kind: 'constant',
        fqn: makeFqn([...fqnParts, name]),
        parentSymbolId: containerSymbolId,
        signature: child.text.split('\n')[0].trim(),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    } else if (child.type === 'var_definition' || child.type === 'var_declaration') {
      const name = extractValVarName(child);
      if (!name) continue;

      const meta: Record<string, unknown> = {};
      const mods = extractModifiers(child);
      if (mods.includes('override')) meta.override = true;
      if (mods.length > 0) meta.modifiers = mods;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'variable', containerName),
        name,
        kind: 'variable',
        fqn: makeFqn([...fqnParts, name]),
        parentSymbolId: containerSymbolId,
        signature: child.text.split('\n')[0].trim(),
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

/** Extract type aliases from a body. */
export function extractTypeAliases(
  body: TSNode,
  filePath: string,
  containerName: string,
  containerSymbolId: string,
  fqnParts: string[],
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'type_definition') {
      const name = getNodeName(child);
      if (!name) continue;

      const meta: Record<string, unknown> = {};
      const mods = extractModifiers(child);
      if (mods.includes('opaque')) meta.opaque = true;
      if (mods.length > 0) meta.modifiers = mods;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'type', containerName),
        name,
        kind: 'type',
        fqn: makeFqn([...fqnParts, name]),
        parentSymbolId: containerSymbolId,
        signature: child.text.split('\n')[0].trim(),
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

/** Extract enum cases from an enum body (Scala 3). */
export function extractEnumCases(
  body: TSNode,
  filePath: string,
  enumName: string,
  enumSymbolId: string,
  fqnParts: string[],
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    // Scala 3 enum cases: `case North, South` or `case Color(r: Int, g: Int, b: Int)`
    if (
      child.type === 'enum_case_definitions' ||
      child.type === 'simple_enum_case' ||
      child.type === 'enum_case'
    ) {
      // May contain multiple case names
      for (const inner of child.namedChildren) {
        if (inner.type === 'identifier' || inner.type === 'simple_enum_case') {
          const name =
            inner.type === 'identifier' ? inner.text : (getNodeName(inner) ?? inner.text);
          symbols.push({
            symbolId: makeSymbolId(filePath, name, 'enum_case', enumName),
            name,
            kind: 'enum_case',
            fqn: makeFqn([...fqnParts, name]),
            parentSymbolId: enumSymbolId,
            byteStart: inner.startIndex,
            byteEnd: inner.endIndex,
            lineStart: inner.startPosition.row + 1,
            lineEnd: inner.endPosition.row + 1,
          });
        }
      }
      // If the node itself is a single case (e.g., `case Color(...)`)
      if (child.type === 'enum_case') {
        const caseName = getNodeName(child);
        if (caseName) {
          // Avoid duplicates if we already extracted from namedChildren
          const exists = symbols.some(
            (s) => s.name === caseName && s.parentSymbolId === enumSymbolId,
          );
          if (!exists) {
            symbols.push({
              symbolId: makeSymbolId(filePath, caseName, 'enum_case', enumName),
              name: caseName,
              kind: 'enum_case',
              fqn: makeFqn([...fqnParts, caseName]),
              parentSymbolId: enumSymbolId,
              signature: child.text.split('\n')[0].trim(),
              byteStart: child.startIndex,
              byteEnd: child.endIndex,
              lineStart: child.startPosition.row + 1,
              lineEnd: child.endPosition.row + 1,
            });
          }
        }
      }
    }
  }

  return symbols;
}

/**
 * Extract the name from a val/var definition.
 * val definitions may have a pattern (identifier) or a tuple pattern.
 * We only extract simple identifier patterns.
 */
export function extractValVarName(node: TSNode): string | undefined {
  // Try 'pattern' field first (tree-sitter-scala uses this)
  const pattern = node.childForFieldName('pattern');
  if (pattern) {
    if (pattern.type === 'identifier') return pattern.text;
    return undefined; // Skip tuple/complex patterns
  }

  // Try 'name' field
  const name = node.childForFieldName('name');
  if (name) return name.text;

  // Fallback: find first identifier child
  for (const child of node.namedChildren) {
    if (child.type === 'identifier') return child.text;
  }
  return undefined;
}
