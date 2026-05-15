/**
 * Objective-C Language Plugin — tree-sitter-based symbol extraction.
 *
 * Extracts: @interface, @implementation, @protocol, category interfaces/implementations,
 * methods (full selector), @property, C functions, #define, typedef, NS_ENUM/NS_OPTIONS,
 * and import edges (#import, @import, #include).
 */
import { err, ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawEdge,
  RawSymbol,
  SymbolKind,
} from '../../../../plugin-api/types.js';

function makeSymbolId(filePath: string, name: string, kind: string, parentName?: string): string {
  if (parentName) return `${filePath}::${parentName}::${name}#${kind}`;
  return `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode): string {
  const firstLine = node.text.split('\n')[0].trim();
  const braceIdx = firstLine.indexOf('{');
  if (braceIdx > 0) return firstLine.substring(0, braceIdx).trim();
  return firstLine.replace(/;\s*$/, '').trim();
}

/**
 * Get the first identifier child of a node (used for class/protocol names).
 * tree-sitter-objc does NOT use `name` field for class_interface etc.
 */
function getFirstIdentifier(node: TSNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      return child.text;
    }
  }
  return undefined;
}

/**
 * Build full Objective-C method selector from a method_definition or method_declaration node.
 *
 * tree-sitter-objc structure:
 *   method_definition: [+/-] method_type identifier [method_parameter identifier method_parameter ...] compound_statement
 *
 * For a unary method like `doSomething`, there's a single identifier and no method_parameter.
 * For `initWithFrame:style:`, the top-level named children include:
 *   identifier("initWithFrame"), method_parameter, identifier("style"), method_parameter
 * The full selector is formed by joining each selector-part identifier with ':'
 */
function extractMethodSelector(node: TSNode): string | null {
  const selectorParts: string[] = [];
  let hasParams = false;

  for (const child of node.namedChildren) {
    if (child.type === 'method_type') continue;
    if (child.type === 'compound_statement') break;
    if (child.type === 'identifier') {
      selectorParts.push(child.text);
    } else if (child.type === 'method_parameter') {
      hasParams = true;
    }
  }

  if (selectorParts.length === 0) return null;

  if (hasParams) {
    // Each identifier corresponds to a selector keyword followed by ':'
    return selectorParts.map((p) => `${p}:`).join('');
  }
  // Unary selector (no parameters)
  return selectorParts[0];
}

/** Determine if a method node is a class method (+) or instance method (-) */
function isClassMethod(node: TSNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === '+') return true;
    if (child.type === '-') return false;
  }
  return false;
}

export class ObjCLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'objc-language',
    version: '2.0.0',
    priority: 6,
  };

  supportedExtensions = ['.m', '.mm'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('objc');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      try {
        const root: TSNode = tree.rootNode;

        const hasError = root.hasError;
        const symbols: RawSymbol[] = [];
        const edges: RawEdge[] = [];
        const warnings: string[] = [];

        if (hasError) {
          warnings.push('Source contains syntax errors; extraction may be incomplete');
        }

        const seen = new Set<string>();

        const addSymbol = (
          name: string,
          kind: SymbolKind,
          node: TSNode,
          meta?: Record<string, unknown>,
          parentName?: string,
        ) => {
          const sid = makeSymbolId(filePath, name, kind, parentName);
          if (seen.has(sid)) return;
          seen.add(sid);
          symbols.push({
            symbolId: sid,
            name,
            kind,
            fqn: parentName ? `${parentName}::${name}` : name,
            signature: extractSignature(node),
            byteStart: node.startIndex,
            byteEnd: node.endIndex,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            metadata: meta,
            ...(parentName ? { parentSymbolId: makeSymbolId(filePath, parentName, 'class') } : {}),
          });
        };

        this.walkNodes(root.namedChildren, filePath, symbols, edges, addSymbol);

        return ok({
          language: 'objc',
          status: hasError ? 'partial' : 'ok',
          symbols,
          edges: edges.length > 0 ? edges : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      } finally {
        tree.delete();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Objective-C parse failed: ${msg}`));
    }
  }

  private walkNodes(
    nodes: TSNode[],
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      meta?: Record<string, unknown>,
      parentName?: string,
    ) => void,
  ): void {
    for (const node of nodes) {
      switch (node.type) {
        // ── Class-level declarations ──────────────────────────────────
        case 'class_interface': {
          const name = getFirstIdentifier(node);
          if (name) {
            const meta: Record<string, unknown> = { objcKind: 'interface' };
            const superRef = node.childForFieldName('superclass');
            if (superRef) meta.extends = superRef.text;
            const protocols = node.descendantsOfType('protocol_identifier');
            if (protocols.length > 0) {
              meta.implements = protocols.map((p) => p.text);
            }
            addSymbol(name, 'class', node, meta);
            this.extractClassBody(node, filePath, name, symbols, edges, addSymbol);
          }
          break;
        }

        case 'class_implementation': {
          const name = getFirstIdentifier(node);
          if (name) {
            addSymbol(name, 'class', node, { objcKind: 'implementation' });
            this.extractClassBody(node, filePath, name, symbols, edges, addSymbol);
          }
          break;
        }

        case 'protocol_declaration': {
          const name = getFirstIdentifier(node);
          if (name) {
            addSymbol(name, 'interface', node, { objcKind: 'protocol' });
            this.extractClassBody(node, filePath, name, symbols, edges, addSymbol);
          }
          break;
        }

        case 'category_interface': {
          const name = getFirstIdentifier(node);
          if (name) {
            const catNode = node.childForFieldName('category');
            const catName = catNode?.text;
            const displayName = catName ? `${name}(${catName})` : name;
            addSymbol(displayName, 'class', node, {
              objcKind: 'category_interface',
              className: name,
              category: catName,
            });
            this.extractClassBody(node, filePath, name, symbols, edges, addSymbol);
          }
          break;
        }

        case 'category_implementation': {
          const name = getFirstIdentifier(node);
          if (name) {
            const catNode = node.childForFieldName('category');
            const catName = catNode?.text;
            const displayName = catName ? `${name}(${catName})` : name;
            addSymbol(displayName, 'class', node, {
              objcKind: 'category_implementation',
              className: name,
              category: catName,
            });
            this.extractClassBody(node, filePath, name, symbols, edges, addSymbol);
          }
          break;
        }

        // ── C functions ──────────────────────────────────────────────
        case 'function_definition':
        case 'function_declaration': {
          this.extractFunction(node, addSymbol);
          break;
        }

        // ── #define ──────────────────────────────────────────────────
        case 'preproc_def': {
          const nameNode = node.childForFieldName('name');
          if (nameNode) addSymbol(nameNode.text, 'constant', node);
          break;
        }

        // ── typedef ─────────────────────────────────────────────────
        case 'type_definition': {
          this.extractTypedef(node, addSymbol);
          break;
        }

        // ── Enums (standalone, not covered by typedef) ──────────────
        case 'enum_specifier': {
          const name = node.childForFieldName('name');
          if (name) addSymbol(name.text, 'enum', node);
          break;
        }

        // ── Import edges ────────────────────────────────────────────
        // In tree-sitter-objc, both #import and #include map to preproc_include
        case 'preproc_include': {
          const pathNode = node.childForFieldName('path');
          if (pathNode) {
            const raw = pathNode.text;
            // system_lib_string: "<Foundation/Foundation.h>" — strip angle brackets
            // string_literal: '"MyHeader.h"' — strip quotes
            const importPath = raw.replace(/^["<]|[">]$/g, '');
            const isSystem = raw.startsWith('<');
            edges.push({
              edgeType: 'imports',
              metadata: { module: importPath, ...(isSystem ? { system: true } : {}) },
            });
          }
          break;
        }

        case 'module_import': {
          // @import UIKit; — module name is in the 'path' field (identifier node)
          const pathNode = node.childForFieldName('path');
          if (pathNode) {
            edges.push({ edgeType: 'imports', metadata: { module: pathNode.text } });
          } else {
            // Fallback: search named children
            const modName = node.namedChildren.find((c) => c.type === 'identifier');
            if (modName) {
              edges.push({ edgeType: 'imports', metadata: { module: modName.text } });
            } else {
              const text = node.text.trim();
              const match = text.match(/@import\s+([\w.]+)\s*;?/);
              if (match) edges.push({ edgeType: 'imports', metadata: { module: match[1] } });
            }
          }
          break;
        }

        default: {
          // Recurse into unknown compound nodes
          if (node.namedChildCount > 0) {
            this.walkNodes(node.namedChildren, filePath, symbols, edges, addSymbol);
          }
          break;
        }
      }
    }
  }

  /** Extract methods and properties from inside a class/protocol body */
  private extractClassBody(
    classNode: TSNode,
    filePath: string,
    className: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      meta?: Record<string, unknown>,
      parentName?: string,
    ) => void,
  ): void {
    for (const child of classNode.namedChildren) {
      switch (child.type) {
        case 'method_declaration':
        case 'method_definition': {
          this.extractMethod(child, addSymbol, className);
          break;
        }

        case 'implementation_definition': {
          // implementation_definition wraps method_definition inside @implementation
          for (const inner of child.namedChildren) {
            if (inner.type === 'method_definition') {
              this.extractMethod(inner, addSymbol, className);
            }
          }
          break;
        }

        case 'property_declaration': {
          this.extractProperty(child, addSymbol, className);
          break;
        }

        case 'function_definition':
        case 'function_declaration': {
          this.extractFunction(child, addSymbol);
          break;
        }

        default: {
          // Recurse into sub-containers (e.g., instance_variables blocks, interface_declaration_list)
          if (
            child.namedChildCount > 0 &&
            child.type !== 'identifier' &&
            child.type !== 'type_identifier' &&
            child.type !== 'protocol_reference_list'
          ) {
            this.extractClassBody(child, filePath, className, symbols, edges, addSymbol);
          }
          break;
        }
      }
    }
  }

  /** Extract a method declaration or definition */
  private extractMethod(
    node: TSNode,
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      meta?: Record<string, unknown>,
      parentName?: string,
    ) => void,
    parentName?: string,
  ): void {
    const selector = extractMethodSelector(node);
    if (!selector) return;

    const isStatic = isClassMethod(node);
    const meta: Record<string, unknown> = {};
    if (isStatic) meta.static = true;

    addSymbol(
      selector,
      'method',
      node,
      Object.keys(meta).length > 0 ? meta : undefined,
      parentName,
    );
  }

  /** Extract @property declarations */
  private extractProperty(
    node: TSNode,
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      meta?: Record<string, unknown>,
      parentName?: string,
    ) => void,
    parentName?: string,
  ): void {
    // In tree-sitter-objc, property_declaration contains:
    //   property_attributes_declaration, struct_declaration
    // The property name is inside struct_declaration > struct_declarator > pointer_declarator > identifier
    // or struct_declaration > struct_declarator > identifier (for non-pointer types)
    const propName = this.findPropertyName(node);
    if (propName) {
      addSymbol(propName, 'property', node, undefined, parentName);
    }
  }

  /** Find the property name from a property_declaration subtree */
  private findPropertyName(node: TSNode): string | null {
    // Walk down looking for struct_declarator or the deepest identifier in the declarator chain
    for (const child of node.namedChildren) {
      if (child.type === 'struct_declaration') {
        return this.findPropertyName(child);
      }
      if (child.type === 'struct_declarator') {
        return this.extractDeclaratorName(child);
      }
    }
    // Fallback: last identifier
    const identifiers = node.descendantsOfType('identifier');
    if (identifiers.length > 0) {
      return identifiers[identifiers.length - 1].text;
    }
    return null;
  }

  /** Extract identifier name from a declarator node (handles pointer_declarator wrapping) */
  private extractDeclaratorName(node: TSNode): string | null {
    if (node.type === 'identifier') return node.text;
    const decl = node.childForFieldName('declarator');
    if (decl) return this.extractDeclaratorName(decl);
    // Walk named children
    for (const child of node.namedChildren) {
      const result = this.extractDeclaratorName(child);
      if (result) return result;
    }
    return null;
  }

  /** Extract C function definition or declaration */
  private extractFunction(
    node: TSNode,
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      meta?: Record<string, unknown>,
      parentName?: string,
    ) => void,
  ): void {
    const declarator = node.childForFieldName('declarator');
    if (declarator) {
      const name = this.extractFunctionName(declarator);
      if (name) addSymbol(name, 'function', node);
      return;
    }
    const name = node.childForFieldName('name');
    if (name) addSymbol(name.text, 'function', node);
  }

  /** Recursively extract function name from a declarator */
  private extractFunctionName(node: TSNode): string | null {
    if (node.type === 'identifier') return node.text;
    if (
      node.type === 'function_declarator' ||
      node.type === 'pointer_declarator' ||
      node.type === 'parenthesized_declarator'
    ) {
      const decl = node.childForFieldName('declarator');
      if (decl) return this.extractFunctionName(decl);
    }
    for (const child of node.namedChildren) {
      const result = this.extractFunctionName(child);
      if (result) return result;
    }
    return null;
  }

  /** Extract typedef — checks for NS_ENUM/NS_OPTIONS pattern too */
  private extractTypedef(
    node: TSNode,
    addSymbol: (
      name: string,
      kind: SymbolKind,
      node: TSNode,
      meta?: Record<string, unknown>,
      parentName?: string,
    ) => void,
  ): void {
    const text = node.text;

    // NS_ENUM / NS_OPTIONS / NS_CLOSED_ENUM pattern
    const enumMatch = text.match(/\b(?:NS_ENUM|NS_OPTIONS|NS_CLOSED_ENUM)\s*\([^,]+,\s*(\w+)\s*\)/);
    if (enumMatch) {
      addSymbol(enumMatch[1], 'enum', node);
      return;
    }

    // Regular typedef
    const declarator = node.childForFieldName('declarator');
    if (declarator) {
      const typeName =
        declarator.type === 'identifier' ? declarator.text : this.extractFunctionName(declarator);
      if (typeName) {
        addSymbol(typeName, 'type', node);
        return;
      }
    }

    // Fallback: regex on text
    const typedefMatch = text.match(/\b(\w+)\s*;?\s*$/);
    if (typedefMatch) addSymbol(typedefMatch[1], 'type', node);
  }
}
