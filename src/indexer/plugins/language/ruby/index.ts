/**
 * Ruby Language Plugin — tree-sitter based symbol extraction.
 */
import { createRequire } from 'node:module';
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { detectMinRubyVersionFromSource } from './version-features.js';
import {
  type TSNode,
  makeSymbolId,
  makeFqn,
  extractSignature,
  extractSuperclass,
  extractMethods,
  extractAttributes,
  extractMixins,
  extractImportEdges,
  extractConstants,
  getNodeName,
} from './helpers.js';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const RubyGrammar = require('tree-sitter-ruby');

let parserInstance: InstanceType<typeof Parser> | null = null;

function getParser(): InstanceType<typeof Parser> {
  if (!parserInstance) {
    parserInstance = new Parser();
    parserInstance!.setLanguage(RubyGrammar);
  }
  return parserInstance!;
}

export class RubyLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'ruby-language',
    version: '1.0.0',
    priority: 5,
  };

  supportedExtensions = ['.rb', '.rake'];
  supportedVersions = ['2.0', '2.3', '2.5', '2.6', '2.7', '3.0', '3.1', '3.2', '3.3'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    try {
      const parser = getParser();
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walkNode(root, filePath, [], symbols);

      const edges = extractImportEdges(root);

      const minRubyVer = detectMinRubyVersionFromSource(sourceCode);
      const metadata: Record<string, unknown> = {};
      if (minRubyVer) metadata.minRubyVersion = minRubyVer;

      return ok({
        language: 'ruby',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Ruby parse failed: ${msg}`));
    }
  }

  private walkNode(node: TSNode, filePath: string, namespaceParts: string[], symbols: RawSymbol[]): void {
    for (const child of node.namedChildren) {
      switch (child.type) {
        case 'class':
          this.extractClass(child, filePath, namespaceParts, symbols);
          break;
        case 'module':
          this.extractModule(child, filePath, namespaceParts, symbols);
          break;
        case 'method':
          this.extractTopLevelMethod(child, filePath, namespaceParts, symbols);
          break;
        case 'assignment':
          this.extractTopLevelConstant(child, filePath, namespaceParts, symbols);
          break;
      }
    }
  }

  private extractClass(node: TSNode, filePath: string, namespaceParts: string[], symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const parts = [...namespaceParts, name];
    const symbolId = makeSymbolId(filePath, name, 'class', namespaceParts.length > 0 ? namespaceParts.join('::') : undefined);
    const superclass = extractSuperclass(node);
    const meta: Record<string, unknown> = {};

    if (superclass) meta.extends = superclass;

    const body = node.childForFieldName('body') ?? node;

    const mixins = extractMixins(body);
    if (mixins.include) meta.includes = mixins.include;
    if (mixins.extend) meta.extends_modules = mixins.extend;
    if (mixins.prepend) meta.prepends = mixins.prepend;

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      fqn: makeFqn(parts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    symbols.push(...extractMethods(body, filePath, name, symbolId, parts));
    symbols.push(...extractAttributes(body, filePath, name, symbolId, parts));
    symbols.push(...extractConstants(body, filePath, name, symbolId, parts));

    // Nested classes/modules
    this.walkNode(body, filePath, parts, symbols);
  }

  private extractModule(node: TSNode, filePath: string, namespaceParts: string[], symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const parts = [...namespaceParts, name];
    const symbolId = makeSymbolId(filePath, name, 'namespace', namespaceParts.length > 0 ? namespaceParts.join('::') : undefined);

    const body = node.childForFieldName('body') ?? node;

    const mixins = extractMixins(body);
    const meta: Record<string, unknown> = {};
    if (mixins.include) meta.includes = mixins.include;
    if (mixins.extend) meta.extends_modules = mixins.extend;

    symbols.push({
      symbolId,
      name,
      kind: 'namespace',
      fqn: makeFqn(parts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    symbols.push(...extractMethods(body, filePath, name, symbolId, parts));
    symbols.push(...extractAttributes(body, filePath, name, symbolId, parts));
    symbols.push(...extractConstants(body, filePath, name, symbolId, parts));

    // Nested classes/modules
    this.walkNode(body, filePath, parts, symbols);
  }

  private extractTopLevelMethod(node: TSNode, filePath: string, namespaceParts: string[], symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn: namespaceParts.length > 0 ? makeFqn(namespaceParts, name) : name,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  private extractTopLevelConstant(node: TSNode, filePath: string, namespaceParts: string[], symbols: RawSymbol[]): void {
    const left = node.childForFieldName('left');
    if (!left || left.type !== 'constant') return;
    const name = left.text;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'constant'),
      name,
      kind: 'constant',
      fqn: namespaceParts.length > 0 ? makeFqn([...namespaceParts, name]) : name,
      signature: node.text.split('\n')[0].trim().slice(0, 120),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }
}
