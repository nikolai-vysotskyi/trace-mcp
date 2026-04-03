/**
 * Helper utilities for the TypeScript language plugin.
 * Keeps the main plugin file under 300 lines.
 */
import type { RawSymbol, RawEdge, SymbolKind } from '../../../plugin-api/types.js';

// Re-use the same TSNode type from the PHP helpers (tree-sitter CJS interop)
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

/** Build a symbol ID: `path::Name#kind` */
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

/** Extract signature (first line, trimmed of body). */
export function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  const braceIdx = firstLine.indexOf('{');
  if (braceIdx > 0) {
    return firstLine.substring(0, braceIdx).trim();
  }
  const semiIdx = firstLine.indexOf(';');
  if (semiIdx > 0) {
    return firstLine.substring(0, semiIdx).trim();
  }
  return firstLine;
}

/** Check if a node is wrapped in an export statement. */
export function isExported(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return parent.type === 'export_statement';
}

/** Check if the export is a default export. */
export function isDefaultExport(node: TSNode): boolean {
  const parent = node.parent;
  if (!parent || parent.type !== 'export_statement') return false;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (child && child.type === 'default') return true;
  }
  return false;
}

/** Check if a function/method node is async. */
export function isAsync(node: TSNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'async') return true;
  }
  return false;
}

/** Get the full signature line including export prefix from the export_statement parent. */
export function getFullSignature(node: TSNode): string {
  const exported = isExported(node);
  const def = isDefaultExport(node);
  const base = extractSignature(node);

  const parts: string[] = [];
  if (exported) parts.push('export');
  if (def) parts.push('default');
  parts.push(base);
  return parts.join(' ');
}

/** Extract name from a declaration node. */
export function getNodeName(node: TSNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text;
}

/** Extract import edges from the root of a TS/JS file. */
export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'import_statement') continue;
    const source = node.childForFieldName('source');
    if (!source) continue;
    const from = source.text.replace(/^['"]|['"]$/g, '');

    const specifiers: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'import_clause') {
        for (const inner of child.namedChildren) {
          if (inner.type === 'identifier') {
            specifiers.push(inner.text);
          } else if (inner.type === 'named_imports') {
            for (const spec of inner.namedChildren) {
              if (spec.type === 'import_specifier') {
                const alias = spec.childForFieldName('alias');
                const name = spec.childForFieldName('name');
                specifiers.push(alias?.text ?? name?.text ?? spec.text);
              }
            }
          } else if (inner.type === 'namespace_import') {
            const id = inner.namedChildren.find((c) => c.type === 'identifier');
            if (id) specifiers.push(`* as ${id.text}`);
          }
        }
      }
    }

    edges.push({
      edgeType: 'imports',
      metadata: { from, specifiers },
    });
  }
  return edges;
}

/** Extract class methods from a class body. */
export function extractClassMethods(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of body.namedChildren) {
    if (child.type !== 'method_definition') continue;
    const name = getNodeName(child);
    if (!name) continue;

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
      metadata: {
        async: isAsync(child),
      },
    });
  }
  return symbols;
}
