/**
 * Scala Language Plugin — tree-sitter based symbol extraction.
 *
 * Extracts classes, objects, traits, enums, case classes, methods (def),
 * vals, vars, type aliases, given instances, and import edges.
 * Supports both Scala 2 and Scala 3 constructs.
 */
import { ok, err } from 'neverthrow';
import type {
  LanguagePlugin,
  PluginManifest,
  FileParseResult,
  RawSymbol,
  SymbolKind,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser } from '../../../../parser/tree-sitter.js';
import {
  type TSNode,
  makeSymbolId,
  makeFqn,
  extractSignature,
  getNodeName,
  extractPackageName,
  isCaseDefinition,
  extractModifiers,
  extractInheritance,
  extractTypeParams,
  extractImportEdges,
  extractMethods,
  extractValVarMembers,
  extractTypeAliases,
  extractEnumCases,
  extractValVarName,
} from './helpers.js';

export class ScalaLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'scala-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.scala', '.sc'];
  supportedVersions = ['2.11', '2.12', '2.13', '3.0', '3.1', '3.2', '3.3', '3.4', '3.5'];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('scala');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      // Extract package name(s) for FQN construction
      const packageParts: string[] = [];
      for (const child of root.namedChildren) {
        if (child.type === 'package_clause') {
          const pkgName = extractPackageName(child);
          if (pkgName) {
            packageParts.push(pkgName);
            // Emit namespace symbol for the package
            symbols.push({
              symbolId: makeSymbolId(filePath, pkgName, 'namespace'),
              name: pkgName,
              kind: 'namespace',
              fqn: pkgName,
              signature: `package ${pkgName}`,
              byteStart: child.startIndex,
              byteEnd: child.endIndex,
              lineStart: child.startPosition.row + 1,
              lineEnd: child.endPosition.row + 1,
            });
          }
        }
      }
      const packageName = packageParts.join('.');

      // Walk top-level declarations
      this.walkTopLevel(root, filePath, packageName ? [packageName] : [], symbols);

      const edges = extractImportEdges(root);

      return ok({
        language: 'scala',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Scala parse failed: ${msg}`));
    }
  }

  private walkTopLevel(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    for (const child of node.namedChildren) {
      switch (child.type) {
        case 'package_clause':
          // Package declarations may contain nested definitions
          this.walkPackageBody(child, filePath, fqnParts, symbols);
          break;
        case 'class_definition':
          this.extractClass(child, filePath, fqnParts, symbols);
          break;
        case 'object_definition':
          this.extractObject(child, filePath, fqnParts, symbols);
          break;
        case 'trait_definition':
          this.extractTrait(child, filePath, fqnParts, symbols);
          break;
        case 'enum_definition':
          this.extractEnum(child, filePath, fqnParts, symbols);
          break;
        case 'function_definition':
          this.extractTopLevelFunction(child, filePath, fqnParts, symbols);
          break;
        case 'val_definition':
        case 'val_declaration':
          this.extractTopLevelVal(child, filePath, fqnParts, symbols);
          break;
        case 'var_definition':
        case 'var_declaration':
          this.extractTopLevelVar(child, filePath, fqnParts, symbols);
          break;
        case 'type_definition':
          this.extractTopLevelType(child, filePath, fqnParts, symbols);
          break;
        case 'given_definition':
          this.extractGiven(child, filePath, fqnParts, symbols);
          break;
      }
    }
  }

  private walkPackageBody(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    // Package clause may have a body with nested definitions (package object pattern)
    const body = node.childForFieldName('body');
    if (body) {
      this.walkTopLevel(body, filePath, fqnParts, symbols);
    }
    // Also check direct children for package-level definitions
    for (const child of node.namedChildren) {
      if (child.type === 'template_body' || child.type === 'block') {
        this.walkTopLevel(child, filePath, fqnParts, symbols);
      }
    }
  }

  private extractClass(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const parts = [...fqnParts, name];
    const symbolId = makeSymbolId(filePath, name, 'class');
    const meta: Record<string, unknown> = {};
    const mods = extractModifiers(node);

    // Detect case class
    const isCase = isCaseDefinition(node);
    if (isCase) meta.caseClass = true;

    if (mods.includes('sealed')) meta.sealed = true;
    if (mods.includes('abstract')) meta.abstract = true;
    if (mods.includes('final')) meta.final = true;
    if (mods.includes('implicit')) meta.implicit = true;
    if (mods.length > 0) meta.modifiers = mods;

    const inheritance = extractInheritance(node);
    if (inheritance.extends) meta.extends = inheritance.extends;
    if (inheritance.mixins) meta.mixins = inheritance.mixins;

    const typeParams = extractTypeParams(node);
    if (typeParams) meta.typeParams = typeParams;

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

    // Extract body members
    const body = this.findBody(node);
    if (body) {
      symbols.push(...extractMethods(body, filePath, name, symbolId, parts));
      symbols.push(...extractValVarMembers(body, filePath, name, symbolId, parts));
      symbols.push(...extractTypeAliases(body, filePath, name, symbolId, parts));

      // Recurse for nested classes/objects/traits
      this.walkNestedDefinitions(body, filePath, parts, symbols);
    }
  }

  private extractObject(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const parts = [...fqnParts, name];
    const symbolId = makeSymbolId(filePath, name, 'class');
    const meta: Record<string, unknown> = { object: true };

    // Detect case object
    const isCase = isCaseDefinition(node);
    if (isCase) meta.caseObject = true;

    const mods = extractModifiers(node);
    if (mods.includes('implicit')) meta.implicit = true;
    if (mods.length > 0) meta.modifiers = mods;

    const inheritance = extractInheritance(node);
    if (inheritance.extends) meta.extends = inheritance.extends;
    if (inheritance.mixins) meta.mixins = inheritance.mixins;

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

    // Extract body members
    const body = this.findBody(node);
    if (body) {
      symbols.push(...extractMethods(body, filePath, name, symbolId, parts));
      symbols.push(...extractValVarMembers(body, filePath, name, symbolId, parts));
      symbols.push(...extractTypeAliases(body, filePath, name, symbolId, parts));

      // Recurse for nested classes/objects/traits
      this.walkNestedDefinitions(body, filePath, parts, symbols);
    }
  }

  private extractTrait(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const parts = [...fqnParts, name];
    const symbolId = makeSymbolId(filePath, name, 'trait');
    const meta: Record<string, unknown> = {};
    const mods = extractModifiers(node);

    if (mods.includes('sealed')) meta.sealed = true;
    if (mods.length > 0) meta.modifiers = mods;

    const inheritance = extractInheritance(node);
    if (inheritance.extends) meta.extends = inheritance.extends;
    if (inheritance.mixins) meta.mixins = inheritance.mixins;

    const typeParams = extractTypeParams(node);
    if (typeParams) meta.typeParams = typeParams;

    symbols.push({
      symbolId,
      name,
      kind: 'trait',
      fqn: makeFqn(parts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Extract body members
    const body = this.findBody(node);
    if (body) {
      symbols.push(...extractMethods(body, filePath, name, symbolId, parts));
      symbols.push(...extractValVarMembers(body, filePath, name, symbolId, parts));
      symbols.push(...extractTypeAliases(body, filePath, name, symbolId, parts));

      // Recurse for nested classes/objects/traits
      this.walkNestedDefinitions(body, filePath, parts, symbols);
    }
  }

  private extractEnum(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const parts = [...fqnParts, name];
    const symbolId = makeSymbolId(filePath, name, 'enum');
    const meta: Record<string, unknown> = {};
    const mods = extractModifiers(node);

    if (mods.length > 0) meta.modifiers = mods;

    const inheritance = extractInheritance(node);
    if (inheritance.extends) meta.extends = inheritance.extends;
    if (inheritance.mixins) meta.mixins = inheritance.mixins;

    const typeParams = extractTypeParams(node);
    if (typeParams) meta.typeParams = typeParams;

    symbols.push({
      symbolId,
      name,
      kind: 'enum',
      fqn: makeFqn(parts),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Extract enum cases and other members from body
    const body = this.findBody(node);
    if (body) {
      symbols.push(...extractEnumCases(body, filePath, name, symbolId, parts));
      symbols.push(...extractMethods(body, filePath, name, symbolId, parts));
      symbols.push(...extractValVarMembers(body, filePath, name, symbolId, parts));
    }
  }

  private extractTopLevelFunction(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    const mods = extractModifiers(node);
    if (mods.includes('implicit')) meta.implicit = true;
    if (mods.includes('inline')) meta.inline = true;
    if (mods.length > 0) meta.modifiers = mods;

    const typeParams = extractTypeParams(node);
    if (typeParams) meta.typeParams = typeParams;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      fqn: makeFqn([...fqnParts, name]),
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractTopLevelVal(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    const name = extractValVarName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    const mods = extractModifiers(node);
    if (mods.includes('lazy')) meta.lazy = true;
    if (mods.includes('implicit')) meta.implicit = true;
    if (mods.length > 0) meta.modifiers = mods;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'constant'),
      name,
      kind: 'constant',
      fqn: makeFqn([...fqnParts, name]),
      signature: node.text.split('\n')[0].trim(),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractTopLevelVar(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    const name = extractValVarName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    const mods = extractModifiers(node);
    if (mods.length > 0) meta.modifiers = mods;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'variable'),
      name,
      kind: 'variable',
      fqn: makeFqn([...fqnParts, name]),
      signature: node.text.split('\n')[0].trim(),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractTopLevelType(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    const name = getNodeName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    const mods = extractModifiers(node);
    if (mods.includes('opaque')) meta.opaque = true;
    if (mods.length > 0) meta.modifiers = mods;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'type'),
      name,
      kind: 'type',
      fqn: makeFqn([...fqnParts, name]),
      signature: node.text.split('\n')[0].trim(),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  private extractGiven(
    node: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    // Scala 3 given definitions: `given intOrd: Ord[Int]` or anonymous `given Ord[Int]`
    const name = getNodeName(node);
    // Anonymous givens get a synthetic name from the first line
    const effectiveName =
      name ??
      node.text
        .split('\n')[0]
        .trim()
        .replace(/^given\s+/, '')
        .split(/[\s:(]/)[0] ??
      '<anonymous>';

    const meta: Record<string, unknown> = { given: true };

    symbols.push({
      symbolId: makeSymbolId(filePath, effectiveName, 'constant'),
      name: effectiveName,
      kind: 'constant',
      fqn: makeFqn([...fqnParts, effectiveName]),
      signature: node.text.split('\n')[0].trim(),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });
  }

  /** Find the template_body or body field of a class/object/trait/enum. */
  private findBody(node: TSNode): TSNode | null {
    // Try field name first
    const body = node.childForFieldName('body');
    if (body) return body;

    // Fallback: look for template_body or block child
    for (const child of node.namedChildren) {
      if (child.type === 'template_body' || child.type === 'block' || child.type === 'enum_body') {
        return child;
      }
    }
    return null;
  }

  /** Walk nested class/object/trait definitions inside a body. */
  private walkNestedDefinitions(
    body: TSNode,
    filePath: string,
    fqnParts: string[],
    symbols: RawSymbol[],
  ): void {
    for (const child of body.namedChildren) {
      switch (child.type) {
        case 'class_definition':
          this.extractClass(child, filePath, fqnParts, symbols);
          break;
        case 'object_definition':
          this.extractObject(child, filePath, fqnParts, symbols);
          break;
        case 'trait_definition':
          this.extractTrait(child, filePath, fqnParts, symbols);
          break;
        case 'enum_definition':
          this.extractEnum(child, filePath, fqnParts, symbols);
          break;
      }
    }
  }
}
