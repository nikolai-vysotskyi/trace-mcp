/**
 * C Language Plugin — tree-sitter based symbol extraction.
 *
 * Extracts: functions, structs, enums, unions, typedefs, macros, global variables.
 * Imports: #include directives.
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
  extractSignature,
  getNodeName,
  extractQualifiers,
  findDeclaratorName,
  containsFunctionDeclarator,
  extractImportEdges,
  extractStructFields,
  extractEnumConstants,
} from './helpers.js';

export class CLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'c-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.c', '.h'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('c');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walkTopLevel(root, filePath, symbols);

      const edges = extractImportEdges(root);

      return ok({
        language: 'c',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `C parse failed: ${msg}`));
    }
  }

  private walkTopLevel(root: TSNode, filePath: string, symbols: RawSymbol[]): void {
    for (const child of root.namedChildren) {
      switch (child.type) {
        case 'function_definition':
          this.extractFunction(child, filePath, symbols);
          break;
        case 'struct_specifier':
          this.extractStruct(child, filePath, symbols);
          break;
        case 'enum_specifier':
          this.extractEnum(child, filePath, symbols);
          break;
        case 'union_specifier':
          this.extractUnion(child, filePath, symbols);
          break;
        case 'type_definition':
          this.extractTypedef(child, filePath, symbols);
          break;
        case 'declaration':
          this.extractDeclaration(child, filePath, symbols);
          break;
        case 'preproc_def':
          this.extractMacro(child, filePath, symbols);
          break;
        case 'preproc_function_def':
          this.extractFunctionMacro(child, filePath, symbols);
          break;
      }
    }
  }

  private extractFunction(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const declarator = node.childForFieldName('declarator');
    if (!declarator) return;
    const name = findDeclaratorName(declarator);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    const qualifiers = extractQualifiers(node);
    if (qualifiers.length > 0) {
      for (const q of qualifiers) {
        if (q === 'static') meta.static = true;
        if (q === 'inline') meta.inline = true;
        if (q === 'extern') meta.extern = true;
      }
    }

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn: name,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractStruct(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'class');
    const meta: Record<string, unknown> = { cKind: 'struct' };

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      fqn: name,
      signature: `struct ${name}`,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });

    // Extract fields from body (field_declaration_list)
    const body = node.childForFieldName('body');
    if (body && body.type === 'field_declaration_list') {
      symbols.push(...extractStructFields(body, filePath, name, symbolId));
    }
  }

  private extractEnum(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'enum');

    symbols.push({
      symbolId,
      name,
      kind: 'enum',
      fqn: name,
      signature: `enum ${name}`,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });

    // Extract enumerator constants
    const body = node.childForFieldName('body');
    if (body && body.type === 'enumerator_list') {
      symbols.push(...extractEnumConstants(body, filePath, name, symbolId));
    }
  }

  private extractUnion(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'class');
    const meta: Record<string, unknown> = { cKind: 'union' };

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      fqn: name,
      signature: `union ${name}`,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });

    // Extract fields from body
    const body = node.childForFieldName('body');
    if (body && body.type === 'field_declaration_list') {
      symbols.push(...extractStructFields(body, filePath, name, symbolId));
    }
  }

  private extractTypedef(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    // In a type_definition, the declarator field holds the new type name.
    // But the inner type might be a struct/enum/union — extract those first.
    for (const child of node.namedChildren) {
      if (child.type === 'struct_specifier') {
        this.extractStruct(child, filePath, symbols);
      } else if (child.type === 'enum_specifier') {
        this.extractEnum(child, filePath, symbols);
      } else if (child.type === 'union_specifier') {
        this.extractUnion(child, filePath, symbols);
      }
    }

    // Extract the typedef alias itself
    const declarator = node.childForFieldName('declarator');
    if (!declarator) return;
    const name = findDeclaratorName(declarator);
    if (!name) return;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'type'),
      name,
      kind: 'type',
      fqn: name,
      signature: node.text.split('\n')[0].trim(),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  /**
   * Handle top-level `declaration` nodes. These can be:
   * - Function declarations (prototypes): `int foo(int x);`
   * - Global variable declarations: `int counter;` or `static int counter = 0;`
   */
  private extractDeclaration(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const declarator = node.childForFieldName('declarator');
    if (!declarator) return;

    const qualifiers = extractQualifiers(node);

    if (containsFunctionDeclarator(declarator)) {
      // Function declaration / prototype
      const name = findDeclaratorName(declarator);
      if (!name) return;

      const meta: Record<string, unknown> = { declaration: true };
      for (const q of qualifiers) {
        if (q === 'extern') meta.extern = true;
        if (q === 'static') meta.static = true;
      }

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'function'),
        name,
        kind: 'function',
        fqn: name,
        signature: node.text.trim().replace(/;$/, '').trim(),
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        metadata: meta,
      });
    } else {
      // Global variable declaration
      const name = findDeclaratorName(declarator);
      if (!name) return;

      const meta: Record<string, unknown> = {};
      for (const q of qualifiers) {
        if (q === 'static') meta.static = true;
        if (q === 'extern') meta.extern = true;
        if (q === 'const') meta.const = true;
        if (q === 'volatile') meta.volatile = true;
      }

      const typeNode = node.childForFieldName('type');
      if (typeNode) meta.type = typeNode.text;

      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'variable'),
        name,
        kind: 'variable',
        fqn: name,
        signature: node.text.trim().replace(/;$/, '').trim(),
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      });
    }
  }

  private extractMacro(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const valueNode = node.childForFieldName('value');
    const meta: Record<string, unknown> = { cKind: 'macro' };
    if (valueNode) meta.value = valueNode.text.trim();

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'constant'),
      name,
      kind: 'constant',
      fqn: name,
      signature: `#define ${name}${valueNode ? ' ' + valueNode.text.trim() : ''}`,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });
  }

  private extractFunctionMacro(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const params = node.childForFieldName('parameters');
    const meta: Record<string, unknown> = { cKind: 'function_macro' };
    if (params) meta.parameters = params.text;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'constant'),
      name,
      kind: 'constant',
      fqn: name,
      signature: `#define ${name}${params ? params.text : '()'}`,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });
  }
}
