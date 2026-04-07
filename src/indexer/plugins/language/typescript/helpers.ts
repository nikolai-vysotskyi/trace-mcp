/**
 * Helper utilities for the TypeScript language plugin.
 * Keeps the main plugin file under 300 lines.
 */
import type { RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';

export type { TSNode } from '../../../../parser/tree-sitter.js';

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
                // Always store the original exported name, not the local alias.
                // `import { Foo as Bar }` → specifier = "Foo" (matches the export).
                specifiers.push(name?.text ?? spec.text);
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

/**
 * Collect all unique AST node types within a subtree (shallow — immediate children only).
 * Used for detecting version-specific language features.
 */
export function collectNodeTypes(node: TSNode): string[] {
  const types = new Set<string>();
  types.add(node.type);
  for (const child of node.namedChildren) {
    types.add(child.type);
    // Go one level deeper to catch nested constructs (e.g. optional_chaining inside method body)
    for (const grandchild of child.namedChildren) {
      types.add(grandchild.type);
    }
  }
  return Array.from(types);
}

/**
 * Extract decorator names from a node's decorator children.
 * Works for class_declaration, method_definition, and any node
 * that can have `decorator` children in tree-sitter TS/JS grammar.
 */
export function extractDecorators(node: TSNode): string[] {
  const decorators: string[] = [];
  // Decorators are sibling children (prev siblings) of the decorated node,
  // or in the parent export_statement. Check both the node and its parent.
  const checkNode = (n: TSNode): void => {
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (!child || child.type !== 'decorator') continue;
      // decorator → expression (identifier, call_expression, member_expression)
      const expr = child.namedChildren[0];
      if (expr) {
        if (expr.type === 'identifier') {
          decorators.push(expr.text);
        } else if (expr.type === 'call_expression') {
          const fn = expr.childForFieldName('function');
          if (fn) decorators.push(fn.text);
        } else if (expr.type === 'member_expression') {
          decorators.push(expr.text);
        } else {
          decorators.push(expr.text);
        }
      }
    }
  };

  // Check previous siblings — TS grammar places decorators before the declaration
  if (node.parent) {
    const parent = node.parent;
    let foundSelf = false;
    for (let i = parent.namedChildCount - 1; i >= 0; i--) {
      const sibling = parent.namedChild(i);
      if (!sibling) continue;
      if (sibling.id === node.id) { foundSelf = true; continue; }
      if (foundSelf && sibling.type === 'decorator') {
        const expr = sibling.namedChildren[0];
        if (expr) {
          if (expr.type === 'identifier') {
            decorators.push(expr.text);
          } else if (expr.type === 'call_expression') {
            const fn = expr.childForFieldName('function');
            if (fn) decorators.push(fn.text);
          } else {
            decorators.push(expr.text);
          }
        }
      } else if (foundSelf && sibling.type !== 'decorator') {
        break; // Stop at non-decorator
      }
    }
  }

  // Also check direct children (for class body method decorators)
  checkNode(node);

  return decorators;
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

    const decorators = extractDecorators(child);
    const metadata: Record<string, unknown> = {
      async: isAsync(child),
    };
    if (decorators.length > 0) metadata.decorators = decorators;

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
      metadata,
    });
  }
  return symbols;
}
