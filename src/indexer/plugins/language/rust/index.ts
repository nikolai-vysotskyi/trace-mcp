/**
 * Rust Language Plugin — tree-sitter based symbol extraction.
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
  getNodeName,
  isPublic,
  extractImportEdges,
  extractStructFields,
  extractImplMethods,
  extractEnumVariants,
  extractTraitMethods,
} from './helpers.js';

export class RustLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'rust-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.rs'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('rust');
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
        language: 'rust',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Rust parse failed: ${msg}`));
    }
  }

  private walkTopLevel(root: TSNode, filePath: string, symbols: RawSymbol[]): void {
    for (const child of root.namedChildren) {
      switch (child.type) {
        case 'function_item':
          this.extractFunction(child, filePath, symbols);
          break;
        case 'struct_item':
          this.extractStruct(child, filePath, symbols);
          break;
        case 'enum_item':
          this.extractEnum(child, filePath, symbols);
          break;
        case 'trait_item':
          this.extractTrait(child, filePath, symbols);
          break;
        case 'impl_item':
          this.extractImpl(child, filePath, symbols);
          break;
        case 'type_item':
          this.extractTypeAlias(child, filePath, symbols);
          break;
        case 'const_item':
          this.extractConst(child, filePath, symbols);
          break;
        case 'static_item':
          this.extractStatic(child, filePath, symbols);
          break;
        case 'mod_item':
          this.extractMod(child, filePath, symbols);
          break;
        case 'macro_definition':
          this.extractMacro(child, filePath, symbols);
          break;
      }
    }
  }

  private extractFunction(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    if (isPublic(node)) meta.exported = 1;
    // Check for async/unsafe/const qualifiers
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.type === 'async') meta.async = true;
      if (c?.type === 'unsafe') meta.unsafe = true;
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
    const meta: Record<string, unknown> = { rustKind: 'struct' };
    if (isPublic(node)) meta.exported = 1;

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

    // Extract fields from field_declaration_list
    const body = node.childForFieldName('body');
    if (body && body.type === 'field_declaration_list') {
      symbols.push(...extractStructFields(body, filePath, name, symbolId));
    }
  }

  private extractEnum(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'enum');
    const meta: Record<string, unknown> = {};
    if (isPublic(node)) meta.exported = 1;

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
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Extract variants
    const body = node.childForFieldName('body');
    if (body && body.type === 'enum_variant_list') {
      symbols.push(...extractEnumVariants(body, filePath, name, symbolId));
    }
  }

  private extractTrait(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'trait');
    const meta: Record<string, unknown> = {};
    if (isPublic(node)) meta.exported = 1;
    // Check for unsafe trait
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.type === 'unsafe') meta.unsafe = true;
    }

    symbols.push({
      symbolId,
      name,
      kind: 'trait',
      fqn: name,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Extract trait methods
    const body = node.childForFieldName('body');
    if (body && body.type === 'declaration_list') {
      symbols.push(...extractTraitMethods(body, filePath, name, symbolId));
    }
  }

  private extractImpl(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const typeNode = node.childForFieldName('type');
    if (!typeNode) return;

    const typeName = typeNode.text.replace(/<.*>$/, ''); // Strip generics
    const typeSymbolId = makeSymbolId(filePath, typeName, 'class');

    // Check if this is a trait impl: impl Trait for Type
    const traitNode = node.childForFieldName('trait');
    if (traitNode) {
      // Create an edge for trait implementation
      const meta: Record<string, unknown> = {
        rustKind: 'impl',
        trait: traitNode.text,
      };

      // Still extract methods under the type
      const body = node.childForFieldName('body');
      if (body && body.type === 'declaration_list') {
        const methods = extractImplMethods(body, filePath, typeName, typeSymbolId);
        for (const m of methods) {
          if (!m.metadata) m.metadata = {};
          m.metadata.implTrait = traitNode.text;
        }
        symbols.push(...methods);
      }
    } else {
      // Inherent impl
      const body = node.childForFieldName('body');
      if (body && body.type === 'declaration_list') {
        symbols.push(...extractImplMethods(body, filePath, typeName, typeSymbolId));
      }
    }
  }

  private extractTypeAlias(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    if (isPublic(node)) meta.exported = 1;

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
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractConst(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    if (isPublic(node)) meta.exported = 1;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'constant'),
      name,
      kind: 'constant',
      fqn: name,
      signature: node.text.split('\n')[0].trim(),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractStatic(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    if (isPublic(node)) meta.exported = 1;
    // Check for `mut`
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.type === 'mutable_specifier') meta.mutable = true;
    }

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'variable'),
      name,
      kind: 'variable',
      fqn: name,
      signature: node.text.split('\n')[0].trim(),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractMod(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    if (isPublic(node)) meta.exported = 1;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'namespace'),
      name,
      kind: 'namespace',
      fqn: name,
      signature: `mod ${name}`,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Recurse into inline module body
    const body = node.childForFieldName('body');
    if (body && body.type === 'declaration_list') {
      this.walkTopLevel(body, filePath, symbols);
    }
  }

  private extractMacro(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn: name,
      signature: `macro_rules! ${name}`,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { rustKind: 'macro' },
    });
  }
}
