/**
 * Helper utilities for the Python language plugin.
 * Extracts AST-walking logic to keep the main plugin under 300 lines.
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

/**
 * Collect all unique AST node types within a subtree (shallow — immediate children + one level deeper).
 * Used for detecting version-specific language features.
 */
export function collectNodeTypes(node: TSNode): string[] {
  const types = new Set<string>();
  types.add(node.type);
  for (const child of node.namedChildren) {
    types.add(child.type);
    for (const grandchild of child.namedChildren) {
      types.add(grandchild.type);
    }
  }
  return Array.from(types);
}

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

/**
 * Build a dotted fully-qualified name for a Python symbol.
 * Converts file path to module notation: `src/foo/bar.py` → `src.foo.bar`
 * Handles `__init__.py` → package name (strip the file).
 */
export function makeFqn(parts: string[]): string {
  return parts.join('.');
}

/** Convert a file path to a Python module path. */
export function filePathToModule(filePath: string): string {
  let module = filePath
    .replace(/\\/g, '/')
    .replace(/\.pyi?$/, '');
  // __init__ → use parent package
  if (module.endsWith('/__init__')) {
    module = module.slice(0, -'/__init__'.length);
  }
  return module.replace(/\//g, '.');
}

/** Extract signature (first line, trimmed of body colon). */
export function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  // For Python, trim trailing `:` and anything after it if it's a block opener
  const colonIdx = firstLine.lastIndexOf(':');
  if (colonIdx > 0) {
    return firstLine.substring(0, colonIdx).trim();
  }
  return firstLine;
}

/** Extract decorator names from a `decorated_definition` node's decorator children. */
export function extractDecorators(node: TSNode): string[] {
  const decorators: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'decorator') {
      // The decorator node contains an expression — usually identifier or call or attribute
      const expr = child.namedChildren[0];
      if (expr) {
        if (expr.type === 'identifier') {
          decorators.push(expr.text);
        } else if (expr.type === 'call') {
          const fn = expr.childForFieldName('function');
          if (fn) decorators.push(fn.text);
        } else if (expr.type === 'attribute') {
          decorators.push(expr.text);
        } else {
          decorators.push(expr.text);
        }
      }
    }
  }
  return decorators;
}

/**
 * Extract import edges from the root module node.
 *
 * - `import os.path` → { edgeType: 'py_imports', metadata: { from: 'os.path', specifiers: ['os'] } }
 * - `from myapp.models import User` → { from: 'myapp.models', specifiers: ['User'] }
 * - `from . import utils` → { from: '.', specifiers: ['utils'], relative: true }
 * - `from ..foo import bar` → { from: '..foo', specifiers: ['bar'], relative: true }
 */
export function extractImportEdges(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const node of root.namedChildren) {
    if (node.type === 'import_statement') {
      // `import os.path` or `import os.path as osp`
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name') {
          const moduleName = child.text;
          const topLevel = moduleName.split('.')[0];
          edges.push({
            edgeType: 'py_imports',
            metadata: { from: moduleName, specifiers: [topLevel] },
          });
        } else if (child.type === 'aliased_import') {
          const nameNode = child.childForFieldName('name') ?? child.namedChildren[0];
          const aliasNode = child.childForFieldName('alias');
          if (nameNode) {
            const moduleName = nameNode.text;
            const alias = aliasNode?.text ?? moduleName.split('.')[0];
            edges.push({
              edgeType: 'py_imports',
              metadata: { from: moduleName, specifiers: [alias] },
            });
          }
        }
      }
    } else if (node.type === 'import_from_statement') {
      // `from foo.bar import X, Y` or `from . import utils`
      const moduleNode = node.childForFieldName('module_name');

      // Collect dots for relative imports
      let dots = '';
      let moduleName = '';
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type === 'relative_import') {
          // relative_import contains dots and optional dotted_name
          for (const rc of child.namedChildren) {
            if (rc.type === 'dotted_name') {
              moduleName = rc.text;
            } else if (rc.type === 'import_prefix') {
              dots = rc.text;
            }
          }
          // If no named children found for dots, count dots from text
          if (!dots) {
            const dotMatch = child.text.match(/^(\.+)/);
            if (dotMatch) dots = dotMatch[1];
            // Get the module part after dots
            const afterDots = child.text.slice(dots.length).trim();
            if (afterDots && !moduleName) moduleName = afterDots;
          }
          break;
        }
      }

      // If no relative import, look for dotted_name as the module directly
      if (!dots && !moduleName && moduleNode) {
        moduleName = moduleNode.text;
      }
      if (!dots && !moduleName) {
        // Try to find dotted_name child directly
        for (const child of node.namedChildren) {
          if (child.type === 'dotted_name') {
            moduleName = child.text;
            break;
          }
        }
      }

      const fromPath = dots ? `${dots}${moduleName}` : moduleName;
      const isRelative = dots.length > 0;

      // Collect imported names
      const specifiers: string[] = [];
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name' && child !== moduleNode) {
          specifiers.push(child.text);
        } else if (child.type === 'aliased_import') {
          const nameNode = child.childForFieldName('name') ?? child.namedChildren[0];
          const aliasNode = child.childForFieldName('alias');
          if (nameNode) {
            specifiers.push(aliasNode?.text ?? nameNode.text);
          }
        }
      }

      // Handle wildcard import: `from foo import *`
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === 'wildcard_import') {
          specifiers.push('*');
        }
      }

      edges.push({
        edgeType: 'py_imports',
        metadata: {
          from: fromPath,
          specifiers,
          ...(isRelative ? { relative: true } : {}),
        },
      });
    }
  }

  return edges;
}

/** Get the name field from a node. */
export function getNodeName(node: TSNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text;
}

/**
 * Extract a type alias statement (Python 3.12+ PEP 695: `type X = ...`).
 * Returns a RawSymbol for the type alias or undefined if not a valid type alias.
 */
export function extractTypeAlias(
  node: TSNode, filePath: string, modulePath: string,
): RawSymbol | undefined {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const name = nameNode.text;

  return {
    symbolId: makeSymbolId(filePath, name, 'type'),
    name,
    kind: 'type',
    fqn: makeFqn([modulePath, name]),
    signature: node.text.split('\n')[0].trim(),
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    metadata: { minPythonVersion: '3.12' },
  };
}

/**
 * Extract type parameters from a function/class definition (Python 3.12+ PEP 695).
 * e.g. `def foo[T, U: int]()` → ['T', 'U']
 */
export function extractTypeParams(node: TSNode): string[] | undefined {
  const typeParams = node.childForFieldName('type_parameters');
  if (!typeParams) return undefined;

  const params: string[] = [];
  for (const child of typeParams.namedChildren) {
    const name = child.childForFieldName('name');
    if (name) {
      params.push(name.text);
    } else if (child.type === 'identifier') {
      params.push(child.text);
    }
  }
  return params.length > 0 ? params : undefined;
}

/** Check if a specific decorator is present in a decorator list. */
export function hasSpecialDecorator(decorators: string[], name: string): boolean {
  return decorators.some((d) => d === name || d.endsWith(`.${name}`));
}

/** Check if a name is ALL_CAPS (constant naming convention). */
export function isAllCaps(name: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,}$/.test(name);
}

/** Extract base class names from the argument_list in a class_definition. */
export function extractClassBases(node: TSNode): string[] {
  const bases: string[] = [];
  const superclasses = node.childForFieldName('superclasses');
  if (!superclasses) return bases;

  for (const child of superclasses.namedChildren) {
    if (child.type === 'identifier' || child.type === 'attribute') {
      bases.push(child.text);
    } else if (child.type === 'call') {
      // e.g. metaclass=ABCMeta — skip keyword args
      const fn = child.childForFieldName('function');
      if (fn) bases.push(fn.text);
    } else if (child.type === 'keyword_argument') {
      // Skip keyword arguments like metaclass=...
      continue;
    }
  }

  return bases;
}

/** Extract methods from a class body node. */
export function extractClassMethods(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    let funcNode: TSNode | null = null;
    let decorators: string[] = [];

    if (child.type === 'function_definition') {
      funcNode = child;
    } else if (child.type === 'decorated_definition') {
      decorators = extractDecorators(child);
      // Unwrap to get the actual function_definition
      funcNode = child.namedChildren.find(
        (c) => c.type === 'function_definition',
      ) ?? null;
    }

    if (!funcNode) continue;
    const name = getNodeName(funcNode);
    if (!name) continue;

    const isAsync = funcNode.namedChildren.some((c) => c.type === 'async');
    // Check if the function text starts with 'async'
    const asyncFlag = funcNode.text.trimStart().startsWith('async');

    const meta: Record<string, unknown> = {};
    if (asyncFlag || isAsync) meta.async = true;
    if (decorators.length > 0) meta.decorators = decorators;

    // Detect static/class methods via decorators
    if (decorators.includes('staticmethod')) meta.static = true;
    if (decorators.includes('classmethod')) meta.classmethod = true;
    if (decorators.includes('property')) meta.property = true;
    if (decorators.includes('abstractmethod')) meta.abstract = true;
    if (hasSpecialDecorator(decorators, 'override')) meta.override = true;
    if (hasSpecialDecorator(decorators, 'overload')) meta.overload = true;

    // Type parameters (Python 3.12+)
    const typeParams = extractTypeParams(funcNode);
    if (typeParams) {
      meta.typeParams = typeParams;
      meta.minPythonVersion = '3.12';
    }

    // Use the decorated_definition node for byte range if decorators present
    const rangeNode = child.type === 'decorated_definition' ? child : funcNode;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'method', className),
      name,
      kind: 'method',
      fqn: undefined, // set by the caller
      parentSymbolId: classSymbolId,
      signature: extractSignature(funcNode),
      byteStart: rangeNode.startIndex,
      byteEnd: rangeNode.endIndex,
      lineStart: rangeNode.startPosition.row + 1,
      lineEnd: rangeNode.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  return symbols;
}

/**
 * Extract instance attributes from `__init__` method body.
 * Looks for `self.x = ...` patterns in the method body.
 */
export function extractInstanceAttributes(
  body: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const seen = new Set<string>();

  walkForSelfAssignments(body, filePath, className, classSymbolId, symbols, seen);

  return symbols;
}

function walkForSelfAssignments(
  node: TSNode,
  filePath: string,
  className: string,
  classSymbolId: string,
  symbols: RawSymbol[],
  seen: Set<string>,
): void {
  for (const child of node.namedChildren) {
    if (child.type === 'expression_statement') {
      const expr = child.namedChildren[0];
      if (expr && expr.type === 'assignment') {
        const left = expr.childForFieldName('left');
        if (left && left.type === 'attribute') {
          const obj = left.childForFieldName('object');
          const attr = left.childForFieldName('attribute');
          if (obj && obj.text === 'self' && attr) {
            const name = attr.text;
            if (!seen.has(name)) {
              seen.add(name);
              symbols.push({
                symbolId: makeSymbolId(filePath, name, 'property', className),
                name,
                kind: 'property',
                parentSymbolId: classSymbolId,
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
    // Recurse into if/elif/else/for/while/try/with blocks inside __init__
    if (
      child.type === 'if_statement' ||
      child.type === 'for_statement' ||
      child.type === 'while_statement' ||
      child.type === 'try_statement' ||
      child.type === 'with_statement' ||
      child.type === 'block'
    ) {
      walkForSelfAssignments(child, filePath, className, classSymbolId, symbols, seen);
    }
  }
}
