/**
 * C# Language Plugin — tree-sitter based symbol extraction.
 *
 * Extracts namespaces, classes, interfaces, structs, enums, records,
 * delegates, methods, properties, fields, events, constructors,
 * and using directive edges from C# source files.
 */
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser } from '../../../../parser/tree-sitter.js';
import {
  type TSNode,
  makeSymbolId,
  makeFqn,
  extractSignature,
  extractModifiers,
  extractAttributes,
  extractBaseTypes,
  extractImportEdges,
  extractClassMethods,
  extractClassProperties,
  extractClassFields,
  extractClassEvents,
  extractEnumMembers,
  extractNamespaceName,
  getNodeName,
} from './helpers.js';

export class CSharpLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'csharp-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.cs'];
  supportedVersions = [
    '7.0', '7.1', '7.2', '7.3',
    '8.0', '9.0', '10.0', '11.0', '12.0', '13.0',
  ];

  async extractSymbols(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('csharp');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walkChildren(root, filePath, undefined, symbols);

      const edges = extractImportEdges(root);

      return ok({
        language: 'csharp',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `C# parse failed: ${msg}`));
    }
  }

  /** Walk children of a node, dispatching to extraction methods by node type. */
  private walkChildren(
    parent: TSNode,
    filePath: string,
    namespaceName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    for (const node of parent.namedChildren) {
      switch (node.type) {
        case 'namespace_declaration':
        case 'file_scoped_namespace_declaration':
          this.extractNamespace(node, filePath, namespaceName, symbols);
          break;
        case 'class_declaration':
          this.extractClass(node, filePath, namespaceName, symbols);
          break;
        case 'interface_declaration':
          this.extractInterface(node, filePath, namespaceName, symbols);
          break;
        case 'struct_declaration':
          this.extractStruct(node, filePath, namespaceName, symbols);
          break;
        case 'enum_declaration':
          this.extractEnum(node, filePath, namespaceName, symbols);
          break;
        case 'record_declaration':
          this.extractRecord(node, filePath, namespaceName, symbols);
          break;
        case 'delegate_declaration':
          this.extractDelegate(node, filePath, namespaceName, symbols);
          break;
      }
    }
  }

  private extractNamespace(
    node: TSNode,
    filePath: string,
    parentNamespace: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const name = extractNamespaceName(node);
    if (!name) return;

    const fqnParts = parentNamespace ? [parentNamespace, name] : [name];
    const fullNamespace = makeFqn(fqnParts);

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'namespace'),
      name,
      kind: 'namespace',
      fqn: fullNamespace,
      signature: `namespace ${fullNamespace}`,
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });

    // Recurse into namespace body (declaration_list) or file-scoped namespace children
    const body = findBody(node);
    if (body) {
      this.walkChildren(body, filePath, fullNamespace, symbols);
    } else {
      // File-scoped namespace — declarations are siblings
      this.walkChildren(node, filePath, fullNamespace, symbols);
    }
  }

  private extractClass(
    node: TSNode,
    filePath: string,
    namespaceName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = namespaceName ? [namespaceName, name] : [name];
    const symbolId = makeSymbolId(filePath, name, 'class');
    const modifiers = extractModifiers(node);
    const attrs = extractAttributes(node);
    const baseTypes = extractBaseTypes(node);
    const meta: Record<string, unknown> = {};

    if (attrs.length > 0) meta.attributes = attrs;
    if (baseTypes.length > 0) meta.baseTypes = baseTypes;
    if (modifiers.includes('abstract')) meta.abstract = true;
    if (modifiers.includes('sealed')) meta.sealed = true;
    if (modifiers.includes('static')) meta.static = true;
    if (modifiers.includes('partial')) meta.partial = true;

    const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
    if (visibility) meta.visibility = visibility;

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    const body = findBody(node);
    if (body) {
      this.extractMembers(body, filePath, name, symbolId, symbols, namespaceName);
    }
  }

  private extractInterface(
    node: TSNode,
    filePath: string,
    namespaceName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = namespaceName ? [namespaceName, name] : [name];
    const symbolId = makeSymbolId(filePath, name, 'interface');
    const attrs = extractAttributes(node);
    const baseTypes = extractBaseTypes(node);
    const modifiers = extractModifiers(node);
    const meta: Record<string, unknown> = {};

    if (attrs.length > 0) meta.attributes = attrs;
    if (baseTypes.length > 0) meta.baseTypes = baseTypes;
    if (modifiers.includes('partial')) meta.partial = true;

    const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
    if (visibility) meta.visibility = visibility;

    symbols.push({
      symbolId,
      name,
      kind: 'interface',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    const body = findBody(node);
    if (body) {
      symbols.push(...extractClassMethods(body, filePath, name, symbolId));
      symbols.push(...extractClassProperties(body, filePath, name, symbolId));
      symbols.push(...extractClassEvents(body, filePath, name, symbolId));
    }
  }

  private extractStruct(
    node: TSNode,
    filePath: string,
    namespaceName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = namespaceName ? [namespaceName, name] : [name];
    const symbolId = makeSymbolId(filePath, name, 'class');
    const modifiers = extractModifiers(node);
    const attrs = extractAttributes(node);
    const baseTypes = extractBaseTypes(node);
    const meta: Record<string, unknown> = { csharpKind: 'struct' };

    if (attrs.length > 0) meta.attributes = attrs;
    if (baseTypes.length > 0) meta.baseTypes = baseTypes;
    if (modifiers.includes('readonly')) meta.readonly = true;
    if (modifiers.includes('ref')) meta.ref = true;
    if (modifiers.includes('partial')) meta.partial = true;

    const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
    if (visibility) meta.visibility = visibility;

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });

    const body = findBody(node);
    if (body) {
      this.extractMembers(body, filePath, name, symbolId, symbols, namespaceName);
    }
  }

  private extractEnum(
    node: TSNode,
    filePath: string,
    namespaceName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = namespaceName ? [namespaceName, name] : [name];
    const symbolId = makeSymbolId(filePath, name, 'enum');
    const attrs = extractAttributes(node);
    const modifiers = extractModifiers(node);
    const meta: Record<string, unknown> = {};

    if (attrs.length > 0) meta.attributes = attrs;
    const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
    if (visibility) meta.visibility = visibility;

    symbols.push({
      symbolId,
      name,
      kind: 'enum',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    const body = findBody(node);
    if (body) {
      symbols.push(...extractEnumMembers(body, filePath, name, symbolId));
    }
  }

  private extractRecord(
    node: TSNode,
    filePath: string,
    namespaceName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = namespaceName ? [namespaceName, name] : [name];
    const symbolId = makeSymbolId(filePath, name, 'class');
    const modifiers = extractModifiers(node);
    const attrs = extractAttributes(node);
    const baseTypes = extractBaseTypes(node);
    const meta: Record<string, unknown> = { csharpKind: 'record' };

    if (attrs.length > 0) meta.attributes = attrs;
    if (baseTypes.length > 0) meta.baseTypes = baseTypes;
    if (modifiers.includes('abstract')) meta.abstract = true;
    if (modifiers.includes('sealed')) meta.sealed = true;
    if (modifiers.includes('partial')) meta.partial = true;

    const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
    if (visibility) meta.visibility = visibility;

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });

    const body = findBody(node);
    if (body) {
      this.extractMembers(body, filePath, name, symbolId, symbols, namespaceName);
    }
  }

  private extractDelegate(
    node: TSNode,
    filePath: string,
    namespaceName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = namespaceName ? [namespaceName, name] : [name];
    const modifiers = extractModifiers(node);
    const attrs = extractAttributes(node);
    const meta: Record<string, unknown> = { csharpKind: 'delegate' };

    if (attrs.length > 0) meta.attributes = attrs;
    const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
    if (visibility) meta.visibility = visibility;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'type'),
      name,
      kind: 'type',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });
  }

  /** Extract all members (methods, properties, fields, events) and nested types from a body. */
  private extractMembers(
    body: TSNode,
    filePath: string,
    className: string,
    classSymbolId: string,
    symbols: RawSymbol[],
    namespaceName: string | undefined,
  ): void {
    symbols.push(...extractClassMethods(body, filePath, className, classSymbolId));
    symbols.push(...extractClassProperties(body, filePath, className, classSymbolId));
    symbols.push(...extractClassFields(body, filePath, className, classSymbolId));
    symbols.push(...extractClassEvents(body, filePath, className, classSymbolId));

    // Recurse into nested types
    this.walkChildren(body, filePath, namespaceName, symbols);
  }
}

/** Find the body/declaration_list child of a type or namespace node. */
function findBody(node: TSNode): TSNode | undefined {
  const body = node.childForFieldName('body');
  if (body) return body;
  for (const child of node.namedChildren) {
    if (child.type === 'declaration_list') return child;
  }
  return undefined;
}
