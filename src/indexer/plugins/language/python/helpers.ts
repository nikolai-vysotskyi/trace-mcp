/**
 * Helper utilities for the Python language plugin.
 * Extracts AST-walking logic to keep the main plugin under 300 lines.
 */
import type { RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';

export type { TSNode } from '../../../../parser/tree-sitter.js';

// ─── Visibility ──────────────────────────────────────────────

export type PythonVisibility = 'public' | 'private' | 'mangled' | 'dunder';

/** Detect Python naming convention visibility. */
export function detectVisibility(name: string): PythonVisibility {
  if (name.startsWith('__') && name.endsWith('__') && name.length > 4) return 'dunder';
  if (name.startsWith('__') && !name.endsWith('__')) return 'mangled';
  if (name.startsWith('_') && !name.startsWith('__')) return 'private';
  return 'public';
}

// ─── Docstrings ──────────────────────────────────────────────

/** Extract docstring from a function/class/module body (first expression_statement with a string). */
export function extractDocstring(node: TSNode): string | undefined {
  // For functions/classes: body is the block child
  const body = node.childForFieldName('body') ?? node;
  const firstChild = body.namedChildren[0];
  if (!firstChild || firstChild.type !== 'expression_statement') return undefined;

  const expr = firstChild.namedChildren[0];
  if (!expr) return undefined;
  if (expr.type !== 'string' && expr.type !== 'concatenated_string') return undefined;

  let text = expr.text;
  // Strip triple quotes
  if (text.startsWith('"""') || text.startsWith("'''")) {
    text = text.slice(3, -3);
  } else if (text.startsWith('"') || text.startsWith("'")) {
    text = text.slice(1, -1);
  }
  // Take first paragraph, trim, cap at 200 chars
  const firstPara = text.split('\n\n')[0].replace(/\s+/g, ' ').trim();
  return firstPara.length > 0 ? firstPara.slice(0, 200) : undefined;
}

// ─── __all__ extraction ──────────────────────────────────────

/** Extract the __all__ export list from a module root. Returns undefined if not present. */
export function extractAllList(root: TSNode): string[] | undefined {
  for (const node of root.namedChildren) {
    if (node.type !== 'expression_statement') continue;
    const expr = node.namedChildren[0];
    if (!expr || expr.type !== 'assignment') continue;
    const left = expr.childForFieldName('left');
    if (!left || left.text !== '__all__') continue;
    const right = expr.childForFieldName('right');
    if (!right) continue;

    // __all__ = ["Foo", "Bar"] or __all__ = ("Foo", "Bar")
    if (right.type === 'list' || right.type === 'tuple') {
      const names: string[] = [];
      for (const child of right.namedChildren) {
        if (child.type === 'string') {
          let text = child.text;
          if (text.startsWith('"') || text.startsWith("'")) text = text.slice(1, -1);
          if (text) names.push(text);
        }
      }
      return names.length > 0 ? names : undefined;
    }
  }
  return undefined;
}

// ─── __init__.py re-exports ──────────────────────────────────

/** Detect re-export edges in __init__.py files. */
export function extractReexportEdges(root: TSNode, filePath: string): RawEdge[] {
  if (!filePath.endsWith('__init__.py')) return [];

  const edges: RawEdge[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'import_from_statement') continue;

    // Only relative imports are re-exports: `from .foo import Bar`
    let isRelative = false;
    let moduleName = '';
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === 'relative_import') {
        isRelative = true;
        for (const rc of child.namedChildren) {
          if (rc.type === 'dotted_name') moduleName = rc.text;
        }
        break;
      }
    }
    if (!isRelative) continue;

    // Collect specifiers
    const specifiers: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'dotted_name') {
        specifiers.push(child.text);
      } else if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name') ?? child.namedChildren[0];
        if (nameNode) specifiers.push(nameNode.text);
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === 'wildcard_import') specifiers.push('*');
    }

    if (specifiers.length > 0) {
      edges.push({
        edgeType: 'py_reexports',
        metadata: { from: moduleName || '.', specifiers },
      });
    }
  }
  return edges;
}

// ─── Type annotation edges ───────────────────────────────────

/** Extract parameter type and return type edges from a function node. */
export function extractTypeAnnotationEdges(funcNode: TSNode, symbolId: string): RawEdge[] {
  const edges: RawEdge[] = [];

  // Parameter types
  const params = funcNode.childForFieldName('parameters');
  if (params) {
    for (const param of params.namedChildren) {
      // typed_parameter, typed_default_parameter
      const typeNode = param.childForFieldName('type');
      if (typeNode) {
        const typeName = typeNode.text.replace(/\s+/g, '');
        edges.push({
          sourceSymbolId: symbolId,
          edgeType: 'py_param_type',
          metadata: {
            param: param.childForFieldName('name')?.text ?? param.namedChildren[0]?.text,
            type: typeName,
          },
        });
      }
    }
  }

  // Return type
  const returnType = funcNode.childForFieldName('return_type');
  if (returnType) {
    edges.push({
      sourceSymbolId: symbolId,
      edgeType: 'py_return_type',
      metadata: { type: returnType.text.replace(/\s+/g, '') },
    });
  }

  return edges;
}

// ─── Decorator edges ─────────────────────────────────────────

/** Emit py_uses_decorator edges for a symbol with decorators. */
export function extractDecoratorEdges(decorators: string[], symbolId: string): RawEdge[] {
  return decorators.map((d) => ({
    sourceSymbolId: symbolId,
    edgeType: 'py_uses_decorator',
    metadata: { decorator: d },
  }));
}

// ─── Inheritance edges ───���───────────────────────────────────

/** Emit py_inherits edges from class bases. */
export function extractInheritanceEdges(bases: string[], classSymbolId: string): RawEdge[] {
  return bases.map((base) => ({
    sourceSymbolId: classSymbolId,
    edgeType: 'py_inherits',
    metadata: { base },
  }));
}

// ─── if __name__ == "__main__" detection ─────────────────────

/**
 * Detect `if __name__ == "__main__":` guards at module top level and return
 * the names of functions called directly inside that block.
 *
 * Common patterns:
 *   if __name__ == "__main__": main()
 *   if __name__ == "__main__":\n    main()
 *   if __name__ == "__main__":\n    sys.exit(main())
 */
export function extractNameMainCallees(root: TSNode): string[] {
  const callees: string[] = [];

  for (const node of root.namedChildren) {
    if (node.type !== 'if_statement') continue;

    const condition = node.childForFieldName('condition');
    if (!condition) continue;

    // Match:  __name__ == "__main__"  or  "__main__" == __name__
    if (!isNameMainCondition(condition)) continue;

    // Walk the consequence block to find direct call expressions
    const body = node.childForFieldName('consequence');
    if (!body) continue;

    collectCalleeNames(body, callees);
  }

  return callees;
}

/** Check if a condition node represents `__name__ == "__main__"`. */
function isNameMainCondition(node: TSNode): boolean {
  if (node.type !== 'comparison_operator') return false;

  const text = node.text;
  // Covers both  __name__ == "__main__"  and  "__main__" == __name__
  // Also handles single-quoted variants
  return text.includes('__name__') && (text.includes('"__main__"') || text.includes("'__main__'"));
}

/** Recursively collect callee names from a block (handles sys.exit(main()) etc.) */
function collectCalleeNames(node: TSNode, out: string[]): void {
  for (const child of node.namedChildren) {
    if (child.type === 'expression_statement') {
      // e.g. `main()` as a statement
      collectCalleeNames(child, out);
    } else if (child.type === 'call') {
      const fn = child.childForFieldName('function');
      if (fn) {
        if (fn.type === 'identifier') {
          out.push(fn.text);
        }
        // Also recurse into arguments: sys.exit(main())
        const args = child.childForFieldName('arguments');
        if (args) collectCalleeNames(args, out);
      }
    } else if (child.type === 'function_definition' || child.type === 'class_definition') {
      // Don't descend into nested definitions
      continue;
    } else {
      collectCalleeNames(child, out);
    }
  }
}

// ─── TYPE_CHECKING detection ─────────────────────────────────

/** Extract imports inside `if TYPE_CHECKING:` blocks, marked as type-only. */
export function extractTypeCheckingImports(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const node of root.namedChildren) {
    if (node.type !== 'if_statement') continue;

    // Check condition is TYPE_CHECKING
    const condition = node.childForFieldName('condition');
    if (!condition) continue;
    if (condition.text !== 'TYPE_CHECKING' && !condition.text.endsWith('.TYPE_CHECKING')) continue;

    // Walk the body for imports
    const body = node.childForFieldName('consequence');
    if (!body) continue;

    for (const child of body.namedChildren) {
      if (child.type === 'import_from_statement' || child.type === 'import_statement') {
        const importEdges = extractImportEdgesFromNode(child);
        for (const edge of importEdges) {
          if (edge.metadata) edge.metadata.typeOnly = true;
          edges.push(edge);
        }
      }
    }
  }

  return edges;
}

/** Extract import edge from a single import statement node (not the root walk). */
function extractImportEdgesFromNode(node: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];

  if (node.type === 'import_statement') {
    for (const child of node.namedChildren) {
      if (child.type === 'dotted_name') {
        edges.push({
          edgeType: 'py_imports',
          metadata: { from: child.text, specifiers: [child.text.split('.')[0]] },
        });
      } else if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name') ?? child.namedChildren[0];
        if (nameNode) {
          edges.push({
            edgeType: 'py_imports',
            metadata: { from: nameNode.text, specifiers: [nameNode.text.split('.')[0]] },
          });
        }
      }
    }
  } else if (node.type === 'import_from_statement') {
    let moduleName = '';
    let dots = '';

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === 'relative_import') {
        for (const rc of child.namedChildren) {
          if (rc.type === 'dotted_name') moduleName = rc.text;
          else if (rc.type === 'import_prefix') dots = rc.text;
        }
        if (!dots) {
          const dm = child.text.match(/^(\.+)/);
          if (dm) dots = dm[1];
          const afterDots = child.text.slice(dots.length).trim();
          if (afterDots && !moduleName) moduleName = afterDots;
        }
        break;
      }
    }

    if (!dots && !moduleName) {
      const moduleNode = node.childForFieldName('module_name');
      if (moduleNode) moduleName = moduleNode.text;
      else {
        for (const child of node.namedChildren) {
          if (child.type === 'dotted_name') {
            moduleName = child.text;
            break;
          }
        }
      }
    }

    const fromPath = dots ? `${dots}${moduleName}` : moduleName;
    const isRelative = dots.length > 0;
    const specifiers: string[] = [];
    const moduleNode = node.childForFieldName('module_name');

    for (const child of node.namedChildren) {
      if (child.type === 'dotted_name' && child !== moduleNode) {
        specifiers.push(child.text);
      } else if (child.type === 'aliased_import') {
        const nameNode = child.childForFieldName('name') ?? child.namedChildren[0];
        if (nameNode) specifiers.push(nameNode.text);
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

  return edges;
}

// ─── Typing patterns ─────────────────────────────────────────

/** Detect special typing module patterns on class bases. */
export function detectTypingPatterns(bases: string[], meta: Record<string, unknown>): void {
  if (bases.some((b) => b === 'NamedTuple' || b === 'typing.NamedTuple')) meta.namedTuple = true;
  if (
    bases.some(
      (b) => b === 'TypedDict' || b === 'typing.TypedDict' || b === 'typing_extensions.TypedDict',
    )
  )
    meta.typedDict = true;
  if (bases.some((b) => /^Generic(\[.+\])?$/.test(b) || /^typing\.Generic(\[.+\])?$/.test(b)))
    meta.generic = true;
}

// ─── __slots__ / metaclass detection ─────────────────────────

/** Detect __slots__ in a class body. Returns slot names or undefined. */
export function extractSlots(body: TSNode): string[] | undefined {
  for (const child of body.namedChildren) {
    if (child.type !== 'expression_statement') continue;
    const expr = child.namedChildren[0];
    if (!expr || expr.type !== 'assignment') continue;
    const left = expr.childForFieldName('left');
    if (!left || left.text !== '__slots__') continue;
    const right = expr.childForFieldName('right');
    if (!right) continue;

    if (right.type === 'tuple' || right.type === 'list' || right.type === 'set') {
      const names: string[] = [];
      for (const item of right.namedChildren) {
        if (item.type === 'string') {
          let t = item.text;
          if (t.startsWith('"') || t.startsWith("'")) t = t.slice(1, -1);
          if (t) names.push(t);
        }
      }
      return names.length > 0 ? names : undefined;
    }
  }
  return undefined;
}

/** Extract metaclass from class superclasses (keyword_argument: metaclass=...). */
export function extractMetaclass(node: TSNode): string | undefined {
  const superclasses = node.childForFieldName('superclasses');
  if (!superclasses) return undefined;

  for (const child of superclasses.namedChildren) {
    if (child.type === 'keyword_argument') {
      const keyNode = child.childForFieldName('name');
      const valNode = child.childForFieldName('value');
      if (keyNode?.text === 'metaclass' && valNode) return valNode.text;
    }
  }
  return undefined;
}

// ─── Nested classes/functions ────────────────────────────────

/** Extract nested classes and functions from a function body. */
export function extractNestedDefinitions(
  body: TSNode,
  filePath: string,
  parentName: string,
  parentSymbolId: string,
  modulePath: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const child of body.namedChildren) {
    let defNode = child;
    let decorators: string[] = [];

    if (child.type === 'decorated_definition') {
      decorators = extractDecorators(child);
      defNode =
        child.namedChildren.find(
          (c) => c.type === 'function_definition' || c.type === 'class_definition',
        ) ?? child;
    }

    if (defNode.type === 'function_definition') {
      const name = getNodeName(defNode);
      if (!name) continue;
      const rangeNode = child.type === 'decorated_definition' ? child : defNode;
      const meta: Record<string, unknown> = {};
      if (decorators.length > 0) meta.decorators = decorators;
      if (defNode.text.trimStart().startsWith('async')) meta.async = true;
      meta.nested = true;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'function', parentName),
        name,
        kind: 'function',
        fqn: makeFqn([modulePath, parentName, name]),
        parentSymbolId,
        byteStart: rangeNode.startIndex,
        byteEnd: rangeNode.endIndex,
        lineStart: rangeNode.startPosition.row + 1,
        lineEnd: rangeNode.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    } else if (defNode.type === 'class_definition') {
      const name = getNodeName(defNode);
      if (!name) continue;
      const rangeNode = child.type === 'decorated_definition' ? child : defNode;
      const meta: Record<string, unknown> = {};
      if (decorators.length > 0) meta.decorators = decorators;
      const bases = extractClassBases(defNode);
      if (bases.length > 0) meta.bases = bases;
      meta.nested = true;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'class', parentName),
        name,
        kind: 'class',
        fqn: makeFqn([modulePath, parentName, name]),
        parentSymbolId,
        byteStart: rangeNode.startIndex,
        byteEnd: rangeNode.endIndex,
        lineStart: rangeNode.startPosition.row + 1,
        lineEnd: rangeNode.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    }
  }

  return symbols;
}

// ─── Conditional imports ─────────────────────────────────────

/** Detect try/except ImportError conditional imports. */
export function extractConditionalImports(root: TSNode): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const node of root.namedChildren) {
    if (node.type !== 'try_statement') continue;

    // Check that except clause catches ImportError or ModuleNotFoundError
    let isImportGuard = false;
    for (const child of node.namedChildren) {
      if (child.type === 'except_clause') {
        const text = child.text;
        if (text.includes('ImportError') || text.includes('ModuleNotFoundError')) {
          isImportGuard = true;
          break;
        }
      }
    }
    if (!isImportGuard) continue;

    // Extract imports from try body
    const body = node.namedChildren[0];
    if (!body || body.type !== 'block') continue;

    for (const stmt of body.namedChildren) {
      if (stmt.type === 'import_from_statement' || stmt.type === 'import_statement') {
        const importEdges = extractImportEdgesFromNode(stmt);
        for (const edge of importEdges) {
          if (edge.metadata) edge.metadata.conditional = true;
          edges.push(edge);
        }
      }
    }
  }

  return edges;
}

// ─── Property grouping ──────────────────────────────────────

/** Detect @property setter/deleter grouping and mark method metadata accordingly. */
export function detectPropertyGrouping(
  decorators: string[],
  name: string,
  meta: Record<string, unknown>,
): void {
  for (const d of decorators) {
    // @foo.setter or @foo.deleter
    const match = d.match(/^(.+)\.(setter|deleter)$/);
    if (match) {
      meta.propertyAccessor = match[2];
      meta.propertyName = match[1];
      return;
    }
  }
}

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
  let module = filePath.replace(/\\/g, '/').replace(/\.pyi?$/, '');
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
          if (nameNode) {
            const moduleName = nameNode.text;
            // Always store the original module top-level name, not the alias.
            // `import os.path as osp` → specifier = "os" (matches the export).
            edges.push({
              edgeType: 'py_imports',
              metadata: { from: moduleName, specifiers: [moduleName.split('.')[0]] },
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
          if (nameNode) {
            // Always store the original name, not the alias.
            // `from foo import Bar as Baz` → specifier = "Bar" (matches the export).
            specifiers.push(nameNode.text);
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
  node: TSNode,
  filePath: string,
  modulePath: string,
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
      funcNode = child.namedChildren.find((c) => c.type === 'function_definition') ?? null;
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

// ─── Call Site Extraction ─────────────────────────────────────

export interface PythonCallSite {
  /** The bare name being called (e.g. "foo", "method") */
  calleeName: string;
  /** Line number of the call */
  line: number;
  /** Receiver object for attribute calls (e.g. "self", "cls", "module") */
  receiver?: string;
  /** True when receiver is "self" or "cls" — resolve within same class */
  isSelfCall?: boolean;
  /** Inferred type of receiver from `var = ClassName(...)` or `var: ClassName` */
  receiverType?: string;
  /** Function name that was called to assign the receiver: `var = get_user(...)` → "get_user" */
  receiverAssignedFrom?: string;
  /** Extra metadata for special resolution (e.g. pattern-based prefix matching) */
  metadata?: { pattern?: boolean; prefix?: string };
}

/**
 * Walk a function/method body and extract call sites.
 * Returns an array of PythonCallSite describing each call expression found.
 *
 * Handles:
 * - Bare name calls: `foo()` → calleeName: "foo"
 * - Attribute calls: `obj.method()` → calleeName: "method", receiver: "obj"
 * - Self/cls calls: `self.method()` → calleeName: "method", receiver: "self", isSelfCall: true
 * - Chained attribute: `a.b.c()` → calleeName: "c", receiver: "a.b"
 * - Type-inferred calls: `user = User(...)` then `user.save()` → receiverType: "User"
 */
export function extractCallSites(body: TSNode): PythonCallSite[] {
  // Pass 1: collect local variable type hints AND string literal assignments
  const localTypes = inferLocalTypes(body);
  const localStrings = inferLocalStrings(body);

  // Pass 2: extract call sites
  const sites: PythonCallSite[] = [];
  const seen = new Set<string>();

  function addSite(site: PythonCallSite): void {
    const key = `${site.receiver ?? ''}:${site.calleeName}:${site.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      sites.push(site);
    }
  }

  function walk(node: TSNode): void {
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      const args = node.childForFieldName('arguments');
      const line = node.startPosition.row + 1;

      if (fn) {
        // ── getattr(obj, "method") / getattr(obj, name) ──
        if (fn.type === 'identifier' && fn.text === 'getattr' && args) {
          const getattrSites = parseGetattrCall(args, line, localStrings);
          for (const s of getattrSites) addSite(s);
        }
        // ── Dict dispatch: handlers[key]() where handlers = {"k": func, ...} ──
        else if (fn.type === 'subscript') {
          const dictSites = parseDictDispatch(fn, line, localStrings, body);

          for (const s of dictSites) addSite(s);
        }
        // ── Regular call ──
        else {
          const site = parseCallTarget(fn, line, localTypes);
          if (site) addSite(site);
        }
      }
    }

    for (const child of node.namedChildren) {
      if (
        child.type === 'function_definition' ||
        child.type === 'class_definition' ||
        child.type === 'decorated_definition'
      ) {
        continue;
      }
      walk(child);
    }
  }

  walk(body);
  return sites;
}

// ─── getattr resolution ──────────────────────────────────────

/**
 * Parse `getattr(obj, ...)` calls.
 *
 * Handles:
 * - getattr(obj, "literal")     → obj.literal
 * - getattr(obj, f"prefix_{x}") → all obj.prefix_* (via pattern)
 * - getattr(obj, name) where name = "literal" → obj.literal
 * - getattr(obj, name) where name iterates ["a","b"] → obj.a, obj.b
 */
function parseGetattrCall(
  args: TSNode,
  line: number,
  localStrings: Map<string, string[]>,
): PythonCallSite[] {
  const argNodes = args.namedChildren;
  if (argNodes.length < 2) return [];

  const objNode = argNodes[0];
  const nameNode = argNodes[1];
  const receiver = objNode.text;
  const isSelfCall = receiver === 'self' || receiver === 'cls';

  // getattr(obj, f"prefix_{var}") — check f-string BEFORE plain string
  if (
    nameNode.type === 'string' &&
    (nameNode.text.startsWith('f"') || nameNode.text.startsWith("f'"))
  ) {
    const prefix = extractFStringPrefix(nameNode);
    if (prefix) {
      return [
        {
          calleeName: `${prefix}*`,
          line,
          receiver,
          isSelfCall: isSelfCall || undefined,
          metadata: { pattern: true, prefix },
        },
      ];
    }
  }

  // getattr(obj, "literal_string") — plain string literal
  if (nameNode.type === 'string') {
    const literal = extractStringLiteral(nameNode);
    if (literal) {
      return [{ calleeName: literal, line, receiver, isSelfCall: isSelfCall || undefined }];
    }
  }

  // getattr(obj, variable) where variable is a known string
  if (nameNode.type === 'identifier') {
    const strings = localStrings.get(nameNode.text);
    if (strings) {
      return strings.map((s) => ({
        calleeName: s,
        line,
        receiver,
        isSelfCall: isSelfCall || undefined,
      }));
    }
  }

  return [];
}

/** Extract a plain string value from a tree-sitter string node. */
function extractStringLiteral(node: TSNode): string | null {
  // string node contains quote characters: "foo" or 'foo'
  const content = node.namedChildren.find((c) => c.type === 'string_content');
  if (content) return content.text;
  // Fallback: strip quotes
  const text = node.text;
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return null;
}

/** Extract the literal prefix from an f-string like f"handle_{event}" → "handle_" */
function extractFStringPrefix(node: TSNode): string | null {
  const text = node.text;
  // Match f"prefix{..." or f'prefix{...'
  const match = text.match(/^f["']([A-Za-z_][A-Za-z0-9_]*)\{/);
  if (match) return match[1];
  return null;
}

// ─── Dict dispatch resolution ─────────────────────────────────

/**
 * Parse dict dispatch: `handlers[key]()` where handlers is a dict literal.
 *
 * Handles:
 * - Direct: `{"create": create_user, "delete": delete_user}[action]()`
 * - Via variable: `handlers = {"create": create_user, ...}; handlers[action]()`
 */
function parseDictDispatch(
  subscriptNode: TSNode,
  line: number,
  localStrings: Map<string, string[]>,
  body: TSNode,
): PythonCallSite[] {
  // tree-sitter-python uses 'value' for the object in subscript: x[y] → value=x, subscript=y
  const obj =
    subscriptNode.childForFieldName('value') ??
    subscriptNode.childForFieldName('object') ??
    subscriptNode.namedChildren[0];
  if (!obj) return [];

  let dictNode: TSNode | null = null;

  // Direct dict literal: `{"a": func_a}[key]()`
  if (obj.type === 'dictionary') {
    dictNode = obj;
  }
  // Variable reference: `handlers[key]()` — find `handlers = {...}` in body
  else if (obj.type === 'identifier') {
    dictNode = findDictAssignment(obj.text, body);
  }

  if (!dictNode) return [];

  // Extract all function-reference values from the dict
  const sites: PythonCallSite[] = [];

  for (const pair of dictNode.namedChildren) {
    if (pair.type === 'pair') {
      const value = pair.childForFieldName('value');

      if (value?.type === 'identifier' && !PYTHON_BUILTINS.has(value.text)) {
        sites.push({ calleeName: value.text, line });
      }
    }
  }

  return sites;
}

/** Find `varName = {...}` in a function body, return the dict node. */
function findDictAssignment(varName: string, body: TSNode): TSNode | null {
  for (const child of body.namedChildren) {
    if (child.type === 'expression_statement') {
      const expr = child.namedChildren[0];
      if (expr?.type === 'assignment') {
        const left = expr.childForFieldName('left');
        const right = expr.childForFieldName('right');
        if (left?.type === 'identifier' && left.text === varName && right?.type === 'dictionary') {
          return right;
        }
      }
    }
  }
  return null;
}

// ─── Local string inference ───────────────────────────────────

/**
 * Track local variables assigned string literal values.
 *
 * Handles:
 * - `name = "save"` → name → ["save"]
 * - `name = "save" if cond else "update"` → name → ["save", "update"]
 * - `for name in ["save", "delete"]: ...` → name → ["save", "delete"]
 */
function inferLocalStrings(body: TSNode): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const child of body.namedChildren) {
    if (child.type === 'expression_statement') {
      const expr = child.namedChildren[0];
      if (expr?.type === 'assignment') {
        const left = expr.childForFieldName('left');
        const right = expr.childForFieldName('right');
        if (left?.type === 'identifier' && right) {
          const strings = extractStringValues(right);
          if (strings.length > 0) result.set(left.text, strings);
        }
      }
    }
    // `for name in ["save", "delete", "update"]:`
    if (child.type === 'for_statement') {
      const left = child.childForFieldName('left');
      const right = child.childForFieldName('right');
      if (left?.type === 'identifier' && right) {
        const strings = extractIterableStrings(right);
        if (strings.length > 0) result.set(left.text, strings);
      }
    }
  }

  return result;
}

/** Extract string literal values from an expression node. */
function extractStringValues(node: TSNode): string[] {
  // Direct string: `"save"`
  if (node.type === 'string') {
    const lit = extractStringLiteral(node);
    return lit ? [lit] : [];
  }
  // Conditional: `"save" if cond else "update"`
  if (node.type === 'conditional_expression') {
    const results: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'string') {
        const lit = extractStringLiteral(child);
        if (lit) results.push(lit);
      }
    }
    return results;
  }
  return [];
}

/** Extract strings from a list/tuple literal: `["a", "b", "c"]` */
function extractIterableStrings(node: TSNode): string[] {
  if (node.type !== 'list' && node.type !== 'tuple') return [];
  const results: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'string') {
      const lit = extractStringLiteral(child);
      if (lit) results.push(lit);
    }
  }
  return results;
}

interface LocalVarInfo {
  /** Inferred class type (from constructor or annotation) */
  type?: string;
  /** Function name that was called to create this var: `var = func(...)` */
  assignedFrom?: string;
}

/**
 * Infer types of local variables from assignments and annotations.
 *
 * Patterns detected:
 * - `var = ClassName(...)` → var.type = "ClassName"
 * - `var: ClassName = ...` → var.type = "ClassName"
 * - `var: ClassName` → var.type = "ClassName"
 * - `var = module.ClassName(...)` → var.type = "ClassName"
 * - `var = func_name(...)` → var.assignedFrom = "func_name" (for return type inference)
 * - `def func(param: ClassName)` → param.type = "ClassName" (parameter annotation)
 */
function inferLocalTypes(body: TSNode): Map<string, LocalVarInfo> {
  const types = new Map<string, LocalVarInfo>();

  // Extract parameter type annotations from the enclosing function/method definition.
  // `body` is the function's body block; its parent is the function_definition node.
  const funcDef = body.parent;
  if (
    funcDef &&
    (funcDef.type === 'function_definition' || funcDef.type === 'decorated_definition')
  ) {
    const defNode =
      funcDef.type === 'decorated_definition'
        ? funcDef.namedChildren.find((c) => c.type === 'function_definition')
        : funcDef;
    if (defNode) {
      const params = defNode.childForFieldName('parameters');
      if (params) {
        for (const param of params.namedChildren) {
          if (param.type === 'typed_parameter' || param.type === 'typed_default_parameter') {
            const nameNode =
              param.childForFieldName('name') ??
              param.namedChildren.find((c) => c.type === 'identifier');
            const typeNode = param.childForFieldName('type');
            if (nameNode && typeNode) {
              const paramName = nameNode.text;
              // Skip 'self' and 'cls' — they're handled by isSelfCall logic
              if (paramName === 'self' || paramName === 'cls') continue;
              const typeName = extractParamAnnotationType(typeNode);
              if (typeName) {
                types.set(paramName, { type: typeName });
              }
            }
          }
        }
      }
    }
  }

  for (const child of body.namedChildren) {
    if (child.type === 'expression_statement') {
      const expr = child.namedChildren[0];
      if (expr?.type === 'assignment') {
        const left = expr.childForFieldName('left');
        const right = expr.childForFieldName('right');
        if (left?.type === 'identifier' && right?.type === 'call') {
          const callFn = right.childForFieldName('function');
          if (callFn) {
            const typeName = extractConstructorName(callFn);
            if (typeName) {
              types.set(left.text, { type: typeName });
            } else if (callFn.type === 'identifier') {
              // `var = some_function(...)` — record the function name for return type inference
              types.set(left.text, { assignedFrom: callFn.text });
            } else if (callFn.type === 'attribute') {
              // `var = module.func(...)` — record the attribute name
              const attr = callFn.childForFieldName('attribute');
              if (attr) types.set(left.text, { assignedFrom: attr.text });
            }
          }
        }
      } else if (expr?.type === 'type') {
        const inner = expr.namedChildren[0];
        if (inner?.type === 'assignment') {
          const left = inner.childForFieldName('left');
          if (left?.type === 'identifier') {
            const annotation = extractAnnotationType(expr);
            if (annotation) types.set(left.text, { type: annotation });
          }
        } else if (inner?.type === 'identifier') {
          const annotation = extractAnnotationType(expr);
          if (annotation && inner) types.set(inner.text, { type: annotation });
        }
      }
    }
  }

  return types;
}

/** Extract class name from a constructor call: `ClassName(...)` or `module.ClassName(...)` */
function extractConstructorName(callFn: TSNode): string | null {
  if (callFn.type === 'identifier') {
    const name = callFn.text;
    // Constructor calls typically start with uppercase
    if (name[0] >= 'A' && name[0] <= 'Z') return name;
    return null;
  }
  if (callFn.type === 'attribute') {
    const attr = callFn.childForFieldName('attribute');
    if (attr && attr.text[0] >= 'A' && attr.text[0] <= 'Z') return attr.text;
  }
  return null;
}

/** Extract type name from a type annotation node. */
function extractAnnotationType(typeNode: TSNode): string | null {
  // Look for the type identifier in the annotation
  for (const child of typeNode.namedChildren) {
    if (child.type === 'identifier' && child.text[0] >= 'A' && child.text[0] <= 'Z') {
      return child.text;
    }
    if (child.type === 'attribute') {
      const attr = child.childForFieldName('attribute');
      if (attr && attr.text[0] >= 'A' && attr.text[0] <= 'Z') return attr.text;
    }
  }
  return null;
}

/**
 * Extract type name from a function parameter's type annotation.
 * Handles: `param: ClassName`, `param: module.ClassName`, `param: Optional[ClassName]`
 */
function extractParamAnnotationType(typeNode: TSNode): string | null {
  // Direct type: `param: User` → type node is (type (identifier "User"))
  // The type node from childForFieldName('type') may be the `type` wrapper or the identifier itself
  if (typeNode.type === 'type') {
    return extractAnnotationType(typeNode);
  }
  // Sometimes tree-sitter gives us the identifier directly
  if (typeNode.type === 'identifier') {
    const name = typeNode.text;
    if (name[0] >= 'A' && name[0] <= 'Z') return name;
    return null;
  }
  if (typeNode.type === 'attribute') {
    const attr = typeNode.childForFieldName('attribute');
    if (attr && attr.text[0] >= 'A' && attr.text[0] <= 'Z') return attr.text;
    return null;
  }
  // Subscript: `Optional[User]`, `List[User]` → extract the inner type
  if (typeNode.type === 'subscript' || typeNode.type === 'generic_type') {
    for (const child of typeNode.namedChildren) {
      if (child.type === 'identifier' && child.text[0] >= 'A' && child.text[0] <= 'Z') {
        // Skip wrapper types like Optional, List, etc.
        const WRAPPER_TYPES = new Set([
          'Optional',
          'List',
          'Set',
          'Dict',
          'Tuple',
          'Type',
          'Sequence',
          'Iterable',
        ]);
        if (!WRAPPER_TYPES.has(child.text)) return child.text;
      }
    }
    // If we only found wrapper types, look deeper for the inner type argument
    for (const child of typeNode.namedChildren) {
      const inner = extractParamAnnotationType(child);
      if (inner) return inner;
    }
  }
  // Fallback: try extractAnnotationType
  return extractAnnotationType(typeNode);
}

/** Parse a call's `function` field into a PythonCallSite. */
function parseCallTarget(
  fn: TSNode,
  line: number,
  localTypes: Map<string, LocalVarInfo>,
): PythonCallSite | null {
  if (fn.type === 'identifier') {
    const name = fn.text;
    if (PYTHON_BUILTINS.has(name)) return null;
    return { calleeName: name, line };
  }

  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    const obj = fn.childForFieldName('object');
    if (!attr || !obj) return null;

    const calleeName = attr.text;
    const receiver = obj.text;

    // self.method() or cls.method()
    if (receiver === 'self' || receiver === 'cls') {
      return { calleeName, line, receiver, isSelfCall: true };
    }

    // super().method()
    if (obj.type === 'call') {
      const superFn = obj.childForFieldName('function');
      if (superFn?.text === 'super') {
        return { calleeName, line, receiver: 'super', isSelfCall: true };
      }
    }

    // Check if receiver has an inferred type or assigned-from function
    const varInfo = localTypes.get(receiver);
    if (varInfo) {
      if (varInfo.type) {
        return { calleeName, line, receiver, receiverType: varInfo.type };
      }
      if (varInfo.assignedFrom) {
        return { calleeName, line, receiver, receiverAssignedFrom: varInfo.assignedFrom };
      }
    }

    return { calleeName, line, receiver };
  }

  return null;
}

/** Python builtins that should not create call edges (they're never in user code). */
const PYTHON_BUILTINS = new Set([
  'print',
  'len',
  'range',
  'int',
  'str',
  'float',
  'bool',
  'list',
  'dict',
  'set',
  'tuple',
  'type',
  'isinstance',
  'issubclass',
  'hasattr',
  'getattr',
  'setattr',
  'delattr',
  'callable',
  'super',
  'property',
  'staticmethod',
  'classmethod',
  'abs',
  'all',
  'any',
  'bin',
  'chr',
  'ord',
  'hex',
  'oct',
  'id',
  'hash',
  'iter',
  'next',
  'reversed',
  'sorted',
  'enumerate',
  'zip',
  'map',
  'filter',
  'min',
  'max',
  'sum',
  'round',
  'pow',
  'divmod',
  'input',
  'open',
  'repr',
  'vars',
  'dir',
  'globals',
  'locals',
  'exec',
  'eval',
  'compile',
  'format',
  'ascii',
  'bytes',
  'bytearray',
  'memoryview',
  'frozenset',
  'object',
  'slice',
  'complex',
  'breakpoint',
  'exit',
  'quit',
  'Exception',
  'ValueError',
  'TypeError',
  'KeyError',
  'IndexError',
  'AttributeError',
  'ImportError',
  'RuntimeError',
  'StopIteration',
  'NotImplementedError',
  'OSError',
  'IOError',
  'FileNotFoundError',
  'PermissionError',
  'AssertionError',
  'ZeroDivisionError',
  'OverflowError',
  'NameError',
  'SyntaxError',
  'UnicodeError',
  'UnicodeDecodeError',
  'UnicodeEncodeError',
  'SystemExit',
  'KeyboardInterrupt',
  'GeneratorExit',
  'Warning',
  'DeprecationWarning',
  'FutureWarning',
  'UserWarning',
]);
