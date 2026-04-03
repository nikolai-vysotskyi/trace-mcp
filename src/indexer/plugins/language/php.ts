/**
 * PHP Language Plugin — tree-sitter based symbol extraction.
 *
 * Extracts classes, methods, functions, interfaces, traits, enums,
 * constants, properties, and enum_cases from PHP source files.
 */
import { createRequire } from 'node:module';
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, SymbolKind } from '../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../errors.js';
import { parseError } from '../../../errors.js';
import {
  type TSNode,
  extractNamespace,
  makeSymbolId,
  makeFqn,
  extractSignature,
  extractAttributes,
  extractPromotedProperties,
  extractPropertySymbol,
  extractConstantSymbols,
} from './php-helpers.js';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const PhpGrammar = require('tree-sitter-php');

let parserInstance: InstanceType<typeof Parser> | null = null;

function getParser(): InstanceType<typeof Parser> {
  if (!parserInstance) {
    parserInstance = new Parser();
    parserInstance!.setLanguage(PhpGrammar.php);
  }
  return parserInstance!;
}

export class PhpLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'php-language',
    version: '1.0.0',
    priority: 0,
  };

  supportedExtensions = ['.php'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    try {
      const parser = getParser();
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

      this.walkTopLevel(root, filePath, namespace, symbols);

      return ok({
        language: 'php',
        status: hasError ? 'partial' : 'ok',
        symbols,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `PHP parse failed: ${msg}`));
    }
  }

  private walkTopLevel(root: TSNode, filePath: string, namespace: string | undefined, symbols: RawSymbol[]): void {
    for (const node of root.namedChildren) {
      switch (node.type) {
        case 'class_declaration':
          this.extractClass(node, filePath, namespace, symbols);
          break;
        case 'interface_declaration':
          this.extractClassLike(node, filePath, namespace, symbols, 'interface');
          break;
        case 'trait_declaration':
          this.extractClassLike(node, filePath, namespace, symbols, 'trait');
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
            this.walkTopLevel(body, filePath, innerNs, symbols);
          }
          break;
        }
      }
    }
  }

  private extractClass(
    node: TSNode, filePath: string, namespace: string | undefined, symbols: RawSymbol[],
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const className = nameNode.text;
    const symbolId = makeSymbolId(filePath, className, 'class');
    const attrs = extractAttributes(node);

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
      metadata: attrs.length > 0 ? { attributes: attrs } : undefined,
    });

    const body = node.childForFieldName('body');
    if (body) {
      this.extractClassMembers(body, filePath, className, namespace, symbolId, symbols);
    }
  }

  private extractClassLike(
    node: TSNode, filePath: string, namespace: string | undefined,
    symbols: RawSymbol[], kind: 'interface' | 'trait',
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const symbolId = makeSymbolId(filePath, name, kind);

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
      metadata: attrs.length > 0 ? { attributes: attrs } : undefined,
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
  }

  private extractConstant(
    node: TSNode, filePath: string, className: string,
    namespace: string | undefined, classSymbolId: string, symbols: RawSymbol[],
  ): void {
    symbols.push(...extractConstantSymbols(node, filePath, className, namespace, classSymbolId));
  }
}
