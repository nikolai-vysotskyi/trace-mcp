/**
 * Python Language Plugin — tree-sitter based symbol extraction.
 *
 * Extracts classes, methods, functions, constants, variables, properties,
 * decorators, import edges, type annotation edges, inheritance edges,
 * re-export edges, and docstrings from Python source files.
 */
import { err, ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser } from '../../../../parser/tree-sitter.js';
import type {
  FileParseResult,
  LanguagePlugin,
  PluginManifest,
  RawEdge,
  RawSymbol,
} from '../../../../plugin-api/types.js';
import {
  appendInstanceAttributes,
  appendNestedClasses,
  buildClassMetadata,
  collectFunctionTypeRefs,
  collectNodeTypes,
  detectVisibility,
  extractAllList,
  extractCallSites,
  extractClassAttributeSymbols,
  extractClassBases,
  extractConditionalImports,
  extractDecoratorEdges,
  extractDecorators,
  extractDocstring,
  extractImportEdges,
  extractInheritanceEdges,
  extractModuleVariableSymbols,
  extractNameMainCallees,
  extractNestedDefinitions,
  extractReexportEdges,
  extractSignature,
  extractSlots,
  extractTypeAlias,
  extractTypeAnnotationEdges,
  extractTypeCheckingImports,
  extractTypeParams,
  filePathToModule,
  getNodeName,
  hasSpecialDecorator,
  makeFqn,
  makeSymbolId,
  processClassMethods,
  type TSNode,
} from './helpers.js';
import { detectMinPythonVersion } from './version-features.js';

export class PythonLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'python-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.py', '.pyi'];
  supportedVersions = [
    '2.7',
    '3.0',
    '3.1',
    '3.2',
    '3.3',
    '3.4',
    '3.5',
    '3.6',
    '3.7',
    '3.8',
    '3.9',
    '3.10',
    '3.11',
    '3.12',
    '3.13',
    '3.14',
  ];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('python');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      try {
        const root: TSNode = tree.rootNode;

        const hasError = root.hasError;
        const modulePath = filePathToModule(filePath);
        const symbols: RawSymbol[] = [];
        const edges: RawEdge[] = [];
        const warnings: string[] = [];

        if (hasError) {
          warnings.push('Source contains syntax errors; extraction may be incomplete');
        }

        this.walkTopLevel(root, filePath, modulePath, symbols, edges);

        // Disambiguate duplicate symbolIds — valid in Python (function redefinition).
        // Append `:L<lineStart>` to every member of each collision group.
        const idCount = new Map<string, number>();
        for (const s of symbols) idCount.set(s.symbolId, (idCount.get(s.symbolId) ?? 0) + 1);
        for (const s of symbols) {
          if ((idCount.get(s.symbolId) ?? 0) > 1) {
            s.symbolId = `${s.symbolId}:L${s.lineStart ?? 0}`;
          }
        }

        // Import edges
        const importEdges = extractImportEdges(root);
        edges.push(...importEdges);

        // __init__.py re-export edges
        const reexportEdges = extractReexportEdges(root, filePath);
        edges.push(...reexportEdges);

        // TYPE_CHECKING imports
        const tcEdges = extractTypeCheckingImports(root);
        edges.push(...tcEdges);

        // Conditional imports (try/except ImportError)
        const condEdges = extractConditionalImports(root);
        edges.push(...condEdges);

        // __all__ export list
        const allList = extractAllList(root);

        // ── Mark exported symbols ────────────────────────────────────
        // Python export semantics:
        //   - If __all__ is defined → only names listed in __all__ are exported
        //   - Otherwise → all top-level public symbols (no leading _) are exported
        // Methods are never directly exported (they inherit from their parent class).
        const exportedNames: Set<string> | null = allList ? new Set(allList) : null;

        for (const sym of symbols) {
          // Skip child symbols (methods, nested classes, instance attrs)
          if (sym.parentSymbolId) continue;

          const isExported = exportedNames
            ? exportedNames.has(sym.name)
            : detectVisibility(sym.name) === 'public';

          if (isExported) {
            sym.metadata = sym.metadata ?? {};
            sym.metadata.exported = true;
          }
        }

        // ── if __name__ == "__main__" entry point detection ────────
        // Symbols called from the __name__ guard are CLI entry points;
        // they should not be reported as dead exports.
        const nameMainCallees = extractNameMainCallees(root);
        if (nameMainCallees.length > 0) {
          const calleeSet = new Set(nameMainCallees);
          for (const sym of symbols) {
            if (sym.parentSymbolId) continue;
            if (calleeSet.has(sym.name)) {
              sym.metadata = sym.metadata ?? {};
              sym.metadata.is_entry_point = 'name_main';
            }
          }
        }

        // Module-level call sites — extract from top-level expressions
        // (e.g. `app = Flask(__name__)`, `register_blueprint(bp)`, `if __name__ == "__main__": main()`)
        const moduleLevelCalls = extractCallSites(root);
        if (moduleLevelCalls.length > 0) {
          const moduleSymbolId = makeSymbolId(filePath, '<module>', 'function');
          symbols.push({
            symbolId: moduleSymbolId,
            name: '<module>',
            kind: 'function',
            fqn: makeFqn([modulePath, '<module>']),
            signature: `module ${filePath}`,
            byteStart: root.startIndex,
            byteEnd: root.endIndex,
            lineStart: 1,
            lineEnd: root.endPosition.row + 1,
            metadata: { synthetic: true, callSites: moduleLevelCalls },
          });
        }

        // Module docstring
        const moduleDocstring = extractDocstring(root);

        return ok({
          language: 'python',
          status: hasError ? 'partial' : 'ok',
          symbols,
          edges: edges.length > 0 ? edges : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
          metadata: {
            ...(allList ? { __all__: allList } : {}),
            ...(moduleDocstring ? { docstring: moduleDocstring } : {}),
            ...(filePath.endsWith('__init__.py') ? { isPackageInit: true } : {}),
          },
        });
      } finally {
        tree.delete();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Python parse failed: ${msg}`));
    }
  }

  private walkTopLevel(
    root: TSNode,
    filePath: string,
    modulePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
  ): void {
    for (const node of root.namedChildren) {
      switch (node.type) {
        case 'function_definition':
          this.extractFunction(node, filePath, modulePath, symbols, edges, []);
          break;
        case 'class_definition':
          this.extractClass(node, filePath, modulePath, symbols, edges, []);
          break;
        case 'decorated_definition':
          this.extractDecorated(node, filePath, modulePath, symbols, edges);
          break;
        case 'expression_statement':
          this.extractModuleVariable(node, filePath, modulePath, symbols);
          break;
        case 'type_alias_statement': {
          const alias = extractTypeAlias(node, filePath, modulePath);
          if (alias) symbols.push(alias);
          break;
        }
      }
    }
  }

  private extractDecorated(
    node: TSNode,
    filePath: string,
    modulePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
  ): void {
    const decorators = extractDecorators(node);

    for (const child of node.namedChildren) {
      if (child.type === 'function_definition') {
        this.extractFunction(child, filePath, modulePath, symbols, edges, decorators, node);
        return;
      }
      if (child.type === 'class_definition') {
        this.extractClass(child, filePath, modulePath, symbols, edges, decorators, node);
        return;
      }
    }
  }

  private extractFunction(
    node: TSNode,
    filePath: string,
    modulePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    decorators: string[],
    rangeNode?: TSNode,
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const asyncFlag = node.text.trimStart().startsWith('async');
    const fqn = makeFqn([modulePath, name]);
    const effectiveNode = rangeNode ?? node;
    const typeParams = extractTypeParams(node);
    const symbolId = makeSymbolId(filePath, name, 'function');

    const meta: Record<string, unknown> = {};
    if (asyncFlag) meta.async = true;
    if (decorators.length > 0) meta.decorators = decorators;
    if (hasSpecialDecorator(decorators, 'override')) meta.override = true;
    if (hasSpecialDecorator(decorators, 'overload')) meta.overload = true;
    if (typeParams) meta.typeParams = typeParams;

    // Visibility
    const vis = detectVisibility(name);
    if (vis !== 'public') meta.visibility = vis;

    // Docstring
    const doc = extractDocstring(node);
    if (doc) meta.docstring = doc;

    // Detect minimum Python version from AST features
    const nodeTypes = collectNodeTypes(effectiveNode);
    const minVer = detectMinPythonVersion(nodeTypes);
    if (minVer) meta.minPythonVersion = minVer;

    // Call sites — must be added to meta BEFORE symbols.push
    const body = node.childForFieldName('body');
    if (body) {
      const callSites = extractCallSites(body);
      if (callSites.length > 0) meta.callSites = callSites;
    }

    // Type-reference names (param + return annotations) — consumed by the
    // Python type-edge resolver to build symbol-level `references` edges so a
    // change to `User` surfaces every function that takes/returns a `User`.
    const typeRefs = collectFunctionTypeRefs(node);
    if (typeRefs.length > 0) meta.typeRefs = typeRefs;

    symbols.push({
      symbolId,
      name,
      kind: 'function',
      fqn,
      signature: extractSignature(node),
      byteStart: effectiveNode.startIndex,
      byteEnd: effectiveNode.endIndex,
      lineStart: effectiveNode.startPosition.row + 1,
      lineEnd: effectiveNode.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Type annotation edges
    edges.push(...extractTypeAnnotationEdges(node, symbolId));

    // Decorator edges
    if (decorators.length > 0) {
      edges.push(...extractDecoratorEdges(decorators, symbolId));
    }

    // Nested definitions
    if (body) {
      const nested = extractNestedDefinitions(body, filePath, name, symbolId, modulePath);
      symbols.push(...nested);
    }
  }

  private extractClass(
    node: TSNode,
    filePath: string,
    modulePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    decorators: string[],
    rangeNode?: TSNode,
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'class');
    const fqn = makeFqn([modulePath, name]);
    const bases = extractClassBases(node);
    const effectiveNode = rangeNode ?? node;
    const typeParams = extractTypeParams(node);

    const meta = buildClassMetadata(node, effectiveNode, bases, decorators, typeParams, name);

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      fqn,
      signature: extractSignature(node),
      byteStart: effectiveNode.startIndex,
      byteEnd: effectiveNode.endIndex,
      lineStart: effectiveNode.startPosition.row + 1,
      lineEnd: effectiveNode.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Inheritance edges (graph-level, not just metadata)
    if (bases.length > 0) {
      edges.push(...extractInheritanceEdges(bases, symbolId));
    }

    // Decorator edges
    if (decorators.length > 0) {
      edges.push(...extractDecoratorEdges(decorators, symbolId));
    }

    // Extract class body
    const body = node.childForFieldName('body');
    if (body) {
      // __slots__
      const slots = extractSlots(body);
      if (slots) {
        const classSym = symbols[symbols.length - 1];
        if (classSym.metadata) classSym.metadata.slots = slots;
        else classSym.metadata = { slots };
      }

      // Class body call sites (e.g. `manager = Manager()`, `register(cls)`)
      // These are calls at class level, outside methods — attach to class symbol
      const classBodyCalls = extractCallSites(body);
      if (classBodyCalls.length > 0) {
        const classSym = symbols[symbols.length - 1];
        classSym.metadata = classSym.metadata ?? {};
        classSym.metadata.callSites = classBodyCalls;
      }

      // Methods (visibility, docstrings, call sites, type + decorator edges).
      processClassMethods(body, filePath, modulePath, name, symbolId, symbols, edges);

      // Class-level variable assignments (class attributes).
      extractClassAttributeSymbols(body, filePath, modulePath, name, symbolId, symbols);

      // Instance attributes declared in __init__.
      appendInstanceAttributes(body, filePath, modulePath, name, symbolId, symbols);

      // Nested classes inside class body (Meta, Config, Exception, etc.).
      appendNestedClasses(body, filePath, name, symbolId, modulePath, symbols);
    }
  }

  private extractModuleVariable(
    node: TSNode,
    filePath: string,
    modulePath: string,
    symbols: RawSymbol[],
  ): void {
    extractModuleVariableSymbols(node, filePath, modulePath, symbols);
  }
}
