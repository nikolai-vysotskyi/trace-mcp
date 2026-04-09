/**
 * Dart import / export / part edge extractors.
 * Extracted from DartLanguagePlugin to reduce cyclomatic complexity of the main file.
 */
import type { TSNode } from '../../../../parser/tree-sitter.js';
import type { RawEdge } from '../../../../plugin-api/types.js';

export function extractImportEdge(node: TSNode, edges: RawEdge[]): void {
  const uri = extractUri(node);
  if (!uri) return;
  edges.push({ edgeType: 'imports', metadata: { module: uri } });
}

export function extractExportEdge(node: TSNode, edges: RawEdge[]): void {
  const uri = extractUri(node);
  if (!uri) return;
  edges.push({ edgeType: 'imports', metadata: { module: uri, reexport: true } });
}

export function extractPartEdge(node: TSNode, edges: RawEdge[]): void {
  const uri = extractUri(node);
  if (!uri) return;
  edges.push({ edgeType: 'imports', metadata: { module: uri, part: true } });
}

export function extractPartOfEdge(node: TSNode, edges: RawEdge[]): void {
  const uri = extractUri(node);
  if (!uri) return;
  edges.push({ edgeType: 'imports', metadata: { module: uri, partOf: true } });
}

function extractUri(node: TSNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'configurable_uri' || child.type === 'uri') {
      for (const inner of child.namedChildren) {
        if (inner.type === 'string_literal' || inner.type === 'string') {
          return inner.text.replace(/^['"]|['"]$/g, '');
        }
      }
      const text = child.text.replace(/^['"]|['"]$/g, '');
      if (text && text !== child.type) return text;
    }
    if (child.type === 'string_literal' || child.type === 'string') {
      return child.text.replace(/^['"]|['"]$/g, '');
    }
  }
  const m = node.text.match(/['"]([^'"]+)['"]/);
  return m?.[1];
}
