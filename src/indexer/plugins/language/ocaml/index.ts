/**
 * OCaml Language Plugin — tree-sitter-based symbol extraction (v3).
 *
 * Extracts: let/val bindings, type definitions with record fields and
 * variant constructors, modules (with functor detection), module types,
 * classes with methods and instance variables, external declarations,
 * exceptions, and import edges (open/include statements).
 */
import { ok, err } from 'neverthrow';
import type {
  LanguagePlugin,
  PluginManifest,
  FileParseResult,
  RawSymbol,
  RawEdge,
  SymbolKind,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';

function makeSymbolId(filePath: string, name: string, kind: string, parent?: string): string {
  return parent ? `${filePath}::${parent}.${name}#${kind}` : `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode, maxLen = 120): string {
  const firstLine = node.text.split('\n')[0].trim();
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + '…' : firstLine;
}

function findChildByTypes(node: TSNode, types: string[]): TSNode | null {
  for (const child of node.namedChildren) {
    if (types.includes(child.type)) return child;
  }
  return null;
}

function extractName(node: TSNode, ...childTypes: string[]): string | null {
  for (const t of childTypes) {
    for (const child of node.namedChildren) {
      if (child.type === t) return child.text;
    }
  }
  return null;
}

export class OcamlLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'ocaml-language',
    version: '3.0.0',
    priority: 5,
  };

  supportedExtensions = ['.ml', '.mli'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('ocaml');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const warnings: string[] = [];
      const seen = new Set<string>();

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      const addSymbol = (
        name: string,
        kind: SymbolKind,
        node: TSNode,
        meta?: Record<string, unknown>,
        parent?: string,
      ): void => {
        const sid = makeSymbolId(filePath, name, kind, parent);
        if (seen.has(sid)) return;
        seen.add(sid);
        symbols.push({
          symbolId: sid,
          name,
          kind,
          fqn: parent ? `${parent}.${name}` : name,
          parentSymbolId: parent ? makeSymbolId(filePath, parent, 'module') : undefined,
          signature: extractSignature(node),
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          metadata: meta,
        });
      };

      for (const child of root.namedChildren) {
        this.visitNode(child, addSymbol, edges);
      }

      return ok({
        language: 'ocaml',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `OCaml parse failed: ${msg}`));
    }
  }

  private visitNode(
    node: TSNode,
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      meta?: Record<string, unknown>,
      parent?: string,
    ) => void,
    edges: RawEdge[],
    parentModule?: string,
  ): void {
    switch (node.type) {
      // ── let / let rec bindings ──────────────────────────────────
      case 'value_definition': {
        const isRec = node.text.trimStart().startsWith('let rec');
        for (const child of node.namedChildren) {
          if (child.type === 'let_binding') {
            const nameNode = findChildByTypes(child, ['value_name', 'value_pattern']);
            const name = nameNode?.text;
            if (name && /^\w+$/.test(name)) {
              const meta: Record<string, unknown> = {};
              if (isRec) meta.recursive = true;
              addSymbol(
                name,
                'function',
                child,
                Object.keys(meta).length > 0 ? meta : undefined,
                parentModule,
              );
            }
          }
        }
        break;
      }

      // ── val specifications (.mli) ──────────────────────────────
      case 'value_specification': {
        const name = extractName(node, 'value_name');
        if (name) addSymbol(name, 'function', node, undefined, parentModule);
        break;
      }

      // ── external declarations ──────────────────────────────────
      case 'external': {
        const name = extractName(node, 'value_name');
        if (name) addSymbol(name, 'function', node, { external: true }, parentModule);
        break;
      }

      // ── type definitions ───────────────────────────────────────
      case 'type_definition': {
        for (const child of node.namedChildren) {
          if (child.type === 'type_binding') {
            const name = extractName(child, 'type_constructor', 'type_constructor_path');
            if (name) {
              addSymbol(name, 'type', child, undefined, parentModule);
              this.extractTypeMembers(child, name, addSymbol, parentModule);
            }
          }
        }
        break;
      }

      // ── module definitions ─────────────────────────────────────
      case 'module_definition': {
        let moduleName: string | undefined;
        for (const child of node.namedChildren) {
          if (child.type === 'module_binding') {
            const innerName = extractName(child, 'module_name');
            if (innerName) {
              moduleName = innerName;
              const isFunctor = child.namedChildren.some((cc) => cc.type === 'module_parameter');
              const meta: Record<string, unknown> = {};
              if (isFunctor) meta.functor = true;
              addSymbol(
                innerName,
                'module',
                node,
                Object.keys(meta).length > 0 ? meta : undefined,
                parentModule,
              );
            }
          }
        }
        // Recurse into module body for nested symbols
        if (moduleName) {
          const qualifiedName = parentModule ? `${parentModule}.${moduleName}` : moduleName;
          for (const child of node.namedChildren) {
            if (child.type === 'module_binding') {
              for (const inner of child.namedChildren) {
                if (inner.type === 'structure' || inner.type === 'module_expression') {
                  for (const c of inner.namedChildren) {
                    this.visitNode(c, addSymbol, edges, qualifiedName);
                  }
                }
              }
            }
          }
        }
        break;
      }

      // ── module type definitions ────────────────────────────────
      case 'module_type_definition': {
        const name = extractName(node, 'module_type_name');
        if (name) addSymbol(name, 'type', node, { moduleType: true }, parentModule);
        break;
      }

      // ── class definitions ──────────────────────────────────────
      case 'class_definition': {
        for (const child of node.namedChildren) {
          if (child.type === 'class_binding') {
            const name = extractName(child, 'class_name');
            if (name) {
              addSymbol(name, 'class', child, undefined, parentModule);
              this.extractClassMembers(child, name, addSymbol, parentModule);
            }
          }
        }
        break;
      }

      // ── class type definitions ─────────────────────────────────
      case 'class_type_definition': {
        for (const child of node.namedChildren) {
          if (child.type === 'class_type_binding') {
            const name = extractName(child, 'class_type_name', 'class_name');
            if (name) addSymbol(name, 'interface', child, undefined, parentModule);
          }
        }
        break;
      }

      // ── exception definitions ──────────────────────────────────
      case 'exception_definition': {
        const name = extractName(node, 'constructor_name', 'constructor_declaration');
        if (name) {
          addSymbol(name, 'constant', node, { exception: true }, parentModule);
        } else {
          for (const child of node.namedChildren) {
            if (child.type === 'constructor_declaration') {
              const innerName = extractName(child, 'constructor_name');
              if (innerName)
                addSymbol(innerName, 'constant', node, { exception: true }, parentModule);
            }
          }
        }
        break;
      }

      // ── open statements (import edges) ─────────────────────────
      case 'open_statement':
      case 'open_module': {
        const modNode = findChildByTypes(node, [
          'module_path',
          'module_name',
          'extended_module_path',
        ]);
        if (modNode) {
          edges.push({ edgeType: 'imports', metadata: { module: modNode.text } });
        }
        break;
      }

      // ── include statements ─────────────────────────────────────
      case 'include_statement':
      case 'include_module': {
        const modNode = findChildByTypes(node, [
          'module_path',
          'module_name',
          'extended_module_path',
        ]);
        if (modNode) {
          edges.push({ edgeType: 'imports', metadata: { module: modNode.text, include: true } });
        }
        break;
      }

      // For structure/signature wrapper nodes, recurse
      default: {
        if (
          node.type === 'structure' ||
          node.type === 'signature' ||
          node.type === 'module_expression'
        ) {
          for (const child of node.namedChildren) {
            this.visitNode(child, addSymbol, edges, parentModule);
          }
        }
        break;
      }
    }
  }

  /** Extract record fields and variant constructors from a type binding. */
  private extractTypeMembers(
    typeBinding: TSNode,
    typeName: string,
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      meta?: Record<string, unknown>,
      parent?: string,
    ) => void,
    parentModule?: string,
  ): void {
    const qualifiedParent = parentModule ? `${parentModule}.${typeName}` : typeName;
    for (const child of typeBinding.namedChildren) {
      if (child.type === 'record_declaration') {
        for (const field of child.namedChildren) {
          if (field.type === 'field_declaration') {
            const fieldName = extractName(field, 'field_name');
            if (fieldName) {
              const isMutable = field.text.includes('mutable');
              addSymbol(
                fieldName,
                'property',
                field,
                isMutable ? { mutable: true } : undefined,
                qualifiedParent,
              );
            }
          }
        }
      }
      if (child.type === 'constructor_declaration') {
        const ctorName = extractName(child, 'constructor_name');
        if (ctorName) addSymbol(ctorName, 'constant', child, { variant: true }, qualifiedParent);
      }
      if (child.type === 'variant_declaration') {
        for (const ctor of child.namedChildren) {
          if (ctor.type === 'constructor_declaration') {
            const ctorName = extractName(ctor, 'constructor_name');
            if (ctorName) addSymbol(ctorName, 'constant', ctor, { variant: true }, qualifiedParent);
          }
        }
      }
    }
  }

  /** Extract methods and instance variables from an OCaml class body. */
  private extractClassMembers(
    classBinding: TSNode,
    className: string,
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      meta?: Record<string, unknown>,
      parent?: string,
    ) => void,
    parentModule?: string,
  ): void {
    const qualifiedParent = parentModule ? `${parentModule}.${className}` : className;
    const stack: TSNode[] = [...classBinding.namedChildren];
    while (stack.length > 0) {
      const child = stack.pop()!;
      if (child.type === 'method_definition') {
        const methodName = extractName(child, 'method_name', 'value_name');
        if (methodName) {
          const meta: Record<string, unknown> = {};
          if (child.text.includes('virtual')) meta.virtual = true;
          if (child.text.includes('private')) meta.private = true;
          addSymbol(
            methodName,
            'method',
            child,
            Object.keys(meta).length > 0 ? meta : undefined,
            qualifiedParent,
          );
        }
      } else if (child.type === 'instance_variable_definition') {
        const valName = extractName(child, 'instance_variable_name', 'value_name');
        if (valName) {
          const isMutable = child.text.includes('mutable');
          addSymbol(
            valName,
            'property',
            child,
            isMutable ? { mutable: true } : undefined,
            qualifiedParent,
          );
        }
      } else if (child.namedChildren.length > 0) {
        for (const c of child.namedChildren) stack.push(c);
      }
    }
  }
}
