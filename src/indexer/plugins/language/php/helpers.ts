/**
 * Helper utilities for the PHP language plugin.
 * Extracts AST-walking logic to keep the main plugin under 300 lines.
 */
import type { RawSymbol, SymbolKind } from '../../../../plugin-api/types.js';

export type { TSNode } from '../../../../parser/tree-sitter.js';

/** Extract the namespace string from the root program node. */
export function extractNamespace(rootNode: TSNode): string | undefined {
  for (const child of rootNode.namedChildren) {
    if (child.type === 'namespace_definition') {
      const nsName = child.namedChildren.find((c) => c.type === 'namespace_name');
      if (nsName) return nsName.text;
    }
  }
  return undefined;
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

/** Build a fully qualified name. */
export function makeFqn(
  namespace: string | undefined,
  className: string,
  memberName?: string,
): string {
  const base = namespace ? `${namespace}\\${className}` : className;
  return memberName ? `${base}::${memberName}` : base;
}

/** Extract visibility + modifiers + function/class signature from source (first line only). */
export function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  // Trim body openers: { or anything after {
  const braceIdx = firstLine.indexOf('{');
  if (braceIdx > 0) {
    return firstLine.substring(0, braceIdx).trim();
  }
  // For abstract/interface methods ending with ;
  const semiIdx = firstLine.indexOf(';');
  if (semiIdx > 0) {
    return firstLine.substring(0, semiIdx).trim();
  }
  return firstLine;
}

/** Check if a node has the readonly modifier. Works for properties, classes, and promoted params. */
export function isReadonly(node: TSNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'readonly_modifier') return true;
  }
  return false;
}

/**
 * Extract modifier keywords from a declaration node.
 * Returns flags for static, abstract, final modifiers.
 */
export function extractModifiers(node: TSNode): { static?: true; abstract?: true; final?: true } {
  const mods: { static?: true; abstract?: true; final?: true } = {};
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    switch (child.type) {
      case 'static_modifier':
        mods.static = true;
        break;
      case 'abstract_modifier':
        mods.abstract = true;
        break;
      case 'final_modifier':
        mods.final = true;
        break;
    }
  }
  return mods;
}

/** Extract property hooks (get/set) from a property_declaration node (PHP 8.4+). */
export function extractPropertyHooks(
  node: TSNode,
  filePath: string,
  className: string,
  namespace: string | undefined,
  classSymbolId: string,
  propertyName: string,
): RawSymbol[] {
  const hookList = node.namedChildren.find((c) => c.type === 'property_hook_list');
  if (!hookList) return [];

  const symbols: RawSymbol[] = [];
  for (const hook of hookList.namedChildren) {
    if (hook.type === 'property_hook') {
      const hookName = hook.childForFieldName('name')?.text;
      if (!hookName) continue;
      const fullName = `${propertyName}::${hookName}`;
      symbols.push({
        symbolId: makeSymbolId(filePath, fullName, 'method', className),
        name: fullName,
        kind: 'method',
        fqn: makeFqn(namespace, className, fullName),
        parentSymbolId: classSymbolId,
        signature: extractSignature(hook),
        byteStart: hook.startIndex,
        byteEnd: hook.endIndex,
        lineStart: hook.startPosition.row + 1,
        lineEnd: hook.endPosition.row + 1,
        metadata: { propertyHook: hookName, minPhpVersion: '8.4' },
      });
    }
  }
  return symbols;
}

/**
 * Collect all unique AST node types present within a subtree (non-recursive, children only).
 * Used for detecting version-specific features.
 */
export function collectNodeTypes(node: TSNode): string[] {
  const types = new Set<string>();
  types.add(node.type);
  for (const child of node.namedChildren) {
    types.add(child.type);
  }
  return [...types];
}

/** Extract attribute names from an attribute_list node. */
export function extractAttributes(node: TSNode): string[] {
  const attrs: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'attribute_list') {
      for (const group of child.namedChildren) {
        if (group.type === 'attribute_group') {
          for (const attr of group.namedChildren) {
            if (attr.type === 'attribute') {
              const name = attr.childForFieldName('name') ?? attr.namedChildren[0];
              if (name) attrs.push(name.text);
            }
          }
        }
      }
    }
  }
  return attrs;
}

/** Extract visibility modifier text from a node's children. */
export function getVisibility(node: TSNode): string | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'visibility_modifier') return child.text;
  }
  return undefined;
}

/** Extract constructor-promoted parameters as property symbols. */
export function extractPromotedProperties(
  methodNode: TSNode,
  relativePath: string,
  className: string,
  namespace: string | undefined,
  classSymbolId: string,
): RawSymbol[] {
  const params = methodNode.childForFieldName('parameters');
  if (!params) return [];

  const symbols: RawSymbol[] = [];
  for (const param of params.namedChildren) {
    if (param.type === 'property_promotion_parameter') {
      const varName =
        param.childForFieldName('name') ??
        param.namedChildren.find((c) => c.type === 'variable_name');
      if (!varName) continue;
      const propName = varName.text.replace(/^\$/, '');
      const readonly = isReadonly(param);
      const visibility = getVisibility(param);

      // Extract type annotation
      const typeNode = param.namedChildren.find(
        (c) =>
          c.type === 'named_type' ||
          c.type === 'optional_type' ||
          c.type === 'primitive_type' ||
          c.type === 'union_type' ||
          c.type === 'intersection_type',
      );
      const typeRef = extractTypeRef(typeNode);

      symbols.push({
        symbolId: makeSymbolId(relativePath, propName, 'property', className),
        name: propName,
        kind: 'property',
        fqn: makeFqn(namespace, className, propName),
        parentSymbolId: classSymbolId,
        signature: param.text.trim(),
        byteStart: param.startIndex,
        byteEnd: param.endIndex,
        lineStart: param.startPosition.row + 1,
        lineEnd: param.endPosition.row + 1,
        metadata: {
          ...(readonly ? { readonly: true } : {}),
          ...(visibility ? { visibility } : {}),
          ...(typeRef ? { type: typeRef } : {}),
          promoted: true,
        },
      });
    }
  }
  return symbols;
}

/** Extract a property_declaration node into a RawSymbol. */
export function extractPropertySymbol(
  node: TSNode,
  filePath: string,
  className: string,
  namespace: string | undefined,
  classSymbolId: string,
): RawSymbol | undefined {
  const propElement = node.namedChildren.find((c) => c.type === 'property_element');
  if (!propElement) return undefined;
  const varName = propElement.namedChildren.find((c) => c.type === 'variable_name');
  if (!varName) return undefined;
  const name = varName.text.replace(/^\$/, '');
  const readonly = isReadonly(node);
  const visibility = getVisibility(node);
  const mods = extractModifiers(node);

  // Extract type annotation (typed properties)
  const typeNode = node.namedChildren.find(
    (c) =>
      c.type === 'named_type' ||
      c.type === 'optional_type' ||
      c.type === 'primitive_type' ||
      c.type === 'union_type' ||
      c.type === 'intersection_type',
  );
  const typeRef = extractTypeRef(typeNode);

  const metadata: Record<string, unknown> = {};
  if (readonly) metadata.readonly = true;
  if (visibility) metadata.visibility = visibility;
  if (mods.static) metadata.static = true;
  if (typeRef) metadata.type = typeRef;

  return {
    symbolId: makeSymbolId(filePath, name, 'property', className),
    name,
    kind: 'property',
    fqn: makeFqn(namespace, className, name),
    parentSymbolId: classSymbolId,
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/** Extract const_element children from a const_declaration node. */
export function extractConstantSymbols(
  node: TSNode,
  filePath: string,
  className: string,
  namespace: string | undefined,
  classSymbolId: string,
): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const vis = getVisibility(node);
  // Typed class constants (PHP 8.3+): look for a type node before const_element
  const typeNode = node.namedChildren.find(
    (c) =>
      c.type === 'primitive_type' ||
      c.type === 'named_type' ||
      c.type === 'optional_type' ||
      c.type === 'union_type' ||
      c.type === 'intersection_type',
  );

  for (const child of node.namedChildren) {
    if (child.type === 'const_element') {
      const nameNode =
        child.childForFieldName('name') ?? child.namedChildren.find((c) => c.type === 'name');
      if (!nameNode) continue;
      const name = nameNode.text;
      const metadata: Record<string, unknown> = {};
      if (vis) metadata.visibility = vis;
      if (typeNode) {
        metadata.type = typeNode.text;
        metadata.minPhpVersion = '8.3';
      }

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'constant', className),
        name,
        kind: 'constant',
        fqn: makeFqn(namespace, className, name),
        parentSymbolId: classSymbolId,
        byteStart: child.startIndex,
        byteEnd: child.endIndex,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }
  }
  return symbols;
}

/**
 * Extract PHP `use` statements from the program root node.
 * Returns an array of FQN strings imported by the file.
 *
 * Handles:
 *  - `use App\Models\User;`
 *  - `use App\Models\User as Alias;`
 *  - `use App\Contracts\{Searchable, Filterable};`
 */
export function extractUseStatements(rootNode: TSNode): { fqn: string; alias?: string }[] {
  const results: { fqn: string; alias?: string }[] = [];

  for (const node of rootNode.namedChildren) {
    if (node.type === 'namespace_use_declaration') {
      // Check for grouped use: use Prefix\{A, B};
      const group = node.namedChildren.find((c) => c.type === 'namespace_use_group');
      if (group) {
        const prefixNode = node.namedChildren.find((c) => c.type === 'namespace_name');
        const prefix = prefixNode ? prefixNode.text : '';

        for (const clause of group.namedChildren) {
          if (clause.type === 'namespace_use_group_clause') {
            const nameNode = clause.namedChildren.find(
              (c) => c.type === 'namespace_name' || c.type === 'name',
            );
            if (nameNode) {
              const fqn = prefix ? `${prefix}\\${nameNode.text}` : nameNode.text;
              const aliasNode = clause.namedChildren.find(
                (c) => c.type === 'namespace_aliasing_clause',
              );
              const alias = aliasNode?.namedChildren.find((c) => c.type === 'name')?.text;
              results.push({ fqn, alias });
            }
          }
        }
      } else {
        // Simple use: use Foo\Bar\Baz; or use Foo\Bar\Baz as Alias;
        for (const clause of node.namedChildren) {
          if (clause.type === 'namespace_use_clause') {
            const qn = clause.namedChildren.find((c) => c.type === 'qualified_name');
            if (qn) {
              const fqn = qn.text;
              const aliasNode = clause.namedChildren.find(
                (c) => c.type === 'namespace_aliasing_clause',
              );
              const alias = aliasNode?.namedChildren.find((c) => c.type === 'name')?.text;
              results.push({ fqn, alias });
            }
          }
        }
      }
    }

    // Handle namespace body — use statements may be inside namespace {}
    if (node.type === 'namespace_definition') {
      const body = node.namedChildren.find(
        (c) => c.type === 'compound_statement' || c.type === 'declaration_list',
      );
      if (body) {
        results.push(...extractUseStatements(body));
      }
    }
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════
// CALL SITE & HERITAGE EXTRACTION
// ════════════════════════════════════════════════════════════════════════

export interface PhpCallSite {
  /** Type of reference.
   *  Calls: 'this'|'self'|'parent'|'static'|'member'|'new'|'function'|'this_member_call'|'param_call'|'local_call'.
   *  Accesses: 'this_prop'|'member_prop'|'class_const'|'relative_const'|'static_prop'|'relative_static_prop'.
   *  Class ref: 'class_ref' (for Class::class magic constant). */
  type:
    | 'this'
    | 'self'
    | 'parent'
    | 'static'
    | 'member'
    | 'new'
    | 'function'
    | 'this_member_call'
    | 'param_call'
    | 'local_call'
    | 'this_prop'
    | 'member_prop'
    | 'class_const'
    | 'relative_const'
    | 'static_prop'
    | 'relative_static_prop'
    | 'class_ref';
  /** Name of the method/property/constant being accessed */
  callee: string;
  /** For 'static'/'new'/'class_const'/'static_prop'/'class_ref': the class name reference */
  classRef?: string;
  /** For 'member'/'member_prop'/'param_call'/'local_call': the receiver variable name */
  receiver?: string;
  /** For 'this_member_call': the property chain used to reach the receiver (e.g., ['service']) */
  propChain?: string[];
  /** Line number (1-based) */
  line: number;
}

export interface PhpClassHeritage {
  /** Names from `extends X` clause */
  extends: string[];
  /** Names from `implements X, Y` clause */
  implements: string[];
  /** Names from `use TraitA, TraitB` inside the class body */
  usesTraits: string[];
}

/** Extract the `extends`, `implements`, and trait `use` references from a class declaration node. */
export function extractClassHeritage(classNode: TSNode): PhpClassHeritage {
  const result: PhpClassHeritage = { extends: [], implements: [], usesTraits: [] };

  for (const child of classNode.namedChildren) {
    if (child.type === 'base_clause') {
      for (const c of child.namedChildren) {
        if (c.type === 'name' || c.type === 'qualified_name') result.extends.push(c.text);
      }
    } else if (child.type === 'class_interface_clause') {
      for (const c of child.namedChildren) {
        if (c.type === 'name' || c.type === 'qualified_name') result.implements.push(c.text);
      }
    } else if (child.type === 'declaration_list') {
      for (const member of child.namedChildren) {
        if (member.type === 'use_declaration') {
          for (const c of member.namedChildren) {
            if (c.type === 'name' || c.type === 'qualified_name') result.usesTraits.push(c.text);
          }
        }
      }
    }
  }

  return result;
}

/**
 * Extract the canonical class name from a PHP type annotation node.
 * Returns the class name, or null for primitive/untyped/union/intersection types
 * that don't resolve to a single class.
 *
 * Handles:
 *  - `named_type` → "ClassName"
 *  - `optional_type` (wraps `?Type`) → "Type"
 *  - `primitive_type` (int, string, bool, etc.) → null (not a class)
 *  - `union_type` → null (ambiguous, no single class)
 *  - `intersection_type` → null (same)
 */
export function extractTypeRef(typeNode: TSNode | null | undefined): string | null {
  if (!typeNode) return null;
  switch (typeNode.type) {
    case 'named_type': {
      const nameNode = typeNode.namedChildren.find(
        (c) => c.type === 'name' || c.type === 'qualified_name',
      );
      return nameNode?.text ?? null;
    }
    case 'optional_type': {
      // Wraps ?Type — unwrap and extract
      const inner = typeNode.namedChildren[0];
      return inner ? extractTypeRef(inner) : null;
    }
    case 'primitive_type':
    case 'union_type':
    case 'intersection_type':
      return null;
  }
  return null;
}

/**
 * Extract parameter name → class type mapping from a method's formal_parameters node.
 * Also captures constructor-promoted properties (name → type).
 *
 * Returns a map of param name (without the `$` prefix) to class name reference.
 * Primitive-typed and untyped params are omitted.
 */
export function extractParamTypes(paramsNode: TSNode | null | undefined): {
  params: Map<string, string>;
  promoted: Map<string, string>;
} {
  const params = new Map<string, string>();
  const promoted = new Map<string, string>();
  if (!paramsNode) return { params, promoted };

  for (const param of paramsNode.namedChildren) {
    if (param.type !== 'simple_parameter' && param.type !== 'property_promotion_parameter')
      continue;

    // Find type and variable_name among children
    let typeNode: TSNode | null = null;
    let varName: string | null = null;
    for (const child of param.namedChildren) {
      if (
        child.type === 'named_type' ||
        child.type === 'optional_type' ||
        child.type === 'primitive_type' ||
        child.type === 'union_type' ||
        child.type === 'intersection_type'
      ) {
        typeNode = child;
      } else if (child.type === 'variable_name') {
        const n = child.namedChildren.find((c) => c.type === 'name');
        varName = n?.text ?? null;
      }
    }

    if (!varName) continue;
    const typeRef = extractTypeRef(typeNode);
    if (typeRef) {
      params.set(varName, typeRef);
      if (param.type === 'property_promotion_parameter') {
        promoted.set(varName, typeRef);
      }
    }
  }

  return { params, promoted };
}

/** Extract the `extends` list from an interface declaration (interfaces can extend multiple). */
export function extractInterfaceExtends(interfaceNode: TSNode): string[] {
  const result: string[] = [];
  for (const child of interfaceNode.namedChildren) {
    if (child.type === 'base_clause') {
      for (const c of child.namedChildren) {
        if (c.type === 'name' || c.type === 'qualified_name') result.push(c.text);
      }
    }
  }
  return result;
}

/**
 * Walk a method/function body and collect all call sites.
 * Handles member_call_expression, scoped_call_expression, object_creation_expression,
 * and function_call_expression.
 */
export function extractCallSites(
  bodyNode: TSNode,
  paramTypes?: Map<string, string>,
  localTypes?: Map<string, string>,
): PhpCallSite[] {
  const calls: PhpCallSite[] = [];

  /**
   * Extract a property chain from a $this->foo or $this->foo->bar expression.
   * Returns the chain starting with the $this property, or null if the chain
   * doesn't start with $this.
   */
  function extractThisChain(node: TSNode): string[] | null {
    if (node.type !== 'member_access_expression') return null;
    const children = node.namedChildren;
    if (children.length < 2) return null;
    const obj = children[0];
    const nameNode = children[1];
    if (nameNode.type !== 'name') return null;

    if (obj.type === 'variable_name') {
      const n = obj.namedChildren.find((c) => c.type === 'name');
      if (n?.text === 'this') return [nameNode.text];
      return null;
    }
    if (obj.type === 'member_access_expression') {
      const parent = extractThisChain(obj);
      if (parent) return [...parent, nameNode.text];
    }
    return null;
  }

  function visit(node: TSNode): void {
    switch (node.type) {
      case 'member_call_expression': {
        // $obj->method(args) or $this->method(args)
        // Named children: [object, name, arguments]
        const children = node.namedChildren;
        if (children.length < 2) break;
        const receiver = children[0];
        const nameNode = children.find((c, i) => i > 0 && c.type === 'name');
        if (!nameNode) break;

        const callee = nameNode.text;
        const line = nameNode.startPosition.row + 1;

        if (receiver.type === 'variable_name') {
          const varNameNode = receiver.namedChildren.find((c) => c.type === 'name');
          const varName = varNameNode?.text;
          if (varName === 'this') {
            calls.push({ type: 'this', callee, line });
          } else if (varName && paramTypes?.has(varName)) {
            // $param->method() where $param is a typed parameter
            calls.push({ type: 'param_call', callee, receiver: varName, line });
          } else if (varName && localTypes?.has(varName)) {
            // $local->method() where $local = new X() or similar
            calls.push({ type: 'local_call', callee, receiver: varName, line });
          } else {
            calls.push({ type: 'member', callee, receiver: varName, line });
          }
        } else if (receiver.type === 'member_access_expression') {
          // $this->prop->method() — chained via property
          const chain = extractThisChain(receiver);
          if (chain && chain.length > 0) {
            calls.push({ type: 'this_member_call', callee, propChain: chain, line });
          }
        }
        break;
      }

      case 'scoped_call_expression': {
        // Class::method() or self::/parent::/static::method()
        const children = node.namedChildren;
        if (children.length < 2) break;
        const scope = children[0];
        const nameNode = children.find((c, i) => i > 0 && c.type === 'name');
        if (!nameNode) break;

        const callee = nameNode.text;
        const line = nameNode.startPosition.row + 1;

        if (scope.type === 'relative_scope') {
          // self::, parent::, static::
          const kw = scope.text;
          if (kw === 'self' || kw === 'static') calls.push({ type: 'self', callee, line });
          else if (kw === 'parent') calls.push({ type: 'parent', callee, line });
        } else if (scope.type === 'name' || scope.type === 'qualified_name') {
          calls.push({ type: 'static', callee, classRef: scope.text, line });
        }
        break;
      }

      case 'object_creation_expression': {
        // new Class(args)
        const classNode = node.namedChildren.find(
          (c) => c.type === 'name' || c.type === 'qualified_name',
        );
        if (classNode) {
          calls.push({
            type: 'new',
            callee: '__construct',
            classRef: classNode.text,
            line: classNode.startPosition.row + 1,
          });
        }
        break;
      }

      case 'function_call_expression': {
        // Bare function call: functionName(args)
        const children = node.namedChildren;
        const first = children[0];
        if (first && (first.type === 'name' || first.type === 'qualified_name')) {
          calls.push({
            type: 'function',
            callee: first.text,
            line: first.startPosition.row + 1,
          });
        }
        break;
      }

      case 'member_access_expression': {
        // $obj->prop or $this->prop (standalone property access).
        const children = node.namedChildren;
        if (children.length < 2) break;
        const receiver = children[0];
        const nameNode = children[1];
        if (nameNode.type !== 'name') break;

        const line = nameNode.startPosition.row + 1;
        if (receiver.type === 'variable_name') {
          const varNameNode = receiver.namedChildren.find((c) => c.type === 'name');
          if (varNameNode?.text === 'this') {
            calls.push({ type: 'this_prop', callee: nameNode.text, line });
          } else {
            calls.push({
              type: 'member_prop',
              callee: nameNode.text,
              receiver: varNameNode?.text,
              line,
            });
          }
        }
        break;
      }

      case 'class_constant_access_expression': {
        // Class::CONST, self::CONST, enum-case Class::Case, or magic Class::class
        const children = node.namedChildren;
        if (children.length < 2) break;
        const scope = children[0];
        const nameNode = children[1];
        if (nameNode.type !== 'name') break;

        const line = nameNode.startPosition.row + 1;
        const calleeName = nameNode.text;

        // `::class` is PHP's magic constant that resolves to the class FQN.
        // Treat as a class reference, not a constant access.
        if (calleeName === 'class') {
          if (scope.type === 'name' || scope.type === 'qualified_name') {
            calls.push({ type: 'class_ref', callee: 'class', classRef: scope.text, line });
          }
          // `self::class` / `static::class` / `parent::class` — self-reference, skip.
          break;
        }

        if (scope.type === 'relative_scope') {
          calls.push({ type: 'relative_const', callee: calleeName, line });
        } else if (scope.type === 'name' || scope.type === 'qualified_name') {
          calls.push({
            type: 'class_const',
            callee: calleeName,
            classRef: scope.text,
            line,
          });
        }
        break;
      }

      case 'scoped_property_access_expression': {
        // Class::$prop, self::$prop, $obj::$prop
        const children = node.namedChildren;
        if (children.length < 2) break;
        const scope = children[0];
        const propNode = children[1];
        if (propNode.type !== 'variable_name') break;
        const nameNode = propNode.namedChildren.find((c) => c.type === 'name');
        if (!nameNode) break;

        const line = nameNode.startPosition.row + 1;
        if (scope.type === 'relative_scope') {
          calls.push({ type: 'relative_static_prop', callee: nameNode.text, line });
        } else if (scope.type === 'name' || scope.type === 'qualified_name') {
          calls.push({
            type: 'static_prop',
            callee: nameNode.text,
            classRef: scope.text,
            line,
          });
        }
        break;
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(bodyNode);
  return calls;
}
