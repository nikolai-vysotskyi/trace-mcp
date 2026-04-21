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

  // Pass 1: top-level ES import statements + re-exports (`export … from '…'`).
  // Barrel files (static/svg/furniture/index.js, design-system index.ts, etc.)
  // often consist entirely of `export { X } from '…'` — without handling those
  // here, the barrel looks like a leaf node and the re-exported modules appear
  // isolated in the graph.
  for (const node of root.namedChildren) {
    const isImport = node.type === 'import_statement';
    const isReExport = node.type === 'export_statement'
      && !!node.childForFieldName('source');
    if (!isImport && !isReExport) continue;
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
      } else if (isReExport) {
        // `export { Foo } from '…'` → export_specifier children inside an
        // export_clause. `export * from '…'` → has no specifiers (leave empty).
        // `export { Foo as Bar } from '…'` → track the original exported name.
        if (child.type === 'export_clause') {
          for (const spec of child.namedChildren) {
            if (spec.type === 'export_specifier') {
              const name = spec.childForFieldName('name');
              specifiers.push(name?.text ?? spec.text);
            }
          }
        }
      }
    }

    edges.push({
      edgeType: 'imports',
      metadata: { from, specifiers },
    });
  }

  // Pass 2: walk the tree for dynamic imports and CommonJS requires.
  //
  // These forms appear deep inside the AST (callbacks, conditional logic,
  // Nova tool/card bootstraps like `Nova.booting((app) => { require('./x') })`),
  // not as top-level statements. Without catching them, entire ecosystems —
  // Laravel Nova custom tools/cards, older Webpack-era bundles, lazy-loaded
  // React.lazy / Vue defineAsyncComponent chunks — stay disconnected.
  //
  // Captured:
  //   require('./foo')                 — CommonJS
  //   require('./foo').default         — CommonJS with .default
  //   import('./foo')                  — dynamic import
  //   import('./foo').then(...)        — dynamic import chain
  const seen = new Set<string>();
  const visit = (n: TSNode): void => {
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      const argsNode = n.childForFieldName('arguments');
      if (fn && argsNode) {
        // Detect CommonJS require or dynamic import()
        const isRequire = fn.type === 'identifier' && fn.text === 'require';
        const isDynamicImport = fn.type === 'import';
        if (isRequire || isDynamicImport) {
          const firstArg = argsNode.namedChildren[0];
          if (firstArg && (firstArg.type === 'string' || firstArg.type === 'template_string')) {
            const raw = firstArg.text.replace(/^['"`]|['"`]$/g, '');
            if (raw && !seen.has(raw)) {
              seen.add(raw);
              edges.push({
                edgeType: 'imports',
                metadata: {
                  from: raw,
                  specifiers: [] as string[],
                  importStyle: isRequire ? 'cjs_require' : 'dynamic_import',
                },
              });
            }
          }
        }
      }
    }
    for (const child of n.namedChildren) visit(child);
  };
  visit(root);

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

    // Extract call sites inside the method body
    const callSites = extractCallSites(child);
    if (callSites.length > 0) metadata.callSites = callSites;

    // Track `this.xxx = new Foo()` field assignments and parameter types for type inference
    const localTypes = collectLocalTypes(child);
    if (Object.keys(localTypes).length > 0) metadata.localTypes = localTypes;

    // Collect type references (parameter/return types, generics)
    const typeRefs = extractTypeReferences(child);
    if (typeRefs.length > 0) metadata.typeRefs = typeRefs;

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

/** A single call site extracted from a function/method body. */
export interface TsCallSite {
  /** The callee name (function name, or method name if `receiver` is set). */
  calleeName: string;
  /** The receiver expression for `receiver.method()` calls (null for bare calls). */
  receiver?: string;
  /** 1-based line number of the call. */
  line: number;
  /** True if the call is `this.method()`. */
  isThisCall?: boolean;
  /** True if the call is `super.method()`. */
  isSuperCall?: boolean;
  /** True if this is a `new Foo()` constructor call. */
  isNew?: boolean;
  /** If receiver is `new Foo()` inline, the class name. */
  receiverType?: string;
  /** If receiver is a variable assigned from a call `const x = getFoo()`, the callee name. */
  receiverAssignedFrom?: string;
}

/**
 * Walk a function/method body extracting call expressions.
 *
 * Handles:
 *   - foo()                       — bare call
 *   - obj.method()                — member call
 *   - this.method()               — this call
 *   - super.method()              — super call
 *   - new Foo()                   — constructor call
 *   - obj.prop.method()           — chained (captures last method + receiver path)
 */
export function extractCallSites(fnNode: TSNode): TsCallSite[] {
  const sites: TsCallSite[] = [];
  const visit = (n: TSNode): void => {
    // Do not descend into nested functions / classes — they collect their own sites
    if (n !== fnNode && (
      n.type === 'function_declaration'
      || n.type === 'class_declaration'
      || n.type === 'method_definition'
      || n.type === 'arrow_function'
      || n.type === 'function_expression'
      || n.type === 'generator_function'
      || n.type === 'generator_function_declaration'
    )) {
      // But arrow/function expressions can be IIFEs — still walk their body
      // for simplicity and accuracy, walk them all (call graphs are best-effort)
      // Exception: nested named declarations — they get their own sites
      if (n.type === 'function_declaration'
        || n.type === 'method_definition'
        || n.type === 'class_declaration'
        || n.type === 'generator_function_declaration') {
        return;
      }
    }

    if (n.type === 'call_expression') {
      const site = parseCallExpression(n, false);
      if (site) sites.push(site);
    } else if (n.type === 'new_expression') {
      const site = parseCallExpression(n, true);
      if (site) sites.push(site);
    } else if (n.type === 'jsx_opening_element' || n.type === 'jsx_self_closing_element') {
      // <ComponentName /> or <ComponentName>  — React/Next.js component usage.
      // Capture as a call site so the call graph connects component → consumer.
      const site = parseJsxElement(n);
      if (site) sites.push(site);
    }

    for (const child of n.namedChildren) visit(child);
  };
  visit(fnNode);
  return sites;
}

/**
 * Extract a component-invocation "call" from a JSX opening/self-closing element.
 * Only captures custom components (starts with uppercase) or member expressions
 * like `Foo.Bar` — native HTML tags (`<div>`) are ignored.
 */
function parseJsxElement(node: TSNode): TsCallSite | null {
  const nameNode = node.childForFieldName('name') ?? node.namedChildren[0];
  if (!nameNode) return null;
  const text = nameNode.text;
  if (!text) return null;
  // Ignore native HTML/SVG tags — lowercase or hyphenated
  const first = text.charAt(0);
  if (first === first.toLowerCase()) return null;
  const line = node.startPosition.row + 1;
  // For member expressions like `Foo.Bar`, split and use last segment
  if (nameNode.type === 'jsx_namespace_name' || nameNode.type === 'member_expression') {
    // Take the rightmost identifier
    const parts = text.split(/[.:]/);
    const calleeName = parts[parts.length - 1];
    const receiver = parts.slice(0, -1).join('.');
    return { calleeName, receiver: receiver || undefined, line };
  }
  return { calleeName: text, line };
}

/** Parse a single call_expression or new_expression node into a TsCallSite. */
function parseCallExpression(node: TSNode, isNew: boolean): TsCallSite | null {
  const fn = node.childForFieldName(isNew ? 'constructor' : 'function');
  if (!fn) return null;
  const line = node.startPosition.row + 1;

  if (fn.type === 'identifier') {
    return {
      calleeName: fn.text,
      line,
      ...(isNew ? { isNew: true } : {}),
    };
  }

  if (fn.type === 'member_expression') {
    const object = fn.childForFieldName('object');
    const property = fn.childForFieldName('property');
    if (!property) return null;
    const calleeName = property.text;
    if (!object) return { calleeName, line };

    const isThisCall = object.type === 'this';
    const isSuperCall = object.type === 'super';
    const receiverText = object.text;

    // Try to classify receiver for better resolution
    let receiverType: string | undefined;
    if (object.type === 'new_expression') {
      const ctor = object.childForFieldName('constructor');
      if (ctor?.type === 'identifier') receiverType = ctor.text;
    }

    return {
      calleeName,
      receiver: receiverText,
      line,
      ...(isThisCall ? { isThisCall: true } : {}),
      ...(isSuperCall ? { isSuperCall: true } : {}),
      ...(receiverType ? { receiverType } : {}),
      ...(isNew ? { isNew: true } : {}),
    };
  }

  // Parenthesized/other — skip
  return null;
}

/**
 * Collect local variable → type bindings within a function/method body.
 * Handles:
 *   - const x = new Foo(...)          → x: 'Foo' (receiverType)
 *   - const x: Foo = ...              → x: 'Foo' (receiverType)
 *   - const x = getFoo()              → x: { assignedFrom: 'getFoo' }
 *   - this.x = new Foo()              → this.x: 'Foo'
 */
export function collectLocalTypes(fnNode: TSNode): Record<string, { type?: string; assignedFrom?: string }> {
  const out: Record<string, { type?: string; assignedFrom?: string }> = {};
  const visit = (n: TSNode): void => {
    // Don't descend into nested named declarations
    if (n !== fnNode && (
      n.type === 'function_declaration'
      || n.type === 'method_definition'
      || n.type === 'class_declaration'
    )) return;

    // Variable declarator: `const x = <init>` or `const x: Foo = <init>`
    if (n.type === 'variable_declarator') {
      const nameNode = n.childForFieldName('name');
      const typeNode = n.childForFieldName('type'); // type annotation
      const valueNode = n.childForFieldName('value');
      if (nameNode && nameNode.type === 'identifier') {
        const varName = nameNode.text;
        const binding: { type?: string; assignedFrom?: string } = {};
        // Type annotation: `: Foo` → type_annotation node wrapping a type
        if (typeNode) {
          const typeText = extractSimpleTypeName(typeNode);
          if (typeText) binding.type = typeText;
        }
        if (!binding.type && valueNode) {
          if (valueNode.type === 'new_expression') {
            const ctor = valueNode.childForFieldName('constructor');
            if (ctor?.type === 'identifier') binding.type = ctor.text;
          } else if (valueNode.type === 'await_expression') {
            const inner = valueNode.namedChildren[0];
            if (inner?.type === 'call_expression') {
              const fn = inner.childForFieldName('function');
              if (fn?.type === 'identifier') binding.assignedFrom = fn.text;
            }
          } else if (valueNode.type === 'call_expression') {
            const fn = valueNode.childForFieldName('function');
            if (fn?.type === 'identifier') binding.assignedFrom = fn.text;
          }
        }
        if (binding.type || binding.assignedFrom) {
          out[varName] = binding;
        }
      }
    }

    // `this.x = new Foo()` — assignment_expression: (member_expression this.x) = (new_expression)
    if (n.type === 'assignment_expression') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left?.type === 'member_expression' && right) {
        const obj = left.childForFieldName('object');
        const prop = left.childForFieldName('property');
        if (obj?.type === 'this' && prop?.type === 'property_identifier') {
          const key = `this.${prop.text}`;
          if (right.type === 'new_expression') {
            const ctor = right.childForFieldName('constructor');
            if (ctor?.type === 'identifier') out[key] = { type: ctor.text };
          }
        }
      }
    }

    for (const child of n.namedChildren) visit(child);
  };
  visit(fnNode);
  return out;
}

/**
 * Collect all type_identifier names referenced inside a subtree.
 *
 * Picks up type names from:
 *   - type_annotation (`: Foo`)
 *   - generic_type / type_arguments (`Array<Foo>`, `Promise<Bar>`)
 *   - extends_clause / extends_type_clause / implements_clause
 *   - type_alias_declaration bodies
 *   - nested type references
 *
 * Filters out built-ins (string/number/boolean/void/etc.) to keep resolver fast.
 */
const BUILTIN_TYPE_NAMES = new Set([
  'string', 'number', 'boolean', 'void', 'any', 'unknown', 'never', 'object',
  'symbol', 'bigint', 'null', 'undefined', 'this', 'Function', 'Object',
  'String', 'Number', 'Boolean', 'Array', 'Map', 'Set', 'Promise', 'Record',
  'Partial', 'Readonly', 'Required', 'Pick', 'Omit', 'Exclude', 'Extract',
  'ReturnType', 'Parameters', 'InstanceType', 'NonNullable', 'Awaited',
  'ReadonlyArray', 'Date', 'RegExp', 'Error', 'Buffer', 'T', 'U', 'V', 'K',
]);

export function extractTypeReferences(node: TSNode): string[] {
  const refs = new Set<string>();
  const visit = (n: TSNode): void => {
    if (n.type === 'type_identifier') {
      const name = n.text;
      if (name && !BUILTIN_TYPE_NAMES.has(name)) refs.add(name);
    }
    // predefined_type (string/number/etc.) — skip
    // Nested generic types: walk children
    for (const child of n.namedChildren) visit(child);
  };
  visit(node);
  return [...refs];
}

/**
 * Extract call sites that live at module body level (outside any named
 * function/class/method). These represent code that runs at script load time
 * — typical for Laravel-style imperative JS, Nuxt plugin bodies, and
 * Vue `<script setup>` blocks without explicit `defineComponent` wrapping.
 *
 * Only descends through block-like containers at the module root. Skips any
 * nested function/class/method bodies — those produce their own call sites.
 */
export function extractModuleCallSites(
  root: TSNode,
  opts: { skipLexicalFunctionBodies?: boolean } = { skipLexicalFunctionBodies: true },
): TsCallSite[] {
  const sites: TsCallSite[] = [];
  const NAMED_CONTAINER = new Set([
    'function_declaration',
    'class_declaration',
    'generator_function_declaration',
    // Exported/top-level named — extractFunction etc. handles them
  ]);
  const skipLex = opts.skipLexicalFunctionBodies !== false;
  const visitModule = (n: TSNode): void => {
    if (NAMED_CONTAINER.has(n.type)) return; // skip named functions/classes
    // method_definition inside a class_body IS extracted as a standalone method
    // symbol (extractClassMethods). Only skip those — methods in object literals
    // have no separate symbol, so we must descend to capture their call sites.
    if (n.type === 'method_definition' && n.parent?.type === 'class_body') return;
    // `lexical_declaration` whose value is an arrow/function expression
    // becomes a 'function' kind symbol — optionally skip its body here.
    // For pure TS/JS files extractVariable captures these separately, so skip.
    // For Vue SFCs (where scriptSetup locals aren't extracted as symbols),
    // the caller passes `skipLexicalFunctionBodies: false` to descend.
    if (skipLex && (n.type === 'lexical_declaration' || n.type === 'variable_declaration')) {
      for (const d of n.namedChildren) {
        if (d.type !== 'variable_declarator') continue;
        const v = d.childForFieldName('value');
        if (v && (v.type === 'arrow_function' || v.type === 'function_expression' || v.type === 'generator_function')) {
          // Body is captured by extractFunction/extractVariable; skip here
          return;
        }
      }
    }
    // Don't skip `export_statement` — `export default defineNuxtPlugin(() => {…})`
    // and similar bare-call default exports carry module-body calls inside their
    // callback bodies. Nested function_declaration/class_declaration are still
    // skipped above by NAMED_CONTAINER.

    if (n.type === 'call_expression' || n.type === 'new_expression') {
      const isNew = n.type === 'new_expression';
      const fn = n.childForFieldName(isNew ? 'constructor' : 'function');
      if (fn) {
        const line = n.startPosition.row + 1;
        if (fn.type === 'identifier') {
          sites.push({ calleeName: fn.text, line, ...(isNew ? { isNew: true } : {}) });
        } else if (fn.type === 'member_expression') {
          const obj = fn.childForFieldName('object');
          const prop = fn.childForFieldName('property');
          if (prop) {
            sites.push({
              calleeName: prop.text,
              receiver: obj?.text,
              line,
              ...(isNew ? { isNew: true } : {}),
            });
          }
        }
      }
    } else if (n.type === 'jsx_opening_element' || n.type === 'jsx_self_closing_element') {
      const site = parseJsxElement(n);
      if (site) sites.push(site);
    }

    for (const child of n.namedChildren) visitModule(child);
  };
  for (const child of root.namedChildren) visitModule(child);
  return sites;
}

/** Given a `type_annotation` node (colon + type), extract the primary type identifier. */
function extractSimpleTypeName(typeAnnotation: TSNode): string | null {
  // type_annotation has one child which is the actual type
  for (const child of typeAnnotation.namedChildren) {
    if (child.type === 'type_identifier' || child.type === 'identifier') return child.text;
    // generic_type: Foo<Bar> → first child is type_identifier
    if (child.type === 'generic_type') {
      const id = child.namedChildren[0];
      if (id && (id.type === 'type_identifier' || id.type === 'identifier')) return id.text;
    }
    // qualified_name: ns.Foo — take last segment
    if (child.type === 'nested_type_identifier' || child.type === 'qualified_name') {
      const last = child.namedChildren[child.namedChildCount - 1];
      if (last) return last.text;
    }
  }
  return null;
}
