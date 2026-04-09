/**
 * Kotlin Language Plugin — tree-sitter based symbol extraction.
 * Uses web-tree-sitter WASM for accurate AST parsing.
 */
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge, SymbolKind } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser } from '../../../../parser/tree-sitter.js';
import { detectMinKotlinVersion } from './version-features.js';
import {
  type TSNode,
  makeSymbolId,
  makeFqn,
  extractPackageName,
  extractSignature,
  extractAnnotations,
  extractModifiers,
  extractImportEdges,
  extractHeritage,
  extractClassMethods,
  extractClassProperties,
  extractEnumEntries,
  extractCompanionObject,
  detectClassKind,
  getNodeName,
} from './helpers.js';

export class KotlinLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'kotlin-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.kt', '.kts'];
  supportedVersions = ['1.0', '1.1', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '2.0', '2.1'];

  async extractSymbols(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('kotlin');
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

      const minKotlinVer = detectMinKotlinVersion(sourceCode);
      const metadata: Record<string, unknown> = {};
      if (minKotlinVer) metadata.minKotlinVersion = minKotlinVer;

      return ok({
        language: 'kotlin',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Kotlin parse failed: ${msg}`));
    }
  }

  private walkTopLevel(root: TSNode, filePath: string, packageName: string | undefined, symbols: RawSymbol[]): void {
    for (const child of root.namedChildren) {
      switch (child.type) {
        case 'class_declaration':
          this.extractClassDeclaration(child, filePath, packageName, symbols);
          break;
        case 'object_declaration':
          this.extractObjectDeclaration(child, filePath, packageName, symbols);
          break;
        case 'function_declaration':
          this.extractTopLevelFunction(child, filePath, packageName, symbols);
          break;
        case 'property_declaration':
          this.extractTopLevelProperty(child, filePath, packageName, symbols);
          break;
        case 'type_alias':
          this.extractTypeAlias(child, filePath, packageName, symbols);
          break;
      }
    }
  }

  private extractClassDeclaration(
    node: TSNode,
    filePath: string,
    packageName: string | undefined,
    symbols: RawSymbol[],
    parentName?: string,
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const classKind = detectClassKind(node);
    const kind: SymbolKind = classKind;
    const fqnParts = packageName ? [packageName, name] : [name];
    const symbolId = makeSymbolId(filePath, name, kind, parentName);
    const modifiers = extractModifiers(node);
    const annotations = extractAnnotations(node);
    const heritage = extractHeritage(node);

    const meta: Record<string, unknown> = {};
    if (annotations.length > 0) meta.annotations = annotations;
    if (modifiers.length > 0) meta.modifiers = modifiers.join(' ');
    if (modifiers.includes('data')) meta.data = true;
    if (modifiers.includes('sealed')) meta.sealed = true;
    if (modifiers.includes('abstract')) meta.abstract = true;
    if (modifiers.includes('open')) meta.open = true;
    if (modifiers.includes('inner')) meta.inner = true;
    if (modifiers.includes('annotation')) meta.annotation = true;
    if (heritage.extends_) meta.extends = heritage.extends_;
    if (heritage.implements_) meta.implements = heritage.implements_;

    symbols.push({
      symbolId,
      name,
      kind,
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Extract class body members
    const body = this.findClassBody(node);
    if (body) {
      symbols.push(...extractClassMethods(body, filePath, name, symbolId, packageName));
      symbols.push(...extractClassProperties(body, filePath, name, symbolId, packageName));
      symbols.push(...extractCompanionObject(body, filePath, name, symbolId, packageName));

      if (classKind === 'enum') {
        symbols.push(...extractEnumEntries(body, filePath, name, symbolId));
      }

      // Nested classes/objects — pass parent name so symbolIds don't collide with
      // same-named top-level declarations (e.g. both `class Outer { class Inner }`
      // and `class Inner` at the top level must get distinct symbolIds).
      for (const inner of body.namedChildren) {
        if (inner.type === 'class_declaration') {
          this.extractClassDeclaration(inner, filePath, packageName, symbols, name);
        } else if (inner.type === 'object_declaration') {
          this.extractObjectDeclaration(inner, filePath, packageName, symbols, name);
        }
      }
    }
  }

  private extractObjectDeclaration(
    node: TSNode,
    filePath: string,
    packageName: string | undefined,
    symbols: RawSymbol[],
    parentName?: string,
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = packageName ? [packageName, name] : [name];
    const symbolId = makeSymbolId(filePath, name, 'class', parentName);
    const modifiers = extractModifiers(node);
    const annotations = extractAnnotations(node);
    const heritage = extractHeritage(node);

    const meta: Record<string, unknown> = { object: true };
    if (annotations.length > 0) meta.annotations = annotations;
    if (modifiers.length > 0) meta.modifiers = modifiers.join(' ');
    if (heritage.extends_) meta.extends = heritage.extends_;
    if (heritage.implements_) meta.implements = heritage.implements_;

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

    // Extract object body members
    const body = this.findClassBody(node);
    if (body) {
      symbols.push(...extractClassMethods(body, filePath, name, symbolId, packageName));
      symbols.push(...extractClassProperties(body, filePath, name, symbolId, packageName));

      // Nested classes/objects
      for (const inner of body.namedChildren) {
        if (inner.type === 'class_declaration') {
          this.extractClassDeclaration(inner, filePath, packageName, symbols, name);
        } else if (inner.type === 'object_declaration') {
          this.extractObjectDeclaration(inner, filePath, packageName, symbols, name);
        }
      }
    }
  }

  private extractTopLevelFunction(
    node: TSNode,
    filePath: string,
    packageName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const modifiers = extractModifiers(node);
    const annotations = extractAnnotations(node);
    const fqnParts = packageName ? [packageName, name] : [name];

    const meta: Record<string, unknown> = {};
    if (annotations.length > 0) meta.annotations = annotations;
    if (modifiers.includes('suspend')) meta.suspend = true;
    if (modifiers.includes('inline')) meta.inline = true;

    const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
    if (visibility) meta.visibility = visibility;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractTopLevelProperty(
    node: TSNode,
    filePath: string,
    packageName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const modifiers = extractModifiers(node);
    const isConst = modifiers.includes('const');

    // Check if val or var
    let isVal = false;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.text === 'val') {
        isVal = true;
        break;
      }
    }

    // Get name from variable_declaration or directly
    let name: string | undefined;
    let typeText: string | undefined;

    for (const child of node.namedChildren) {
      if (child.type === 'variable_declaration') {
        name = getNodeName(child);
        // Look for type annotation
        for (const vc of child.namedChildren) {
          if (vc.type === 'user_type' || vc.type === 'nullable_type') {
            typeText = vc.text;
          }
        }
        break;
      }
    }
    if (!name) {
      name = getNodeName(node);
    }
    if (!name) return;

    // Determine if constant: explicitly `const val`, or a val with ALL_CAPS name
    const isConstant = isConst || (isVal && /^[A-Z][A-Z0-9_]+$/.test(name));
    const kind: SymbolKind = isConstant ? 'constant' : 'property';
    const fqnParts = packageName ? [packageName, name] : [name];

    const meta: Record<string, unknown> = {};
    if (typeText) meta.type = typeText;
    if (isVal) meta.val = true;

    const visibility = modifiers.find((m) => ['public', 'private', 'protected', 'internal'].includes(m));
    if (visibility) meta.visibility = visibility;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, kind),
      name,
      kind,
      fqn: makeFqn(fqnParts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractTypeAlias(
    node: TSNode,
    filePath: string,
    packageName: string | undefined,
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const fqnParts = packageName ? [packageName, name] : [name];

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
    });
  }

  private findClassBody(node: TSNode): TSNode | undefined {
    for (const child of node.namedChildren) {
      if (child.type === 'class_body' || child.type === 'enum_class_body') {
        return child;
      }
    }
    return undefined;
  }
}
