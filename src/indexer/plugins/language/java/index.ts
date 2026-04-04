/**
 * Java Language Plugin — tree-sitter based symbol extraction.
 */
import { createRequire } from 'node:module';
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import {
  type TSNode,
  makeSymbolId,
  makeFqn,
  extractPackageName,
  extractSignature,
  extractAnnotations,
  extractSuperTypes,
  extractInterfaceExtends,
  extractImportEdges,
  extractClassMethods,
  extractClassFields,
  extractEnumConstants,
  getNodeName,
} from './helpers.js';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const JavaGrammar = require('tree-sitter-java');

let parserInstance: InstanceType<typeof Parser> | null = null;

function getParser(): InstanceType<typeof Parser> {
  if (!parserInstance) {
    parserInstance = new Parser();
    parserInstance!.setLanguage(JavaGrammar);
  }
  return parserInstance!;
}

export class JavaLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'java-language',
    version: '1.0.0',
    priority: 5,
  };

  supportedExtensions = ['.java'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    try {
      const parser = getParser();
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const packageName = extractPackageName(root);
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walkTopLevel(root, filePath, packageName, symbols);

      const edges = extractImportEdges(root);

      return ok({
        language: 'java',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Java parse failed: ${msg}`));
    }
  }

  private walkTopLevel(root: TSNode, filePath: string, packageName: string | undefined, symbols: RawSymbol[]): void {
    for (const child of root.namedChildren) {
      switch (child.type) {
        case 'class_declaration':
          this.extractClass(child, filePath, packageName, symbols);
          break;
        case 'interface_declaration':
          this.extractInterface(child, filePath, packageName, symbols);
          break;
        case 'enum_declaration':
          this.extractEnum(child, filePath, packageName, symbols);
          break;
        case 'annotation_type_declaration':
          this.extractAnnotationType(child, filePath, packageName, symbols);
          break;
      }
    }
  }

  private extractClass(node: TSNode, filePath: string, packageName: string | undefined, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = packageName ? [packageName, name] : [name];
    const symbolId = makeSymbolId(filePath, name, 'class');
    const annotations = extractAnnotations(node);
    const superTypes = extractSuperTypes(node);
    const meta: Record<string, unknown> = {};

    if (annotations.length > 0) meta.annotations = annotations;
    if (superTypes.extends_) meta.extends = superTypes.extends_;
    if (superTypes.implements_) meta.implements = superTypes.implements_;

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

    const body = node.childForFieldName('body');
    if (body) {
      symbols.push(...extractClassMethods(body, filePath, name, symbolId));
      symbols.push(...extractClassFields(body, filePath, name, symbolId));
      // Nested classes
      for (const inner of body.namedChildren) {
        if (inner.type === 'class_declaration') {
          this.extractClass(inner, filePath, packageName, symbols);
        } else if (inner.type === 'interface_declaration') {
          this.extractInterface(inner, filePath, packageName, symbols);
        } else if (inner.type === 'enum_declaration') {
          this.extractEnum(inner, filePath, packageName, symbols);
        }
      }
    }
  }

  private extractInterface(node: TSNode, filePath: string, packageName: string | undefined, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = packageName ? [packageName, name] : [name];
    const symbolId = makeSymbolId(filePath, name, 'interface');
    const annotations = extractAnnotations(node);
    const extendsIfaces = extractInterfaceExtends(node);
    const meta: Record<string, unknown> = {};

    if (annotations.length > 0) meta.annotations = annotations;
    if (extendsIfaces.length > 0) meta.extends = extendsIfaces;

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

    const body = node.childForFieldName('body');
    if (body) {
      symbols.push(...extractClassMethods(body, filePath, name, symbolId));
    }
  }

  private extractEnum(node: TSNode, filePath: string, packageName: string | undefined, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = packageName ? [packageName, name] : [name];
    const symbolId = makeSymbolId(filePath, name, 'enum');

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
    });

    const body = node.childForFieldName('body');
    if (body) {
      symbols.push(...extractEnumConstants(body, filePath, name, symbolId));
      symbols.push(...extractClassMethods(body, filePath, name, symbolId));
    }
  }

  private extractAnnotationType(node: TSNode, filePath: string, packageName: string | undefined, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = packageName ? [packageName, name] : [name];

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'decorator'),
      name,
      kind: 'decorator',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }
}
