/**
 * Helper utilities for the C++ language plugin.
 */
import type { RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';

export type { TSNode } from '../../../../parser/tree-sitter.js';

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
  // Strip trailing semicolons for declarations
  return firstLine.replace(/;\s*$/, '').trim();
}

export function getNodeName(node: TSNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text;
}

/**
 * Extract the declarator name from a function_definition or declaration node.
 * Handles qualified identifiers (ClassName::method), pointer declarators (*func),
 * and reference declarators (&func).
 */
export function extractDeclaratorName(node: TSNode): { name: string; qualifier?: string } | undefined {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return undefined;
  return extractNameFromDeclarator(declarator);
}

function extractNameFromDeclarator(decl: TSNode): { name: string; qualifier?: string } | undefined {
  switch (decl.type) {
    case 'function_declarator': {
      const inner = decl.childForFieldName('declarator');
      if (!inner) return undefined;
      return extractNameFromDeclarator(inner);
    }
    case 'qualified_identifier': {
      const scope = decl.childForFieldName('scope');
      const nameNode = decl.childForFieldName('name');
      if (nameNode) {
        return { name: nameNode.text, qualifier: scope?.text };
      }
      return undefined;
    }
    case 'identifier':
      return { name: decl.text };
    case 'pointer_declarator':
    case 'reference_declarator': {
      const inner = decl.namedChildren[0];
      if (inner) return extractNameFromDeclarator(inner);
      return undefined;
    }
    case 'destructor_name':
      return { name: decl.text };
    case 'operator_name':
      return { name: decl.text };
    case 'field_identifier':
      return { name: decl.text };
    default:
      // For template_function or other wrapping types, try the first named child
      if (decl.namedChildren.length > 0) {
        return extractNameFromDeclarator(decl.namedChildren[0]);
      }
      return undefined;
  }
}

/**
 * Extract template parameters from a template_declaration's template_parameter_list.
 */
export function extractTemplateParams(node: TSNode): string | undefined {
  if (node.type !== 'template_declaration') return undefined;
  const paramList = node.childForFieldName('parameters');
  if (paramList) return paramList.text;
  // Fallback: look for template_parameter_list child
  for (const child of node.namedChildren) {
    if (child.type === 'template_parameter_list') {
      return child.text;
    }
  }
  return undefined;
}

/**
 * Extract #include directives and using-namespace directives as import edges.
 */
export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const child of root.namedChildren) {
    if (child.type === 'preproc_include') {
      const pathNode = child.childForFieldName('path');
      if (pathNode) {
        const raw = pathNode.text;
        const importPath = raw.replace(/^["<]|[">]$/g, '');
        const isSystem = raw.startsWith('<');
        edges.push({
          edgeType: 'imports',
          metadata: { module: importPath, ...(isSystem ? { system: true } : {}) },
        });
      }
    } else if (child.type === 'using_declaration') {
      // using namespace std; is a using_declaration in tree-sitter-cpp
      const text = child.text.trim();
      const nsMatch = text.match(/^using\s+namespace\s+([\w:]+)\s*;?$/);
      if (nsMatch) {
        edges.push({
          edgeType: 'imports',
          metadata: { module: nsMatch[1], usingNamespace: true },
        });
      }
    }
  }
  return edges;
}

/**
 * Extract field declarations from a class/struct body (field_declaration_list).
 */
export function extractClassFields(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
  fqnParts: string[],
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  let currentAccess: string | undefined;

  for (const child of body.namedChildren) {
    if (child.type === 'access_specifier') {
      currentAccess = child.text.replace(/:$/, '').trim();
      continue;
    }

    if (child.type === 'field_declaration') {
      // A field_declaration can have one or more declarators
      const declarator = child.childForFieldName('declarator');
      if (declarator) {
        const info = extractNameFromDeclarator(declarator);
        if (info) {
          const meta: Record<string, unknown> = {};
          if (currentAccess) meta.access = currentAccess;
          const typeNode = child.childForFieldName('type');
          if (typeNode) meta.type = typeNode.text;

          // Check for static
          if (child.text.trim().startsWith('static ')) meta.static = true;

          symbols.push({
            symbolId: makeSymbolId(filePath, info.name, 'property', className),
            name: info.name,
            kind: 'property',
            parentSymbolId: classSymbolId,
            fqn: makeFqn([...fqnParts, info.name]),
            signature: child.text.split('\n')[0].trim().replace(/;\s*$/, ''),
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

/**
 * Extract enumerator values from an enumerator_list.
 */
export function extractEnumCases(
  body: TSNode,
  filePath: string,
  enumName: string,
  enumSymbolId: string,
  fqnParts: string[],
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
        fqn: makeFqn([...fqnParts, name]),
        signature: child.text.trim().replace(/,\s*$/, ''),
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

/**
 * Check if a function declaration has a pure virtual clause (= 0).
 */
export function isPureVirtual(node: TSNode): boolean {
  // Look for a child that is ` = 0`
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'pure_virtual_clause') return true;
  }
  // Also check text as fallback
  return /=\s*0\s*;?\s*$/.test(node.text.trim());
}

/**
 * Check if a node has 'virtual' specifier among its children.
 */
export function isVirtual(node: TSNode): boolean {
  for (const child of node.namedChildren) {
    if (child.type === 'virtual_function_specifier' || child.type === 'virtual') return true;
  }
  // Also check unnamed children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'virtual_function_specifier' || child.type === 'virtual')) return true;
  }
  return false;
}
