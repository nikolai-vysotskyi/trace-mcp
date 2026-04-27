/**
 * TypeScript/JavaScript Language Plugin — tree-sitter based symbol extraction.
 *
 * Extracts functions, classes, variables (exported const/let), types,
 * interfaces, enums, methods, and import edges from TS/JS source files.
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
  getFullSignature,
  isExported,
  isDefaultExport,
  isAsync,
  getNodeName,
  extractImportEdges,
  extractClassMethods,
  extractDecorators,
  collectNodeTypes,
  extractCallSites,
  collectLocalTypes,
  extractTypeReferences,
  extractModuleCallSites,
} from './helpers.js';
import {
  detectMinNodeVersion,
  detectMinNodeVersionFromAPIs,
  detectMinTsVersion,
  detectMinTsVersionFromSource,
  detectMinEsVersion,
} from './version-features.js';

const TSX_EXTENSIONS = new Set(['.tsx', '.jsx']);
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

export class TypeScriptLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'typescript-language',
    version: '1.0.0',
    priority: 5,
  };

  supportedExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  supportedVersions = ['12', '14', '16', '17', '18', '19', '20', '21', '22', '23', '24'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const ext = filePath.substring(filePath.lastIndexOf('.'));
      const sourceCode = content.toString('utf-8');
      // Detect JSX syntax in .js/.mjs/.cjs files (common in Next.js/React apps).
      // If the file contains JSX (< followed by uppercase identifier or "<>" / "</>"),
      // fall back to the TSX parser to avoid losing all symbols on parse failure.
      const isJsExt = ext === '.js' || ext === '.mjs' || ext === '.cjs';
      const hasJsx = isJsExt && /(?:^|[\s(=,;>])<(?:[A-Z][A-Za-z0-9]*|>|\/>)/.test(sourceCode);
      const useTsx = TSX_EXTENSIONS.has(ext) || hasJsx;
      const parser = await getParser(useTsx ? 'tsx' : 'typescript');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walkTopLevel(root, filePath, symbols);

      // Extract module-body call sites (code that runs at load time, not inside
      // any named function/class). Emit as a `__module__` pseudo-symbol so the
      // call graph can attribute these calls to something.
      const moduleCallSites = extractModuleCallSites(root);
      if (moduleCallSites.length > 0) {
        const moduleName =
          filePath
            .split('/')
            .pop()
            ?.replace(/\.[^.]+$/, '') ?? '__module__';
        symbols.push({
          symbolId: makeSymbolId(filePath, '__module__', 'namespace'),
          name: `__module__:${moduleName}`,
          kind: 'namespace',
          signature: `(module body) ${filePath}`,
          byteStart: 0,
          byteEnd: root.endIndex,
          lineStart: 1,
          lineEnd: root.endPosition.row + 1,
          metadata: {
            synthetic: true,
            moduleBody: true,
            callSites: moduleCallSites,
          },
        });
      }

      const edges = extractImportEdges(root);

      // Detect minimum versions from API usage / source patterns at file level
      const apiVersion = detectMinNodeVersionFromAPIs(sourceCode);
      const tsSourceVersion = detectMinTsVersionFromSource(sourceCode);

      // Determine language label: JS files get 'javascript', TS files get 'typescript'
      const isJs = JS_EXTENSIONS.has(ext);
      const language = isJs ? 'javascript' : 'typescript';

      // Build file-level metadata with detected version info
      const metadata: Record<string, unknown> = {};
      if (apiVersion) metadata.minNodeVersion = apiVersion;
      if (!isJs && tsSourceVersion) metadata.minTsVersion = tsSourceVersion;

      return ok({
        language,
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `TypeScript parse failed: ${msg}`));
    }
  }

  private walkTopLevel(root: TSNode, filePath: string, symbols: RawSymbol[]): void {
    for (const node of root.namedChildren) {
      switch (node.type) {
        case 'function_declaration':
          this.extractFunction(node, filePath, symbols);
          break;
        case 'class_declaration':
          this.extractClass(node, filePath, symbols);
          break;
        case 'lexical_declaration':
          this.extractVariable(node, filePath, symbols);
          break;
        case 'type_alias_declaration':
          this.extractType(node, filePath, symbols);
          break;
        case 'interface_declaration':
          this.extractInterface(node, filePath, symbols);
          break;
        case 'enum_declaration':
          this.extractEnum(node, filePath, symbols);
          break;
        case 'export_statement':
          this.walkExportStatement(node, filePath, symbols);
          break;
      }
    }
  }

  private walkExportStatement(exportNode: TSNode, filePath: string, symbols: RawSymbol[]): void {
    for (const child of exportNode.namedChildren) {
      switch (child.type) {
        case 'function_declaration':
          this.extractFunction(child, filePath, symbols);
          break;
        case 'class_declaration':
          this.extractClass(child, filePath, symbols);
          break;
        case 'lexical_declaration':
          this.extractVariable(child, filePath, symbols);
          break;
        case 'type_alias_declaration':
          this.extractType(child, filePath, symbols);
          break;
        case 'interface_declaration':
          this.extractInterface(child, filePath, symbols);
          break;
        case 'enum_declaration':
          this.extractEnum(child, filePath, symbols);
          break;
      }
    }
  }

  /** Detect and attach version info to a symbol's metadata based on its AST subtree. */
  private attachVersionInfo(node: TSNode, metadata: Record<string, unknown>): void {
    const nodeTypes = collectNodeTypes(node);
    const minNode = detectMinNodeVersion(nodeTypes);
    const minTs = detectMinTsVersion(nodeTypes);
    const minEs = detectMinEsVersion(nodeTypes);
    if (minNode) metadata.minNodeVersion = minNode;
    if (minTs) metadata.minTsVersion = minTs;
    if (minEs) metadata.minEsVersion = minEs;
  }

  private extractFunction(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;
    const decorators = extractDecorators(node);
    const metadata: Record<string, unknown> = {
      exported: isExported(node),
      default: isDefaultExport(node),
      async: isAsync(node),
    };
    if (decorators.length > 0) metadata.decorators = decorators;
    this.attachVersionInfo(node, metadata);

    const callSites = extractCallSites(node);
    if (callSites.length > 0) metadata.callSites = callSites;
    const localTypes = collectLocalTypes(node);
    if (Object.keys(localTypes).length > 0) metadata.localTypes = localTypes;
    const typeRefs = extractTypeReferences(node);
    if (typeRefs.length > 0) metadata.typeRefs = typeRefs;
    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      signature: getFullSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata,
    });
  }

  private extractClass(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;
    const symbolId = makeSymbolId(filePath, name, 'class');

    const decorators = extractDecorators(node);
    const heritage = this.extractHeritage(node);
    const metadata: Record<string, unknown> = {
      exported: isExported(node),
      default: isDefaultExport(node),
      ...(decorators.length > 0 ? { decorators } : {}),
      ...(heritage.extends ? { extends: heritage.extends } : {}),
      ...(heritage.implements.length > 0 ? { implements: heritage.implements } : {}),
    };
    this.attachVersionInfo(node, metadata);

    const classTypeRefs = extractTypeReferences(node);
    if (classTypeRefs.length > 0) metadata.typeRefs = classTypeRefs;

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      signature: getFullSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata,
    });

    const body = node.childForFieldName('body');
    if (body) {
      symbols.push(...extractClassMethods(body, filePath, name, symbolId));
    }
  }

  private extractVariable(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const exported = isExported(node);

    for (const child of node.namedChildren) {
      if (child.type === 'variable_declarator') {
        const name = getNodeName(child);
        if (!name) continue;

        // Detect `const foo = () => {}` or `const foo = function() {}` — treat
        // as functions so they participate in the call graph. These are often
        // re-exported via `export { foo }` statements at module bottom.
        const valueNode = child.childForFieldName('value');
        const isFunctionLike =
          !!valueNode &&
          (valueNode.type === 'arrow_function' ||
            valueNode.type === 'function_expression' ||
            valueNode.type === 'generator_function');

        // Skip non-exported non-function variables — they're usually constants
        // or local state that would only bloat symbol counts.
        if (!exported && !isFunctionLike) continue;

        const metadata: Record<string, unknown> = {
          exported,
          default: isDefaultExport(node),
        };

        if (isFunctionLike && valueNode) {
          const callSites = extractCallSites(valueNode);
          if (callSites.length > 0) metadata.callSites = callSites;
          const localTypes = collectLocalTypes(valueNode);
          if (Object.keys(localTypes).length > 0) metadata.localTypes = localTypes;
          const typeRefs = extractTypeReferences(valueNode);
          if (typeRefs.length > 0) metadata.typeRefs = typeRefs;
        } else {
          // For non-function exported consts, collect type annotations
          const typeRefs = extractTypeReferences(child);
          if (typeRefs.length > 0) metadata.typeRefs = typeRefs;
        }

        symbols.push({
          symbolId: makeSymbolId(filePath, name, isFunctionLike ? 'function' : 'variable'),
          name,
          kind: isFunctionLike ? 'function' : 'variable',
          signature: getFullSignature(node),
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          metadata,
        });
      }
    }
  }

  private extractType(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;
    const metadata: Record<string, unknown> = {
      exported: isExported(node),
      default: isDefaultExport(node),
    };
    const typeRefs = extractTypeReferences(node);
    if (typeRefs.length > 0) metadata.typeRefs = typeRefs;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'type'),
      name,
      kind: 'type',
      signature: getFullSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata,
    });
  }

  private extractInterface(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const heritage = this.extractHeritage(node);

    const metadata: Record<string, unknown> = {
      exported: isExported(node),
      default: isDefaultExport(node),
      ...(heritage.extends ? { extends: heritage.extends } : {}),
      ...(heritage.implements.length > 0 ? { implements: heritage.implements } : {}),
    };
    const typeRefs = extractTypeReferences(node);
    if (typeRefs.length > 0) metadata.typeRefs = typeRefs;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'interface'),
      name,
      kind: 'interface',
      signature: getFullSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata,
    });
  }

  private extractHeritage(node: TSNode): { extends: string | null; implements: string[] } {
    const result: { extends: string | null; implements: string[] } = {
      extends: null,
      implements: [],
    };
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (child.type === 'class_heritage') {
        // class_heritage contains extends_clause and/or implements_clause
        for (const clause of child.namedChildren) {
          if (clause.type === 'extends_clause') {
            const typeNode = clause.namedChildren[0];
            if (typeNode) result.extends = typeNode.text;
          } else if (clause.type === 'implements_clause') {
            for (const impl of clause.namedChildren) {
              result.implements.push(impl.text);
            }
          }
        }
      } else if (child.type === 'extends_type_clause') {
        // interface Foo extends Bar, Baz
        for (const nc of child.namedChildren) {
          if (!result.extends) result.extends = nc.text;
          else result.implements.push(nc.text);
        }
      }
    }
    return result;
  }

  private extractEnum(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;
    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'enum'),
      name,
      kind: 'enum',
      signature: getFullSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: {
        exported: isExported(node),
        default: isDefaultExport(node),
      },
    });
  }
}
