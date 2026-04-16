/**
 * PHP Language Plugin — tree-sitter based symbol extraction.
 *
 * Extracts classes, methods, functions, interfaces, traits, enums,
 * constants, properties, and enum_cases from PHP source files.
 */
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser } from '../../../../parser/tree-sitter.js';
import {
  type TSNode,
  extractNamespace,
  extractUseStatements,
  extractClassHeritage,
  extractInterfaceExtends,
  extractCallSites,
  extractTypeRef,
  extractParamTypes,
  makeSymbolId,
  makeFqn,
  extractSignature,
  extractAttributes,
  extractPromotedProperties,
  extractPropertySymbol,
  extractConstantSymbols,
  extractModifiers,
  extractPropertyHooks,
  isReadonly,
  getVisibility,
  collectNodeTypes,
} from './helpers.js';
import { detectMinPhpVersion } from './version-features.js';

/**
 * Walk a method/function body and collect local variable types from simple
 * assignment patterns:
 *   $x = new Foo();        → $x : Foo
 *   $x = new App\Bar();    → $x : App\Bar
 * Re-assignments may override earlier types (last-write-wins).
 */
function collectLocalTypes(bodyNode: TSNode, out: Map<string, string>): void {
  function visit(node: TSNode): void {
    if (node.type === 'assignment_expression') {
      const children = node.namedChildren;
      const lhs = children[0];
      const rhs = children[1];
      if (lhs?.type === 'variable_name' && rhs?.type === 'object_creation_expression') {
        const varNameNode = lhs.namedChildren.find((c) => c.type === 'name');
        const classNode = rhs.namedChildren.find(
          (c) => c.type === 'name' || c.type === 'qualified_name',
        );
        if (varNameNode?.text && classNode?.text) {
          out.set(varNameNode.text, classNode.text);
        }
      }
    }
    for (const c of node.namedChildren) visit(c);
  }
  visit(bodyNode);
}

export class PhpLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'php-language',
    version: '1.0.0',
    priority: 0,
  };

  supportedExtensions = ['.php'];
  supportedVersions = [
    '5.0', '5.1', '5.2', '5.3', '5.4', '5.5', '5.6',
    '7.0', '7.1', '7.2', '7.3', '7.4',
    '8.0', '8.1', '8.2', '8.3', '8.4',
  ];

  async extractSymbols(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('php');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const namespace = extractNamespace(root);
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      const edges: RawEdge[] = [];
      this.walkTopLevel(root, filePath, namespace, symbols, edges);

      // Extract use statements as import edges for PSR-4 resolution
      const useStatements = extractUseStatements(root);
      for (const u of useStatements) {
        edges.push({
          edgeType: 'php_imports',
          metadata: {
            from: u.fqn,
            specifiers: [u.alias ?? u.fqn.split('\\').pop() ?? u.fqn],
          },
        });
      }

      return ok({
        language: 'php',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `PHP parse failed: ${msg}`));
    }
  }

  private walkTopLevel(root: TSNode, filePath: string, namespace: string | undefined, symbols: RawSymbol[], edges: RawEdge[]): void {
    for (const node of root.namedChildren) {
      switch (node.type) {
        case 'class_declaration':
          this.extractClass(node, filePath, namespace, symbols, edges);
          break;
        case 'interface_declaration':
          this.extractClassLike(node, filePath, namespace, symbols, edges, 'interface');
          break;
        case 'trait_declaration':
          this.extractClassLike(node, filePath, namespace, symbols, edges, 'trait');
          break;
        case 'enum_declaration':
          this.extractEnum(node, filePath, namespace, symbols);
          break;
        case 'function_definition':
          this.extractFunction(node, filePath, namespace, symbols);
          break;
        // Handle namespace body (when namespace has a block)
        case 'namespace_definition': {
          const body = node.namedChildren.find(
            (c) => c.type === 'compound_statement' || c.type === 'declaration_list',
          );
          if (body) {
            const nsName = node.namedChildren.find((c) => c.type === 'namespace_name');
            const innerNs = nsName?.text ?? namespace;
            this.walkTopLevel(body, filePath, innerNs, symbols, edges);
          }
          break;
        }
      }
    }
  }

  private extractClass(
    node: TSNode, filePath: string, namespace: string | undefined, symbols: RawSymbol[], edges: RawEdge[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const className = nameNode.text;
    const symbolId = makeSymbolId(filePath, className, 'class');
    const attrs = extractAttributes(node);
    const mods = extractModifiers(node);
    const readonly = isReadonly(node);
    const nodeTypes = collectNodeTypes(node);
    const minPhpVersion = detectMinPhpVersion(nodeTypes);

    const metadata: Record<string, unknown> = {};
    if (attrs.length > 0) metadata.attributes = attrs;
    if (readonly) metadata.readonly = true;
    if (mods.abstract) metadata.abstract = true;
    if (mods.final) metadata.final = true;
    if (minPhpVersion) metadata.minPhpVersion = minPhpVersion;

    // Extract heritage and attach unresolved refs to metadata for the resolver
    const heritage = extractClassHeritage(node);
    if (heritage.extends.length > 0) metadata.extends = heritage.extends;
    if (heritage.implements.length > 0) metadata.implements = heritage.implements;
    if (heritage.usesTraits.length > 0) metadata.usesTraits = heritage.usesTraits;

    symbols.push({
      symbolId,
      name: className,
      kind: 'class',
      fqn: makeFqn(namespace, className),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });

    const body = node.childForFieldName('body');
    if (body) {
      this.extractClassMembers(body, filePath, className, namespace, symbolId, symbols);
    }
  }

  private extractClassLike(
    node: TSNode, filePath: string, namespace: string | undefined,
    symbols: RawSymbol[], _edges: RawEdge[], kind: 'interface' | 'trait',
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const symbolId = makeSymbolId(filePath, name, kind);

    const metadata: Record<string, unknown> = {};
    if (kind === 'interface') {
      const parents = extractInterfaceExtends(node);
      if (parents.length > 0) metadata.extends = parents;
    }

    symbols.push({
      symbolId,
      name,
      kind,
      fqn: makeFqn(namespace, name),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });

    // For traits and interfaces, also extract methods
    const body = node.namedChildren.find((c) => c.type === 'declaration_list');
    if (body) {
      this.extractClassMembers(body, filePath, name, namespace, symbolId, symbols);
    }
  }

  private extractEnum(
    node: TSNode, filePath: string, namespace: string | undefined, symbols: RawSymbol[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const symbolId = makeSymbolId(filePath, name, 'enum');

    symbols.push({
      symbolId,
      name,
      kind: 'enum',
      fqn: makeFqn(namespace, name),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { minPhpVersion: '8.1' },
    });

    // Extract enum cases
    const body = node.namedChildren.find((c) => c.type === 'enum_declaration_list');
    if (body) {
      for (const child of body.namedChildren) {
        if (child.type === 'enum_case') {
          const caseName = child.childForFieldName('name')
            ?? child.namedChildren.find((c) => c.type === 'name');
          if (!caseName) continue;
          symbols.push({
            symbolId: makeSymbolId(filePath, caseName.text, 'enum_case', name),
            name: caseName.text,
            kind: 'enum_case',
            fqn: makeFqn(namespace, name, caseName.text),
            parentSymbolId: symbolId,
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
          });
        }
      }
    }
  }

  private extractFunction(
    node: TSNode, filePath: string, namespace: string | undefined, symbols: RawSymbol[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;

    const metadata: Record<string, unknown> = {};
    const body = node.childForFieldName('body');
    if (body) {
      const callSites = extractCallSites(body);
      if (callSites.length > 0) metadata.callSites = callSites;
    }

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn: namespace ? `${namespace}\\${name}` : name,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  private extractClassMembers(
    body: TSNode, filePath: string, className: string,
    namespace: string | undefined, classSymbolId: string, symbols: RawSymbol[],
  ): void {
    for (const child of body.namedChildren) {
      switch (child.type) {
        case 'method_declaration':
          this.extractMethod(child, filePath, className, namespace, classSymbolId, symbols);
          break;
        case 'property_declaration':
          this.extractProperty(child, filePath, className, namespace, classSymbolId, symbols);
          break;
        case 'const_declaration':
          this.extractConstant(child, filePath, className, namespace, classSymbolId, symbols);
          break;
      }
    }
  }

  private extractMethod(
    node: TSNode, filePath: string, className: string,
    namespace: string | undefined, classSymbolId: string, symbols: RawSymbol[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const attrs = extractAttributes(node);
    const mods = extractModifiers(node);
    const vis = getVisibility(node);

    const metadata: Record<string, unknown> = {};
    if (attrs.length > 0) metadata.attributes = attrs;
    if (mods.static) metadata.static = true;
    if (mods.abstract) metadata.abstract = true;
    if (mods.final) metadata.final = true;
    if (vis) metadata.visibility = vis;

    // Extract typed parameters for type-aware call resolution
    const paramsNode = node.namedChildren.find((c) => c.type === 'formal_parameters');
    const { params: paramTypes, promoted: promotedProps } = extractParamTypes(paramsNode);
    if (paramTypes.size > 0) {
      metadata.paramTypes = Object.fromEntries(paramTypes);
    }

    // Extract return type for chained call resolution
    // Return type is after formal_parameters, before compound_statement
    let sawParams = false;
    for (const child of node.namedChildren) {
      if (child.type === 'formal_parameters') { sawParams = true; continue; }
      if (!sawParams) continue;
      if (child.type === 'compound_statement') break;
      const retType = extractTypeRef(child);
      if (retType) { metadata.returnType = retType; break; }
    }

    // Extract call sites + local variable types from method body
    const body = node.childForFieldName('body');
    if (body) {
      // Pre-pass: track simple `$x = new Class()` assignments as local types
      const localTypes = new Map<string, string>();
      collectLocalTypes(body, localTypes);
      // Include promoted constructor properties as locals within __construct
      // (so calls like `$cache->get()` resolve within the constructor body).
      for (const [k, v] of promotedProps) localTypes.set(k, v);

      const callSites = extractCallSites(body, paramTypes, localTypes);
      if (callSites.length > 0) metadata.callSites = callSites;
      // Persist local types so the resolver can resolve 'local_call' sites.
      if (localTypes.size > 0) {
        metadata.localTypes = Object.fromEntries(localTypes);
      }
    }

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'method', className),
      name,
      kind: 'method',
      fqn: makeFqn(namespace, className, name),
      parentSymbolId: classSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });

    // Extract constructor-promoted properties
    if (name === '__construct') {
      const promoted = extractPromotedProperties(node, filePath, className, namespace, classSymbolId);
      symbols.push(...promoted);
    }
  }

  private extractProperty(
    node: TSNode, filePath: string, className: string,
    namespace: string | undefined, classSymbolId: string, symbols: RawSymbol[],
  ): void {
    const sym = extractPropertySymbol(node, filePath, className, namespace, classSymbolId);
    if (sym) symbols.push(sym);

    // Extract property hooks (PHP 8.4+)
    const propName = sym?.name;
    if (propName) {
      const hooks = extractPropertyHooks(node, filePath, className, namespace, classSymbolId, propName);
      symbols.push(...hooks);
    }
  }

  private extractConstant(
    node: TSNode, filePath: string, className: string,
    namespace: string | undefined, classSymbolId: string, symbols: RawSymbol[],
  ): void {
    symbols.push(...extractConstantSymbols(node, filePath, className, namespace, classSymbolId));
  }
}
