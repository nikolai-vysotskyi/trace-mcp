/**
 * Elm Language Plugin — tree-sitter-based symbol extraction.
 *
 * Extracts: functions, type aliases, custom types, ports, modules, and import edges.
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
} from '../../../../plugin-api/types.js';

function makeSymbolId(filePath: string, name: string, kind: string): string {
  return `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode): string {
  return node.text.split('\n')[0].trim();
}

/**
 * Find the first named child of a given type, or undefined.
 */
function findChild(node: TSNode, type: string): TSNode | undefined {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return undefined;
}

/**
 * Extract the module name from a module_declaration or import_clause.
 * Looks for upper_case_qid child node (dot-separated module path).
 */
function extractModulePath(node: TSNode): string | undefined {
  const qid = findChild(node, 'upper_case_qid');
  return qid?.text;
}

export class ElmLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'elm-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.elm'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('elm');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const warnings: string[] = [];
      const seenNames = new Set<string>();

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      // Extract module name for FQN construction
      let moduleName: string | undefined;

      for (const child of root.namedChildren) {
        switch (child.type) {
          case 'module_declaration':
            moduleName = this.extractModule(child, filePath, symbols);
            break;
          case 'import_clause':
            this.extractImport(child, filePath, edges);
            break;
          case 'type_alias_declaration':
            this.extractTypeAlias(child, filePath, moduleName, symbols);
            break;
          case 'type_declaration':
            this.extractCustomType(child, filePath, moduleName, symbols);
            break;
          case 'port_annotation':
            this.extractPort(child, filePath, moduleName, symbols, seenNames);
            break;
          case 'type_annotation':
            this.extractTypeAnnotation(child, filePath, moduleName, symbols, seenNames);
            break;
          case 'value_declaration':
            this.extractValueDeclaration(child, filePath, moduleName, symbols, seenNames);
            break;
        }
      }

      return ok({
        language: 'elm',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Elm parse failed: ${msg}`));
    }
  }

  /**
   * module Name exposing (..)
   * Returns the module name for FQN construction.
   */
  private extractModule(node: TSNode, filePath: string, symbols: RawSymbol[]): string | undefined {
    const name = extractModulePath(node);
    if (!name) return undefined;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'namespace'),
      name,
      kind: 'namespace',
      fqn: name,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });

    return name;
  }

  /**
   * import Module.Name [as Alias] [exposing (..)]
   */
  private extractImport(node: TSNode, filePath: string, edges: RawEdge[]): void {
    const modulePath = extractModulePath(node);
    if (!modulePath) return;

    edges.push({
      sourceSymbolId: filePath,
      sourceNodeType: 'file',
      targetSymbolId: modulePath,
      targetNodeType: 'module',
      edgeType: 'import',
      resolved: false,
    });
  }

  /**
   * type alias Name = ...
   */
  private extractTypeAlias(
    node: TSNode,
    filePath: string,
    moduleName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const nameNode = findChild(node, 'upper_case_identifier');
    if (!nameNode) return;
    const name = nameNode.text;

    const fqn = moduleName ? `${moduleName}.${name}` : name;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'type'),
      name,
      kind: 'type',
      fqn,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { typeAlias: true },
    });
  }

  /**
   * type Name = Constructor1 | Constructor2
   */
  private extractCustomType(
    node: TSNode,
    filePath: string,
    moduleName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const nameNode = findChild(node, 'upper_case_identifier');
    if (!nameNode) return;
    const name = nameNode.text;

    const fqn = moduleName ? `${moduleName}.${name}` : name;

    // Collect union variant (constructor) names
    const constructors: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'union_variant') {
        const ctorName = findChild(child, 'upper_case_identifier');
        if (ctorName) constructors.push(ctorName.text);
      }
    }

    const meta: Record<string, unknown> = {};
    if (constructors.length > 0) meta.constructors = constructors;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'type'),
      name,
      kind: 'type',
      fqn,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  /**
   * port name : Type
   */
  private extractPort(
    node: TSNode,
    filePath: string,
    moduleName: string | undefined,
    symbols: RawSymbol[],
    seenNames: Set<string>,
  ): void {
    const nameNode = findChild(node, 'lower_case_identifier');
    if (!nameNode) return;
    const name = nameNode.text;

    const fqn = moduleName ? `${moduleName}.${name}` : name;
    seenNames.add(name);

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { port: true },
    });
  }

  /**
   * name : Type -> Type (function type signature)
   */
  private extractTypeAnnotation(
    node: TSNode,
    filePath: string,
    moduleName: string | undefined,
    symbols: RawSymbol[],
    seenNames: Set<string>,
  ): void {
    const nameNode = findChild(node, 'lower_case_identifier');
    if (!nameNode) return;
    const name = nameNode.text;

    // Skip if already seen (port annotations take precedence)
    if (seenNames.has(name)) return;
    seenNames.add(name);

    const fqn = moduleName ? `${moduleName}.${name}` : name;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  /**
   * name args = expr (function/value definition)
   */
  private extractValueDeclaration(
    node: TSNode,
    filePath: string,
    moduleName: string | undefined,
    symbols: RawSymbol[],
    seenNames: Set<string>,
  ): void {
    // The function name is inside function_declaration_left → lower_case_identifier
    const declLeft = findChild(node, 'function_declaration_left');
    if (!declLeft) return;

    const nameNode = findChild(declLeft, 'lower_case_identifier');
    if (!nameNode) return;
    const name = nameNode.text;

    // Skip if already seen (type_annotation or port_annotation already created the symbol)
    // They share the same symbolId so dedup is natural, but we avoid duplicate entries
    if (seenNames.has(name)) return;
    seenNames.add(name);

    const fqn = moduleName ? `${moduleName}.${name}` : name;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }
}
