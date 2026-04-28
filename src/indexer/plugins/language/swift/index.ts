/**
 * Swift Language Plugin — tree-sitter-based symbol extraction.
 *
 * Uses the alex-pinkus/tree-sitter-swift grammar (via tree-sitter-wasms).
 *
 * Key grammar quirks:
 * - Enums, structs, and extensions all use `class_declaration` with different
 *   leading keywords (enum/struct/extension/class). Differentiated by the
 *   anonymous keyword child.
 * - Enum bodies are `enum_class_body`; everything else uses `class_body`.
 * - Protocol functions use `protocol_function_declaration`.
 * - Property names live under `pattern > simple_identifier`.
 * - Function names are `simple_identifier` children.
 * - Modifiers are grouped under a `modifiers` node containing
 *   `visibility_modifier`, `inheritance_modifier`, `member_modifier`,
 *   `mutation_modifier`, and `attribute` children.
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
  SymbolKind,
} from '../../../../plugin-api/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSymbolId(filePath: string, name: string, kind: string, parentName?: string): string {
  if (parentName) return `${filePath}::${parentName}::${name}#${kind}`;
  return `${filePath}::${name}#${kind}`;
}

function makeFqn(parts: string[]): string {
  return parts.filter(Boolean).join('.');
}

function extractSignature(node: TSNode): string {
  return node.text.split('\n')[0].trim();
}

/**
 * Resolve the name of a declaration node.
 *
 * For classes, structs, enums: the first `type_identifier` child.
 * For functions: the first `simple_identifier` child.
 * For extensions: the first `user_type` child (whose text is the extended type).
 * For typealiases / associatedtypes: `type_identifier` child.
 */
function getDeclarationName(node: TSNode): string | undefined {
  const type = node.type;

  // Functions and protocol functions: name is always simple_identifier
  if (type === 'function_declaration' || type === 'protocol_function_declaration') {
    for (const child of node.namedChildren) {
      if (child.type === 'simple_identifier') return child.text;
    }
    return undefined;
  }

  // For type declarations: type_identifier is the name
  for (const child of node.namedChildren) {
    if (child.type === 'type_identifier') return child.text;
  }

  // Extensions use user_type for the extended type name
  for (const child of node.namedChildren) {
    if (child.type === 'user_type') return child.text;
  }

  // Fallback
  for (const child of node.namedChildren) {
    if (child.type === 'simple_identifier') return child.text;
  }
  return undefined;
}

/**
 * Detect which Swift keyword introduced a `class_declaration`.
 * Returns 'class' | 'struct' | 'enum' | 'extension'.
 */
function detectClassKeyword(node: TSNode): 'class' | 'struct' | 'enum' | 'extension' {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.isNamed) continue; // skip named children
    const text = child.type; // anonymous nodes use their text as type
    if (text === 'struct') return 'struct';
    if (text === 'enum') return 'enum';
    if (text === 'extension') return 'extension';
    if (text === 'class') return 'class';
  }
  return 'class';
}

/**
 * Extract all modifier texts from a declaration's `modifiers` node.
 */
function extractModifierTexts(node: TSNode): string[] {
  const mods: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'modifiers') {
      for (const sub of child.namedChildren) {
        mods.push(sub.text);
      }
    }
  }
  return mods;
}

/**
 * Extract visibility from modifiers.
 */
function extractVisibility(mods: string[]): string | undefined {
  for (const m of mods) {
    if (['open', 'public', 'internal', 'fileprivate', 'private'].includes(m)) return m;
  }
  return undefined;
}

/**
 * Extract inheritance specifiers from a declaration node.
 */
function extractInheritance(node: TSNode): string[] {
  const types: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'inheritance_specifier') {
      // Collect the type text
      types.push(child.text.trim());
    }
  }
  return types;
}

/**
 * Find the body node of a declaration.
 */
function findBody(node: TSNode): TSNode | undefined {
  for (const child of node.namedChildren) {
    if (
      child.type === 'class_body' ||
      child.type === 'enum_class_body' ||
      child.type === 'protocol_body' ||
      child.type.endsWith('_body')
    ) {
      return child;
    }
  }
  return undefined;
}

/**
 * Extract the binding name from a property_declaration node.
 * The pattern is: property_declaration > pattern > simple_identifier
 * Or sometimes: property_declaration > value_binding_pattern ... > pattern > simple_identifier
 */
function extractPropertyName(node: TSNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'pattern') {
      const id = child.namedChildren.find((c) => c.type === 'simple_identifier');
      return id?.text ?? child.text;
    }
  }
  // Fallback: regex from first line
  const match = node.text.match(/(?:let|var)\s+(\w+)/);
  return match?.[1];
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export class SwiftLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'swift-language',
    version: '1.0.0',
    priority: 5,
  };

  supportedExtensions = ['.swift'];
  supportedVersions = [
    '5.0',
    '5.1',
    '5.2',
    '5.3',
    '5.4',
    '5.5',
    '5.6',
    '5.7',
    '5.8',
    '5.9',
    '5.10',
    '6.0',
  ];

  async extractSymbols(
    filePath: string,
    content: Buffer,
  ): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('swift');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const warnings: string[] = [];

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      for (const child of root.namedChildren) {
        this.extractNode(child, filePath, symbols, edges, undefined, undefined);
      }

      return ok({
        language: 'swift',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Swift parse failed: ${msg}`));
    }
  }

  // ── Recursive node dispatcher ──────────────────────────────────────────

  private extractNode(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    const type = node.type;

    if (type === 'import_declaration') {
      this.extractImport(node, edges);
      return;
    }

    // class_declaration covers class, struct, enum, extension
    if (type === 'class_declaration') {
      this.extractClassDeclaration(node, filePath, symbols, edges, parentName, parentSymbolId);
      return;
    }

    if (type === 'protocol_declaration') {
      this.extractProtocol(node, filePath, symbols, edges, parentName, parentSymbolId);
      return;
    }

    if (type === 'function_declaration') {
      this.extractFunction(node, filePath, symbols, parentName, parentSymbolId);
      return;
    }

    if (type === 'protocol_function_declaration') {
      this.extractFunction(node, filePath, symbols, parentName, parentSymbolId);
      return;
    }

    if (type === 'init_declaration') {
      this.extractInit(node, filePath, symbols, parentName, parentSymbolId);
      return;
    }

    if (type === 'deinit_declaration') {
      this.extractDeinit(node, filePath, symbols, parentName, parentSymbolId);
      return;
    }

    if (type === 'subscript_declaration') {
      this.extractSubscript(node, filePath, symbols, parentName, parentSymbolId);
      return;
    }

    if (type === 'typealias_declaration') {
      this.extractTypealias(node, filePath, symbols, parentName, parentSymbolId);
      return;
    }

    if (type === 'associatedtype_declaration') {
      this.extractAssociatedType(node, filePath, symbols, parentName, parentSymbolId);
      return;
    }

    if (type === 'property_declaration') {
      this.extractProperty(node, filePath, symbols, parentName, parentSymbolId);
      return;
    }

    if (type === 'enum_entry') {
      this.extractEnumCase(node, filePath, symbols, parentName, parentSymbolId);
      return;
    }

    // Recurse into unknown named nodes
    for (const child of node.namedChildren) {
      this.extractNode(child, filePath, symbols, edges, parentName, parentSymbolId);
    }
  }

  // ── Import ─────────────────────────────────────────────────────────────

  private extractImport(node: TSNode, edges: RawEdge[]): void {
    const text = node.text.trim();
    const match = text.match(
      /^import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([\w.]+)/,
    );
    if (match) {
      edges.push({
        edgeType: 'imports',
        metadata: { module: match[1] },
      });
    }
  }

  // ── class_declaration (class | struct | enum | extension) ──────────────

  private extractClassDeclaration(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    const keyword = detectClassKeyword(node);
    const name = getDeclarationName(node);
    if (!name) return;

    const mods = extractModifierTexts(node);

    let kind: SymbolKind;
    const meta: Record<string, unknown> = {};

    switch (keyword) {
      case 'enum':
        kind = 'enum';
        break;
      case 'struct':
        kind = 'class';
        meta.swiftKind = 'struct';
        break;
      case 'extension':
        kind = 'class';
        meta.swiftKind = 'extension';
        break;
      default:
        kind = 'class';
        break;
    }

    const vis = extractVisibility(mods);
    if (vis) meta.visibility = vis;

    const modKeywords = mods.filter((m) => ['final', 'open', 'indirect'].includes(m));
    if (modKeywords.length > 0) meta.modifiers = modKeywords;

    const heritage = extractInheritance(node);
    if (heritage.length > 0) {
      meta.extends = heritage[0];
      if (heritage.length > 1) meta.implements = heritage.slice(1);
    }

    const symbolId = makeSymbolId(filePath, name, kind, parentName);
    const fqnParts = parentName ? [parentName, name] : [name];

    symbols.push({
      symbolId,
      name,
      kind,
      fqn: makeFqn(fqnParts),
      parentSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    // Walk body for nested members
    const body = findBody(node);
    if (body) {
      for (const child of body.namedChildren) {
        this.extractNode(child, filePath, symbols, edges, name, symbolId);
      }
    }
  }

  // ── Protocol ───────────────────────────────────────────────────────────

  private extractProtocol(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    const name = getDeclarationName(node);
    if (!name) return;

    const mods = extractModifierTexts(node);
    const meta: Record<string, unknown> = { swiftKind: 'protocol' };

    const vis = extractVisibility(mods);
    if (vis) meta.visibility = vis;

    const heritage = extractInheritance(node);
    if (heritage.length > 0) meta.extends = heritage;

    const symbolId = makeSymbolId(filePath, name, 'interface', parentName);
    const fqnParts = parentName ? [parentName, name] : [name];

    symbols.push({
      symbolId,
      name,
      kind: 'interface',
      fqn: makeFqn(fqnParts),
      parentSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });

    // Walk protocol body
    const body = findBody(node);
    if (body) {
      for (const child of body.namedChildren) {
        this.extractNode(child, filePath, symbols, edges, name, symbolId);
      }
    }
  }

  // ── Function / protocol_function_declaration ───────────────────────────

  private extractFunction(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    const name = getDeclarationName(node);
    if (!name) return;

    const kind: SymbolKind = parentName ? 'method' : 'function';
    const mods = extractModifierTexts(node);
    const meta: Record<string, unknown> = {};

    const vis = extractVisibility(mods);
    if (vis) meta.visibility = vis;
    if (mods.some((m) => m === 'static' || m === 'class')) meta.static = true;
    if (mods.some((m) => m === 'override')) meta.override = true;
    if (mods.some((m) => m === 'mutating')) meta.mutating = true;

    const fqnParts = parentName ? [parentName, name] : [name];

    symbols.push({
      symbolId: makeSymbolId(filePath, name, kind, parentName),
      name,
      kind,
      fqn: makeFqn(fqnParts),
      parentSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────

  private extractInit(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    const meta: Record<string, unknown> = { swiftKind: 'initializer' };
    const mods = extractModifierTexts(node);

    const vis = extractVisibility(mods);
    if (vis) meta.visibility = vis;
    if (mods.some((m) => m === 'convenience')) meta.convenience = true;
    if (mods.some((m) => m === 'required')) meta.required = true;

    const line = node.startPosition.row + 1;
    const uniqueName = parentName ? `init_L${line}` : 'init';

    symbols.push({
      symbolId: makeSymbolId(filePath, uniqueName, 'method', parentName),
      name: 'init',
      kind: 'method',
      fqn: makeFqn(parentName ? [parentName, 'init'] : ['init']),
      parentSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: line,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });
  }

  // ── Deinit ─────────────────────────────────────────────────────────────

  private extractDeinit(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    symbols.push({
      symbolId: makeSymbolId(filePath, 'deinit', 'method', parentName),
      name: 'deinit',
      kind: 'method',
      fqn: makeFqn(parentName ? [parentName, 'deinit'] : ['deinit']),
      parentSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { swiftKind: 'deinitializer' },
    });
  }

  // ── Subscript ──────────────────────────────────────────────────────────

  private extractSubscript(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    const line = node.startPosition.row + 1;
    const mods = extractModifierTexts(node);
    const meta: Record<string, unknown> = { swiftKind: 'subscript' };

    const vis = extractVisibility(mods);
    if (vis) meta.visibility = vis;
    if (mods.some((m) => m === 'static' || m === 'class')) meta.static = true;

    symbols.push({
      symbolId: makeSymbolId(filePath, `subscript_L${line}`, 'method', parentName),
      name: 'subscript',
      kind: 'method',
      fqn: makeFqn(parentName ? [parentName, 'subscript'] : ['subscript']),
      parentSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: line,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });
  }

  // ── Typealias ──────────────────────────────────────────────────────────

  private extractTypealias(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    const name = getDeclarationName(node);
    if (!name) return;

    const mods = extractModifierTexts(node);
    const meta: Record<string, unknown> = {};
    const vis = extractVisibility(mods);
    if (vis) meta.visibility = vis;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'type', parentName),
      name,
      kind: 'type',
      fqn: makeFqn(parentName ? [parentName, name] : [name]),
      parentSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  // ── Associated type (protocol members) ─────────────────────────────────

  private extractAssociatedType(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    const name = getDeclarationName(node);
    if (!name) return;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'type', parentName),
      name,
      kind: 'type',
      fqn: makeFqn(parentName ? [parentName, name] : [name]),
      parentSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { swiftKind: 'associatedtype' },
    });
  }

  // ── Property (let / var) ───────────────────────────────────────────────

  private extractProperty(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    const name = extractPropertyName(node);
    if (!name) return;

    // Determine let vs var from the value_binding_pattern
    const firstLine = node.text.split('\n')[0];
    const isLet = /\blet\b/.test(firstLine);
    const isInsideContainer = !!parentName;

    let kind: SymbolKind;
    if (isInsideContainer) {
      kind = 'property';
    } else {
      kind = isLet ? 'constant' : 'variable';
    }

    const mods = extractModifierTexts(node);
    const meta: Record<string, unknown> = {};

    const vis = extractVisibility(mods);
    if (vis) meta.visibility = vis;
    if (mods.some((m) => m === 'static' || m === 'class')) meta.static = true;
    if (mods.some((m) => m === 'lazy')) meta.lazy = true;
    if (mods.some((m) => m === 'weak')) meta.weak = true;
    if (mods.some((m) => m === 'unowned')) meta.unowned = true;
    if (mods.some((m) => m === 'override')) meta.override = true;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, kind, parentName),
      name,
      kind,
      fqn: makeFqn(parentName ? [parentName, name] : [name]),
      parentSymbolId,
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  // ── Enum case (enum_entry) ─────────────────────────────────────────────

  private extractEnumCase(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    parentName: string | undefined,
    parentSymbolId: string | undefined,
  ): void {
    // enum_entry has simple_identifier children for case names
    const caseNames: string[] = [];

    for (const child of node.namedChildren) {
      if (child.type === 'simple_identifier') {
        caseNames.push(child.text);
      }
    }

    // Fallback: regex
    if (caseNames.length === 0) {
      const match = node.text.match(/case\s+(\w+)/);
      if (match) caseNames.push(match[1]);
    }

    for (const name of caseNames) {
      symbols.push({
        symbolId: makeSymbolId(filePath, name, 'enum_case', parentName),
        name,
        kind: 'enum_case',
        fqn: makeFqn(parentName ? [parentName, name] : [name]),
        parentSymbolId,
        signature: `case ${name}`,
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
      });
    }
  }
}
