/**
 * Python Language Plugin — tree-sitter based symbol extraction.
 *
 * Extracts classes, methods, functions, constants, variables, properties,
 * decorators, and import edges from Python source files.
 */
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, SymbolKind } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser } from '../../../../parser/tree-sitter.js';
import {
  type TSNode,
  makeSymbolId,
  makeFqn,
  filePathToModule,
  extractSignature,
  extractDecorators,
  extractImportEdges,
  getNodeName,
  isAllCaps,
  extractClassBases,
  extractClassMethods,
  extractInstanceAttributes,
  extractTypeAlias,
  extractTypeParams,
  hasSpecialDecorator,
  collectNodeTypes,
} from './helpers.js';
import { detectMinPythonVersion } from './version-features.js';

export class PythonLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'python-language',
    version: '1.0.0',
    priority: 5,
  };

  supportedExtensions = ['.py', '.pyi'];
  supportedVersions = [
    '2.7',
    '3.0', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8',
    '3.9', '3.10', '3.11', '3.12', '3.13', '3.14',
  ];

  async extractSymbols(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('python');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const modulePath = filePathToModule(filePath);
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walkTopLevel(root, filePath, modulePath, symbols);

      const edges = extractImportEdges(root);

      return ok({
        language: 'python',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
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
  ): void {
    for (const node of root.namedChildren) {
      switch (node.type) {
        case 'function_definition':
          this.extractFunction(node, filePath, modulePath, symbols, []);
          break;
        case 'class_definition':
          this.extractClass(node, filePath, modulePath, symbols, []);
          break;
        case 'decorated_definition':
          this.extractDecorated(node, filePath, modulePath, symbols);
          break;
        case 'expression_statement':
          this.extractModuleVariable(node, filePath, modulePath, symbols);
          break;
        case 'type_alias_statement': {
          // Python 3.12+ PEP 695: `type X = ...`
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
  ): void {
    const decorators = extractDecorators(node);

    // Find the inner definition
    for (const child of node.namedChildren) {
      if (child.type === 'function_definition') {
        this.extractFunction(child, filePath, modulePath, symbols, decorators, node);
        return;
      }
      if (child.type === 'class_definition') {
        this.extractClass(child, filePath, modulePath, symbols, decorators, node);
        return;
      }
    }
  }

  private extractFunction(
    node: TSNode,
    filePath: string,
    modulePath: string,
    symbols: RawSymbol[],
    decorators: string[],
    rangeNode?: TSNode,
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const asyncFlag = node.text.trimStart().startsWith('async');
    const fqn = makeFqn([modulePath, name]);
    const effectiveNode = rangeNode ?? node;
    const typeParams = extractTypeParams(node);

    const meta: Record<string, unknown> = {};
    if (asyncFlag) meta.async = true;
    if (decorators.length > 0) meta.decorators = decorators;
    if (hasSpecialDecorator(decorators, 'override')) meta.override = true;
    if (hasSpecialDecorator(decorators, 'overload')) meta.overload = true;
    if (typeParams) meta.typeParams = typeParams;

    // Detect minimum Python version from AST features
    const nodeTypes = collectNodeTypes(effectiveNode);
    const minVer = detectMinPythonVersion(nodeTypes);
    if (minVer) meta.minPythonVersion = minVer;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
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
  }

  private extractClass(
    node: TSNode,
    filePath: string,
    modulePath: string,
    symbols: RawSymbol[],
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

    const meta: Record<string, unknown> = {};
    if (decorators.length > 0) meta.decorators = decorators;
    if (bases.length > 0) meta.bases = bases;
    if (typeParams) meta.typeParams = typeParams;

    // Detect minimum Python version from AST features
    const nodeTypes = collectNodeTypes(effectiveNode);
    const minVer = detectMinPythonVersion(nodeTypes);
    if (minVer) meta.minPythonVersion = minVer;

    // Detect special class patterns
    if (decorators.includes('dataclass') || decorators.includes('dataclasses.dataclass')) {
      meta.dataclass = true;
    }
    if (bases.some((b) => b === 'BaseModel' || b.endsWith('.BaseModel'))) {
      meta.pydantic = true;
    }
    if (bases.some((b) => b === 'Protocol' || b.endsWith('.Protocol'))) {
      meta.protocol = true;
    }
    if (bases.some((b) => b === 'ABC' || b === 'ABCMeta' || b.endsWith('.ABC'))) {
      meta.abstract = true;
    }
    if (bases.some((b) => b === 'Enum' || b === 'IntEnum' || b === 'StrEnum' || b.endsWith('.Enum'))) {
      meta.enum = true;
    }

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

    // Extract class body
    const body = node.childForFieldName('body');
    if (body) {
      // Extract methods
      const methods = extractClassMethods(body, filePath, name, symbolId);
      for (const method of methods) {
        method.fqn = makeFqn([modulePath, name, method.name]);
        symbols.push(method);
      }

      // Extract class-level variable assignments (class attributes)
      this.extractClassAttributes(body, filePath, modulePath, name, symbolId, symbols);

      // Extract instance attributes from __init__ (skip if already declared as class attr)
      const initMethod = this.findInitMethod(body);
      if (initMethod) {
        const initBody = initMethod.childForFieldName('body');
        if (initBody) {
          const attrs = extractInstanceAttributes(initBody, filePath, name, symbolId);
          for (const attr of attrs) {
            const exists = symbols.some(
              (s) => s.parentSymbolId === symbolId && s.name === attr.name,
            );
            if (!exists) {
              attr.fqn = makeFqn([modulePath, name, attr.name]);
              symbols.push(attr);
            }
          }
        }
      }
    }
  }

  /** Find the __init__ method in a class body (handles decorated_definition too). */
  private findInitMethod(body: TSNode): TSNode | null {
    for (const child of body.namedChildren) {
      if (child.type === 'function_definition') {
        if (getNodeName(child) === '__init__') return child;
      }
      if (child.type === 'decorated_definition') {
        const inner = child.namedChildren.find((c) => c.type === 'function_definition');
        if (inner && getNodeName(inner) === '__init__') return inner;
      }
    }
    return null;
  }

  /** Extract class-level attribute assignments (not methods). */
  private extractClassAttributes(
    body: TSNode,
    filePath: string,
    modulePath: string,
    className: string,
    classSymbolId: string,
    symbols: RawSymbol[],
  ): void {
    for (const child of body.namedChildren) {
      if (child.type !== 'expression_statement') continue;
      const expr = child.namedChildren[0];
      if (!expr) continue;

      if (expr.type === 'assignment') {
        const left = expr.childForFieldName('left');
        if (left && left.type === 'identifier') {
          const name = left.text;
          const kind: SymbolKind = isAllCaps(name) ? 'constant' : 'property';
          symbols.push({
            symbolId: makeSymbolId(filePath, name, kind, className),
            name,
            kind,
            fqn: makeFqn([modulePath, className, name]),
            parentSymbolId: classSymbolId,
            byteStart: child.startIndex,
            byteEnd: child.endIndex,
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
          });
        }
      }
      // Typed annotation without value: `x: int` — handled in second pass below
      if (expr.type === 'type') continue;
    }

    // Handle typed assignments (annotation): `name: type` or `name: type = value`
    for (const child of body.namedChildren) {
      if (child.type !== 'expression_statement') continue;
      const expr = child.namedChildren[0];
      if (!expr) continue;

      if (expr.type === 'type' && expr.namedChildren.length > 0) {
        // annotated assignment without value: `x: int`
        const innerAssign = expr.namedChildren[0];
        if (innerAssign && innerAssign.type === 'identifier') {
          const name = innerAssign.text;
          const kind: SymbolKind = isAllCaps(name) ? 'constant' : 'property';
          // Avoid duplicates if already added as assignment
          const exists = symbols.some(
            (s) => s.parentSymbolId === classSymbolId && s.name === name,
          );
          if (!exists) {
            symbols.push({
              symbolId: makeSymbolId(filePath, name, kind, className),
              name,
              kind,
              fqn: makeFqn([modulePath, className, name]),
              parentSymbolId: classSymbolId,
              byteStart: child.startIndex,
              byteEnd: child.endIndex,
              lineStart: child.startPosition.row + 1,
              lineEnd: child.endPosition.row + 1,
            });
          }
        }
      }
    }
  }

  /** Extract module-level variable/constant from an expression_statement. */
  private extractModuleVariable(
    node: TSNode,
    filePath: string,
    modulePath: string,
    symbols: RawSymbol[],
  ): void {
    const expr = node.namedChildren[0];
    if (!expr) return;

    if (expr.type === 'assignment') {
      const left = expr.childForFieldName('left');
      if (left && left.type === 'identifier') {
        const name = left.text;
        const kind: SymbolKind = isAllCaps(name) ? 'constant' : 'variable';
        const sig = node.text.split('\n')[0].trim().slice(0, 80);

        symbols.push({
          symbolId: makeSymbolId(filePath, name, kind),
          name,
          kind,
          fqn: makeFqn([modulePath, name]),
          signature: sig,
          byteStart: node.startIndex,
          byteEnd: node.endIndex,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
        });
      }
      // Handle tuple unpacking: a, b = 1, 2
      if (left && left.type === 'pattern_list') {
        for (const id of left.namedChildren) {
          if (id.type === 'identifier') {
            const name = id.text;
            const kind: SymbolKind = isAllCaps(name) ? 'constant' : 'variable';
            symbols.push({
              symbolId: makeSymbolId(filePath, name, kind),
              name,
              kind,
              fqn: makeFqn([modulePath, name]),
              byteStart: node.startIndex,
              byteEnd: node.endIndex,
              lineStart: node.startPosition.row + 1,
              lineEnd: node.endPosition.row + 1,
            });
          }
        }
      }
    }
  }
}
