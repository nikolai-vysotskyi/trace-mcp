/**
 * Go Language Plugin — tree-sitter based symbol extraction.
 */
import { createRequire } from 'node:module';
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol } from '../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../errors.js';
import { parseError } from '../../../errors.js';
import {
  type TSNode,
  makeSymbolId,
  makeFqn,
  extractPackageName,
  extractSignature,
  extractImportEdges,
  extractStructFields,
  extractInterfaceMethods,
  getNodeName,
} from './go-helpers.js';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const GoGrammar = require('tree-sitter-go');

let parserInstance: InstanceType<typeof Parser> | null = null;

function getParser(): InstanceType<typeof Parser> {
  if (!parserInstance) {
    parserInstance = new Parser();
    parserInstance!.setLanguage(GoGrammar);
  }
  return parserInstance!;
}

export class GoLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'go-language',
    version: '1.0.0',
    priority: 5,
  };

  supportedExtensions = ['.go'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    try {
      const parser = getParser();
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const packageName = extractPackageName(root) ?? '';
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      for (const child of root.namedChildren) {
        switch (child.type) {
          case 'function_declaration':
            this.extractFunction(child, filePath, packageName, symbols);
            break;
          case 'method_declaration':
            this.extractMethod(child, filePath, packageName, symbols);
            break;
          case 'type_declaration':
            this.extractTypeDecl(child, filePath, packageName, symbols);
            break;
          case 'const_declaration':
            this.extractConsts(child, filePath, packageName, symbols);
            break;
          case 'var_declaration':
            this.extractVars(child, filePath, packageName, symbols);
            break;
        }
      }

      const edges = extractImportEdges(root);

      return ok({
        language: 'go',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Go parse failed: ${msg}`));
    }
  }

  private extractFunction(node: TSNode, filePath: string, pkg: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    if (name[0] === name[0].toUpperCase()) meta.exported = 1;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn: makeFqn([pkg, name]),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractMethod(node: TSNode, filePath: string, pkg: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const receiver = node.childForFieldName('receiver');
    let receiverType = '';
    if (receiver) {
      // parameter_list → parameter_declaration → type
      for (const param of receiver.namedChildren) {
        if (param.type === 'parameter_declaration') {
          const typeNode = param.childForFieldName('type');
          if (typeNode) receiverType = typeNode.text.replace(/^\*/, '');
        }
      }
    }

    const parentSymbolId = receiverType ? makeSymbolId(filePath, receiverType, 'class') : undefined;
    const meta: Record<string, unknown> = {};
    if (name[0] === name[0].toUpperCase()) meta.exported = 1;
    if (receiver) meta.receiver = receiver.text.replace(/^\(|\)$/g, '');

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'method', receiverType || undefined),
      name,
      kind: 'method',
      fqn: receiverType ? makeFqn([pkg, receiverType, name]) : makeFqn([pkg, name]),
      parentSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractTypeDecl(node: TSNode, filePath: string, pkg: string, symbols: RawSymbol[]): void {
    for (const spec of node.namedChildren) {
      if (spec.type === 'type_spec') {
        const name = getNodeName(spec);
        if (!name) continue;

        const typeNode = spec.childForFieldName('type');
        if (!typeNode) continue;

        const meta: Record<string, unknown> = {};
        if (name[0] === name[0].toUpperCase()) meta.exported = 1;

        if (typeNode.type === 'struct_type') {
          const symbolId = makeSymbolId(filePath, name, 'class');
          const body = typeNode.childForFieldName('body') ?? typeNode.namedChildren.find((c) => c.type === 'field_declaration_list');

          let fieldSymbols: RawSymbol[] = [];
          if (body) {
            const result = extractStructFields(body, filePath, name, symbolId);
            fieldSymbols = result.symbols;
            if (result.embeds.length > 0) meta.embeds = result.embeds;
          }

          symbols.push({
            symbolId,
            name,
            kind: 'class',
            fqn: makeFqn([pkg, name]),
            signature: `type ${name} struct`,
            byteStart: spec.startIndex,
            byteEnd: spec.endIndex,
            lineStart: spec.startPosition.row + 1,
            lineEnd: spec.endPosition.row + 1,
            metadata: Object.keys(meta).length > 0 ? meta : undefined,
          });
          symbols.push(...fieldSymbols);
        } else if (typeNode.type === 'interface_type') {
          const symbolId = makeSymbolId(filePath, name, 'interface');
          const body = typeNode.namedChildren.find((c) => c.type === 'method_spec' || c.type === 'method_elem')
            ? typeNode
            : typeNode.namedChildren[0]?.type === 'method_spec' ? typeNode : null;

          // Interface methods live directly inside interface_type
          let methodSymbols: RawSymbol[] = [];
          if (typeNode) {
            methodSymbols = extractInterfaceMethods(typeNode, filePath, name, symbolId);
          }

          symbols.push({
            symbolId,
            name,
            kind: 'interface',
            fqn: makeFqn([pkg, name]),
            signature: `type ${name} interface`,
            byteStart: spec.startIndex,
            byteEnd: spec.endIndex,
            lineStart: spec.startPosition.row + 1,
            lineEnd: spec.endPosition.row + 1,
            metadata: Object.keys(meta).length > 0 ? meta : undefined,
          });
          symbols.push(...methodSymbols);
        } else {
          // Type alias or other type definition
          symbols.push({
            symbolId: makeSymbolId(filePath, name, 'type'),
            name,
            kind: 'type',
            fqn: makeFqn([pkg, name]),
            signature: `type ${name} ${typeNode.text.split('\n')[0]}`,
            byteStart: spec.startIndex,
            byteEnd: spec.endIndex,
            lineStart: spec.startPosition.row + 1,
            lineEnd: spec.endPosition.row + 1,
            metadata: Object.keys(meta).length > 0 ? meta : undefined,
          });
        }
      }
    }
  }

  private extractConsts(node: TSNode, filePath: string, pkg: string, symbols: RawSymbol[]): void {
    for (const child of node.namedChildren) {
      if (child.type === 'const_spec') {
        const name = getNodeName(child);
        if (!name) continue;

        const meta: Record<string, unknown> = {};
        if (name[0] === name[0].toUpperCase()) meta.exported = 1;

        symbols.push({
          symbolId: makeSymbolId(filePath, name, 'constant'),
          name,
          kind: 'constant',
          fqn: makeFqn([pkg, name]),
          signature: child.text.split('\n')[0].trim(),
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
          lineStart: child.startPosition.row + 1,
          lineEnd: child.endPosition.row + 1,
          metadata: Object.keys(meta).length > 0 ? meta : undefined,
        });
      }
    }
  }

  private extractVars(node: TSNode, filePath: string, pkg: string, symbols: RawSymbol[]): void {
    for (const child of node.namedChildren) {
      if (child.type === 'var_spec') {
        const name = getNodeName(child);
        if (!name) continue;

        const meta: Record<string, unknown> = {};
        if (name[0] === name[0].toUpperCase()) meta.exported = 1;

        symbols.push({
          symbolId: makeSymbolId(filePath, name, 'variable'),
          name,
          kind: 'variable',
          fqn: makeFqn([pkg, name]),
          signature: child.text.split('\n')[0].trim(),
          byteStart: child.startIndex,
          byteEnd: child.endIndex,
          lineStart: child.startPosition.row + 1,
          lineEnd: child.endPosition.row + 1,
          metadata: Object.keys(meta).length > 0 ? meta : undefined,
        });
      }
    }
  }
}
