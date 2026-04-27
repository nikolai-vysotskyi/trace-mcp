/**
 * C++ Language Plugin — tree-sitter based symbol extraction.
 */
import { ok, err } from 'neverthrow';
import type {
  LanguagePlugin,
  PluginManifest,
  FileParseResult,
  RawSymbol,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser } from '../../../../parser/tree-sitter.js';
import {
  type TSNode,
  makeSymbolId,
  makeFqn,
  extractSignature,
  extractDeclaratorName,
  extractTemplateParams,
  extractImportEdges,
  extractClassFields,
  extractEnumCases,
  getNodeName,
  isPureVirtual,
  isVirtual,
} from './helpers.js';

export class CppLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'cpp-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.cpp', '.cxx', '.cc', '.hpp', '.hxx', '.hh', '.h++', '.ino', '.pde'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('cpp');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walkNodes(root.namedChildren, filePath, [], symbols);

      const edges = extractImportEdges(root);

      return ok({
        language: 'cpp',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `C++ parse failed: ${msg}`));
    }
  }

  /**
   * Recursively walk AST nodes, extracting symbols.
   * namespaceParts tracks the current namespace scope for FQN construction.
   */
  private walkNodes(
    nodes: TSNode[],
    filePath: string,
    namespaceParts: string[],
    symbols: RawSymbol[],
  ): void {
    for (const child of nodes) {
      switch (child.type) {
        case 'namespace_definition':
          this.extractNamespace(child, filePath, namespaceParts, symbols);
          break;
        case 'class_specifier':
          this.extractClassLike(child, filePath, namespaceParts, 'class', undefined, symbols);
          break;
        case 'struct_specifier':
          this.extractClassLike(child, filePath, namespaceParts, 'class', 'struct', symbols);
          break;
        case 'union_specifier':
          this.extractClassLike(child, filePath, namespaceParts, 'class', 'union', symbols);
          break;
        case 'enum_specifier':
          this.extractEnum(child, filePath, namespaceParts, undefined, symbols);
          break;
        case 'function_definition':
          this.extractFunction(child, filePath, namespaceParts, undefined, symbols);
          break;
        case 'template_declaration':
          this.extractTemplate(child, filePath, namespaceParts, symbols);
          break;
        case 'alias_declaration':
          this.extractTypeAlias(child, filePath, namespaceParts, symbols);
          break;
        case 'type_definition':
          this.extractTypedef(child, filePath, namespaceParts, symbols);
          break;
        case 'preproc_def':
        case 'preproc_function_def':
          this.extractMacro(child, filePath, namespaceParts, symbols);
          break;
        case 'declaration':
          this.extractDeclaration(child, filePath, namespaceParts, symbols);
          break;
      }
    }
  }

  private extractNamespace(
    node: TSNode,
    filePath: string,
    namespaceParts: string[],
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) {
      // Anonymous namespace — still recurse into body
      const body = node.childForFieldName('body');
      if (body) {
        this.walkNodes(body.namedChildren, filePath, namespaceParts, symbols);
      }
      return;
    }

    const fqnParts = [...namespaceParts, name];
    const symbolId = makeSymbolId(filePath, makeFqn(fqnParts), 'namespace');

    symbols.push({
      symbolId,
      name,
      kind: 'namespace',
      fqn: makeFqn(fqnParts),
      signature: `namespace ${name}`,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });

    const body = node.childForFieldName('body');
    if (body) {
      this.walkNodes(body.namedChildren, filePath, fqnParts, symbols);
    }
  }

  private extractClassLike(
    node: TSNode,
    filePath: string,
    namespaceParts: string[],
    kind: 'class',
    cppKind: string | undefined,
    symbols: RawSymbol[],
    templateParams?: string,
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = [...namespaceParts, name];
    const symbolId = makeSymbolId(filePath, makeFqn(fqnParts), 'class');
    const meta: Record<string, unknown> = {};
    if (cppKind) meta.cppKind = cppKind;
    if (templateParams) meta.template = templateParams;

    // Check for base classes
    const bases: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'base_class_clause') {
        for (const baseSpec of child.namedChildren) {
          // base_class_clause contains type_identifier or qualified_identifier children
          if (
            baseSpec.type === 'type_identifier' ||
            baseSpec.type === 'qualified_identifier' ||
            baseSpec.type === 'template_type'
          ) {
            bases.push(baseSpec.text);
          }
          // Also handle access-specified bases like `public Base`
          if (baseSpec.type === 'access_specifier') continue;
        }
      }
    }
    if (bases.length > 0) meta.bases = bases;

    const sig = templateParams
      ? `template ${templateParams} ${cppKind ?? 'class'} ${name}`
      : `${cppKind ?? 'class'} ${name}`;

    symbols.push({
      symbolId,
      name,
      kind,
      fqn: makeFqn(fqnParts),
      signature: sig,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Extract body members
    const body = node.childForFieldName('body');
    if (body) {
      const fields = extractClassFields(body, filePath, makeFqn(fqnParts), symbolId, fqnParts);
      symbols.push(...fields);
      this.extractClassMethods(body, filePath, fqnParts, symbolId, symbols);
    }
  }

  /**
   * Extract methods and nested types from a class/struct body.
   */
  private extractClassMethods(
    body: TSNode,
    filePath: string,
    fqnParts: string[],
    parentSymbolId: string,
    symbols: RawSymbol[],
  ): void {
    let currentAccess: string | undefined;
    const className = fqnParts[fqnParts.length - 1];

    for (const child of body.namedChildren) {
      if (child.type === 'access_specifier') {
        currentAccess = child.text.replace(/:$/, '').trim();
        continue;
      }

      if (child.type === 'function_definition') {
        this.extractMethodFromBody(
          child,
          filePath,
          fqnParts,
          parentSymbolId,
          currentAccess,
          false,
          symbols,
        );
      } else if (child.type === 'declaration') {
        // Method declarations (without body) inside class
        this.extractMethodDeclaration(
          child,
          filePath,
          fqnParts,
          parentSymbolId,
          currentAccess,
          symbols,
        );
      } else if (child.type === 'template_declaration') {
        // Template methods inside class
        const inner = this.getTemplateInner(child);
        const tParams = extractTemplateParams(child);
        if (inner?.type === 'function_definition') {
          this.extractMethodFromBody(
            inner,
            filePath,
            fqnParts,
            parentSymbolId,
            currentAccess,
            false,
            symbols,
            tParams,
          );
        } else if (inner?.type === 'declaration') {
          this.extractMethodDeclaration(
            inner,
            filePath,
            fqnParts,
            parentSymbolId,
            currentAccess,
            symbols,
            tParams,
          );
        }
      } else if (child.type === 'class_specifier') {
        this.extractClassLike(child, filePath, fqnParts, 'class', undefined, symbols);
      } else if (child.type === 'struct_specifier') {
        this.extractClassLike(child, filePath, fqnParts, 'class', 'struct', symbols);
      } else if (child.type === 'enum_specifier') {
        this.extractEnum(child, filePath, fqnParts, undefined, symbols);
      } else if (child.type === 'alias_declaration') {
        this.extractTypeAlias(child, filePath, fqnParts, symbols);
      } else if (child.type === 'friend_declaration') {
        // Skip friend declarations
      }
    }
  }

  private extractMethodFromBody(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    parentSymbolId: string,
    access: string | undefined,
    isVirtualMethod: boolean,
    symbols: RawSymbol[],
    templateParams?: string,
  ): void {
    const info = extractDeclaratorName(node);
    if (!info) return;

    const name = info.name;
    const meta: Record<string, unknown> = {};
    if (access) meta.access = access;
    if (isVirtual(node)) meta.virtual = true;
    if (templateParams) meta.template = templateParams;

    // Check for static, const, override, etc. in the text
    const text = node.text;
    if (/\bstatic\b/.test(text.split('(')[0])) meta.static = true;
    if (/\bconst\s*(?:\{|$)/m.test(text)) meta.const = true;
    if (/\boverride\b/.test(text)) meta.override = true;

    const className = fqnParts[fqnParts.length - 1];
    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'method', className),
      name,
      kind: 'method',
      parentSymbolId,
      fqn: makeFqn([...fqnParts, name]),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractMethodDeclaration(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    parentSymbolId: string,
    access: string | undefined,
    symbols: RawSymbol[],
    templateParams?: string,
  ): void {
    const info = extractDeclaratorName(node);
    if (!info) return;

    const name = info.name;
    const meta: Record<string, unknown> = {};
    if (access) meta.access = access;
    meta.declaration = true;
    if (templateParams) meta.template = templateParams;

    if (isPureVirtual(node)) {
      meta.abstract = true;
      meta.virtual = true;
    } else if (isVirtual(node)) {
      meta.virtual = true;
    }

    const text = node.text;
    if (/\bstatic\b/.test(text.split('(')[0])) meta.static = true;
    if (/\boverride\b/.test(text)) meta.override = true;

    const className = fqnParts[fqnParts.length - 1];
    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'method', className),
      name,
      kind: 'method',
      parentSymbolId,
      fqn: makeFqn([...fqnParts, name]),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractFunction(
    node: TSNode,
    filePath: string,
    namespaceParts: string[],
    templateParams: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const info = extractDeclaratorName(node);
    if (!info) return;

    const name = info.name;
    const meta: Record<string, unknown> = {};
    if (templateParams) meta.template = templateParams;

    // If the function has a qualifier (ClassName::method), it's an out-of-line method definition
    if (info.qualifier) {
      meta.outOfLine = true;
      meta.qualifier = info.qualifier;
    }

    const text = node.text;
    if (/\bstatic\b/.test(text.split('(')[0])) meta.static = true;
    if (/\binline\b/.test(text.split('(')[0])) meta.inline = true;
    if (/\bconstexpr\b/.test(text.split('(')[0])) meta.constexpr = true;

    const fqnParts = info.qualifier
      ? [...namespaceParts, info.qualifier, name]
      : [...namespaceParts, name];

    symbols.push({
      symbolId: makeSymbolId(filePath, makeFqn(fqnParts), info.qualifier ? 'method' : 'function'),
      name,
      kind: info.qualifier ? 'method' : 'function',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractTemplate(
    node: TSNode,
    filePath: string,
    namespaceParts: string[],
    symbols: RawSymbol[],
  ): void {
    const tParams = extractTemplateParams(node);
    const inner = this.getTemplateInner(node);
    if (!inner) return;

    switch (inner.type) {
      case 'class_specifier':
        this.extractClassLike(
          inner,
          filePath,
          namespaceParts,
          'class',
          undefined,
          symbols,
          tParams,
        );
        break;
      case 'struct_specifier':
        this.extractClassLike(inner, filePath, namespaceParts, 'class', 'struct', symbols, tParams);
        break;
      case 'union_specifier':
        this.extractClassLike(inner, filePath, namespaceParts, 'class', 'union', symbols, tParams);
        break;
      case 'function_definition':
        this.extractFunction(inner, filePath, namespaceParts, tParams, symbols);
        break;
      case 'declaration':
        // Template variable or function declaration
        this.extractDeclaration(inner, filePath, namespaceParts, symbols, tParams);
        break;
      case 'alias_declaration':
        this.extractTypeAlias(inner, filePath, namespaceParts, symbols, tParams);
        break;
      case 'template_declaration':
        // Nested templates (template <...> template <...> ...)
        this.extractTemplate(inner, filePath, namespaceParts, symbols);
        break;
    }
  }

  /**
   * Get the inner declaration from a template_declaration.
   */
  private getTemplateInner(node: TSNode): TSNode | null {
    // The inner declaration is the last named child that isn't the parameter list
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child && child.type !== 'template_parameter_list') return child;
    }
    return null;
  }

  private extractEnum(
    node: TSNode,
    filePath: string,
    namespaceParts: string[],
    templateParams: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = [...namespaceParts, name];
    const symbolId = makeSymbolId(filePath, makeFqn(fqnParts), 'enum');
    const meta: Record<string, unknown> = {};
    if (templateParams) meta.template = templateParams;

    // Check if it's enum class / enum struct (scoped enum)
    const text = node.text;
    if (/\benum\s+class\b/.test(text)) meta.scoped = true;
    if (/\benum\s+struct\b/.test(text)) meta.scoped = true;

    // Check for underlying type
    for (const child of node.namedChildren) {
      if (child.type === 'type_identifier' && child !== node.childForFieldName('name')) {
        meta.underlyingType = child.text;
      }
    }

    const sig = meta.scoped ? `enum class ${name}` : `enum ${name}`;

    symbols.push({
      symbolId,
      name,
      kind: 'enum',
      fqn: makeFqn(fqnParts),
      signature: sig,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Extract enum cases
    const body = node.childForFieldName('body');
    if (body) {
      const cases = extractEnumCases(body, filePath, makeFqn(fqnParts), symbolId, fqnParts);
      symbols.push(...cases);
    }
  }

  private extractTypeAlias(
    node: TSNode,
    filePath: string,
    namespaceParts: string[],
    symbols: RawSymbol[],
    templateParams?: string,
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = [...namespaceParts, name];
    const meta: Record<string, unknown> = {};
    if (templateParams) meta.template = templateParams;

    symbols.push({
      symbolId: makeSymbolId(filePath, makeFqn(fqnParts), 'type'),
      name,
      kind: 'type',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractTypedef(
    node: TSNode,
    filePath: string,
    namespaceParts: string[],
    symbols: RawSymbol[],
  ): void {
    // typedef ... name;
    const info = extractDeclaratorName(node);
    if (!info) return;

    const fqnParts = [...namespaceParts, info.name];

    symbols.push({
      symbolId: makeSymbolId(filePath, makeFqn(fqnParts), 'type'),
      name: info.name,
      kind: 'type',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  private extractMacro(
    node: TSNode,
    filePath: string,
    namespaceParts: string[],
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = [...namespaceParts, name];
    const meta: Record<string, unknown> = { macro: true };

    if (node.type === 'preproc_function_def') {
      meta.functionLike = true;
    }

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'constant'),
      name,
      kind: 'constant',
      fqn: makeFqn(fqnParts),
      signature: node.text.split('\n')[0].trim(),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });
  }

  /**
   * Extract symbols from a declaration node (constexpr variables, forward declarations, etc.)
   */
  private extractDeclaration(
    node: TSNode,
    filePath: string,
    namespaceParts: string[],
    symbols: RawSymbol[],
    templateParams?: string,
  ): void {
    const text = node.text.trim();

    // constexpr variable
    if (/\bconstexpr\b/.test(text)) {
      const info = extractDeclaratorName(node);
      if (!info) return;

      // Skip if it looks like a function declaration (has parentheses in declarator)
      const declarator = node.childForFieldName('declarator');
      if (declarator && declarator.type === 'function_declarator') {
        // This is a constexpr function declaration, not a variable
        return;
      }

      const fqnParts = [...namespaceParts, info.name];
      const meta: Record<string, unknown> = { constexpr: true };
      if (templateParams) meta.template = templateParams;

      symbols.push({
        symbolId: makeSymbolId(filePath, makeFqn(fqnParts), 'constant'),
        name: info.name,
        kind: 'constant',
        fqn: makeFqn(fqnParts),
        signature: text.split('\n')[0].replace(/;\s*$/, ''),
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        metadata: meta,
      });
    }
  }
}
