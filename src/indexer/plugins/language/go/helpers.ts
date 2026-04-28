/**
 * Helper utilities for the Go language plugin.
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
  return parts.filter(Boolean).join('.');
}

export function extractPackageName(root: TSNode): string | undefined {
  for (const child of root.namedChildren) {
    if (child.type === 'package_clause') {
      const nameNode = child.namedChildren.find((c) => c.type === 'package_identifier');
      return nameNode?.text;
    }
  }
  return undefined;
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

export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const child of root.namedChildren) {
    if (child.type === 'import_declaration') {
      for (const spec of child.namedChildren) {
        if (spec.type === 'import_spec') {
          const pathNode = spec.childForFieldName('path');
          if (pathNode) {
            const importPath = pathNode.text.replace(/^"|"$/g, '');
            const alias = spec.childForFieldName('name')?.text;
            edges.push({
              edgeType: 'imports',
              metadata: { module: importPath, ...(alias ? { alias } : {}) },
            });
          }
        } else if (spec.type === 'import_spec_list') {
          for (const inner of spec.namedChildren) {
            if (inner.type === 'import_spec') {
              const pathNode = inner.childForFieldName('path');
              if (pathNode) {
                const importPath = pathNode.text.replace(/^"|"$/g, '');
                const alias = inner.childForFieldName('name')?.text;
                edges.push({
                  edgeType: 'imports',
                  metadata: { module: importPath, ...(alias ? { alias } : {}) },
                });
              }
            }
          }
        } else if (spec.type === 'interpreted_string_literal') {
          const importPath = spec.text.replace(/^"|"$/g, '');
          edges.push({ edgeType: 'imports', metadata: { module: importPath } });
        }
      }
    }
  }
  return edges;
}

export function extractStructFields(
  body: TSNode,
  filePath: string,
  structName: string,
  structSymbolId: string,
): { symbols: RawSymbol[]; embeds: string[] } {
  const symbols: RawSymbol[] = [];
  const embeds: string[] = [];

  for (const child of body.namedChildren) {
    if (child.type === 'field_declaration') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        const name = nameNode.text;
        const typeNode = child.childForFieldName('type');
        const tag = child.namedChildren.find(
          (c) => c.type === 'raw_string_literal' || c.type === 'interpreted_string_literal',
        );
        const meta: Record<string, unknown> = {};
        if (typeNode) meta.type = typeNode.text;
        if (tag) meta.tag = tag.text.replace(/^`|`$/g, '');

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
      } else {
        // Embedded struct (anonymous field)
        const typeNode = child.childForFieldName('type');
        if (typeNode) {
          const typeName = typeNode.text.replace(/^\*/, '');
          embeds.push(typeName);
        }
      }
    }
  }

  return { symbols, embeds };
}

export function extractInterfaceMethods(
  body: TSNode,
  filePath: string,
  ifaceName: string,
  ifaceSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type === 'method_spec') {
      const name = getNodeName(child);
      if (!name) continue;
      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'method', ifaceName),
        name,
        kind: 'method',
        parentSymbolId: ifaceSymbolId,
        fqn: makeFqn([ifaceName, name]),
        signature: child.text.trim(),
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
      });
    }
  }
  return symbols;
}
