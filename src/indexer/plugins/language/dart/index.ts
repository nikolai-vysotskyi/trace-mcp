/**
 * Dart Language Plugin — tree-sitter-based symbol extraction with regex fallback.
 *
 * Primary path uses web-tree-sitter for full AST-based extraction.
 * Falls back to regex when the tree-sitter WASM grammar is unavailable
 * (e.g. ABI version mismatch).
 */
import { ok, err } from 'neverthrow';
import type {
  LanguagePlugin,
  PluginManifest,
  FileParseResult,
  RawSymbol,
  RawEdge,
  SymbolKind,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';
import { extractClassMembers } from './dart-members.js';
import {
  extractImportEdge,
  extractExportEdge,
  extractPartEdge,
  extractPartOfEdge,
} from './dart-edges.js';

/* ── Tree-sitter helpers ─────────────────────────────────────────────────── */

function makeSymbolId(filePath: string, name: string, kind: string, parent?: string): string {
  return parent ? `${filePath}::${parent}.${name}#${kind}` : `${filePath}::${name}#${kind}`;
}

function extractSignature(node: TSNode): string {
  return node.text.split('\n')[0].trim();
}

function getNodeName(node: TSNode): string | undefined {
  const id = node.childForFieldName('name');
  return id?.text;
}

/** Extract class modifiers (abstract, sealed, base, final, mixin) from surrounding context. */
function extractClassModifiers(node: TSNode): string[] {
  const mods: string[] = [];
  // Walk previous siblings to find modifier keywords
  let sib = node.previousSibling;
  while (sib) {
    const t = sib.type;
    if (t === 'abstract' || t === 'sealed' || t === 'base' || t === 'final' || t === 'mixin') {
      mods.unshift(t);
    } else if (sib.isNamed && t !== 'metadata' && t !== 'annotation') {
      break;
    }
    sib = sib.previousSibling;
  }
  // Fallback: parse from source text prefix
  if (mods.length === 0) {
    const text = node.text.trimStart();
    for (const m of ['abstract', 'sealed', 'base', 'final', 'mixin'] as const) {
      if (text.startsWith(m + ' ')) mods.push(m);
    }
  }
  return mods;
}

/** Detect Dart version features from the AST. */
function detectMinDartVersion(nodeTypes: Set<string>): string | undefined {
  if (nodeTypes.has('extension_type_declaration')) return '3.3';
  if (nodeTypes.has('nullable_type')) return '2.12';
  return undefined;
}

/** Collect all unique node types in the tree for version detection. */
function collectNodeTypes(root: TSNode): Set<string> {
  const types = new Set<string>();
  function walk(n: TSNode): void {
    types.add(n.type);
    for (const c of n.namedChildren) walk(c);
  }
  walk(root);
  return types;
}

/* ── Regex fallback helpers ──────────────────────────────────────────────── */

interface RegexSymbolPattern {
  kind: SymbolKind;
  pattern: RegExp;
  meta?: Record<string, unknown>;
}

const SYMBOL_PATTERNS: RegexSymbolPattern[] = [
  { kind: 'class', pattern: /^[ \t]*(?:(?:abstract|sealed|base|final|mixin)\s+)*class\s+(\w+)/gm },
  { kind: 'trait', pattern: /^[ \t]*(?:base\s+)?mixin\s+(?!class\b)(\w+)/gm, meta: { dartKind: 'mixin' } },
  { kind: 'class', pattern: /^[ \t]*extension\s+(\w+)\s+on\b/gm, meta: { dartKind: 'extension' } },
  { kind: 'class', pattern: /^[ \t]*extension\s+type\s+(\w+)/gm, meta: { dartKind: 'extension_type' } },
  { kind: 'enum', pattern: /^[ \t]*enum\s+(\w+)/gm },
  { kind: 'type', pattern: /^[ \t]*typedef\s+(?:\w+\s+)?(\w+)\s*[=(]/gm },
  { kind: 'function', pattern: /^[ \t]*(?:(?:static|external|abstract|override)\s+)*(?:(?:Future|Stream|FutureOr|Iterable|List|Map|Set)<[^>]*>\s+|(?:void|int|double|bool|String|num|dynamic|Object|Never|Null)\s+)(\w+)\s*(?:<[^>]*>)?\s*\(/gm },
  { kind: 'property', pattern: /^[ \t]*(?:(?:static|external|abstract|override)\s+)*(?:\w[\w<>,?\s]*\s+)?get\s+(\w+)/gm, meta: { dartKind: 'getter' } },
  { kind: 'property', pattern: /^[ \t]*(?:(?:static|external|abstract|override)\s+)*set\s+(\w+)\s*\(/gm, meta: { dartKind: 'setter' } },
  { kind: 'method', pattern: /^[ \t]*(?:const\s+)?factory\s+(\w+)(?:\.\w+)?\s*\(/gm, meta: { dartKind: 'factory' } },
  { kind: 'constant', pattern: /^[ \t]*(?:(?:static|external)\s+)?const\s+(?:[\w<>,?\s]+\s+)?(\w+)\s*=/gm },
  { kind: 'variable', pattern: /^[ \t]*(?:(?:static|late|external)\s+)*final\s+(?:[\w<>,?\s]+\s+)?(\w+)\s*[=;]/gm },
  { kind: 'variable', pattern: /^[ \t]*(?:(?:static|late)\s+)*var\s+(\w+)\s*[=;]/gm },
];

const IMPORT_PATTERNS = [
  /^[ \t]*import\s+'([^']+)'/gm,
  /^[ \t]*import\s+"([^"]+)"/gm,
  /^[ \t]*export\s+'([^']+)'/gm,
  /^[ \t]*part\s+(?:of\s+)?'([^']+)'/gm,
];

function extractWithRegex(filePath: string, source: string): FileParseResult {
  const symbols: RawSymbol[] = [];
  const edges: RawEdge[] = [];

  for (const sp of SYMBOL_PATTERNS) {
    sp.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = sp.pattern.exec(source)) !== null) {
      const name = m[1];
      const lineStart = source.substring(0, m.index).split('\n').length;
      symbols.push({
        symbolId: makeSymbolId(filePath, name, sp.kind),
        name,
        kind: sp.kind,
        signature: m[0].trim(),
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart,
        lineEnd: lineStart,
        metadata: sp.meta ? { ...sp.meta } : undefined,
      });
    }
  }

  for (const pat of IMPORT_PATTERNS) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(source)) !== null) {
      edges.push({
        edgeType: 'imports',
        metadata: { module: m[1] },
      });
    }
  }

  return {
    language: 'dart',
    status: 'ok',
    symbols,
    edges: edges.length > 0 ? edges : undefined,
  };
}

/* ── Plugin ──────────────────────────────────────────────────────────────── */

export class DartLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'dart-language',
    version: '2.0.0',
    priority: 5,
  };

  supportedExtensions = ['.dart'];
  supportedVersions = [
    '1.0', '2.0', '2.12', '2.17', '2.19',
    '3.0', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7',
  ];

  /** Cache to avoid retrying tree-sitter init when the WASM is incompatible. */
  private treeSitterAvailable: boolean | undefined;

  async extractSymbols(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    const sourceCode = content.toString('utf-8');

    // Try tree-sitter first
    if (this.treeSitterAvailable !== false) {
      try {
        const result = await this.extractWithTreeSitter(filePath, sourceCode);
        this.treeSitterAvailable = true;
        return result;
      } catch {
        // Tree-sitter unavailable (WASM ABI mismatch, missing grammar, etc.)
        // Fall through to regex path.
        this.treeSitterAvailable = false;
      }
    }

    // Regex fallback
    try {
      return ok(extractWithRegex(filePath, sourceCode));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `Dart parse failed: ${msg}`));
    }
  }

  /* ── Tree-sitter extraction ─────────────────────────────────────────── */

  private async extractWithTreeSitter(
    filePath: string,
    sourceCode: string,
  ): Promise<TraceMcpResult<FileParseResult>> {
    const parser = await getParser('dart');
    const tree = parser.parse(sourceCode);
    const root: TSNode = tree.rootNode;

    const hasError = root.hasError;
    const symbols: RawSymbol[] = [];
    const edges: RawEdge[] = [];
    const warnings: string[] = [];

    if (hasError) {
      warnings.push('Source contains syntax errors; extraction may be incomplete');
    }

    this.walkTopLevel(root, filePath, symbols, edges);

    const nodeTypes = collectNodeTypes(root);
    const metadata: Record<string, unknown> = {};
    const minDartVer = detectMinDartVersion(nodeTypes);
    if (minDartVer) metadata.minDartVersion = minDartVer;

    return ok({
      language: 'dart',
      status: hasError ? 'partial' : 'ok',
      symbols,
      edges: edges.length > 0 ? edges : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  /* ── Top-level walk ──────────────────────────────────────────────────── */

  private walkTopLevel(
    root: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
  ): void {
    for (const node of root.namedChildren) {
      switch (node.type) {
        case 'class_definition':
          this.extractClass(node, filePath, symbols);
          break;
        case 'mixin_declaration':
          this.extractMixin(node, filePath, symbols);
          break;
        case 'extension_declaration':
          this.extractExtension(node, filePath, symbols);
          break;
        case 'extension_type_declaration':
          this.extractExtensionType(node, filePath, symbols);
          break;
        case 'enum_declaration':
          this.extractEnum(node, filePath, symbols);
          break;
        case 'type_alias':
          this.extractTypedef(node, filePath, symbols);
          break;
        case 'function_signature':
        case 'function_definition':
          this.extractTopLevelFunction(node, filePath, symbols);
          break;
        case 'getter_signature':
          this.extractTopLevelGetter(node, filePath, symbols);
          break;
        case 'setter_signature':
          this.extractTopLevelSetter(node, filePath, symbols);
          break;
        case 'import_specification':
        case 'import_directive':
          extractImportEdge(node, edges);
          break;
        case 'export_specification':
        case 'export_directive':
          extractExportEdge(node, edges);
          break;
        case 'part_directive':
          extractPartEdge(node, edges);
          break;
        case 'part_of_directive':
          extractPartOfEdge(node, edges);
          break;
        case 'declaration':
          this.extractDeclarationNode(node, filePath, symbols);
          break;
        case 'constant_declaration':
        case 'initialized_variable_definition':
          this.extractTopLevelVarOrConst(node, filePath, symbols);
          break;
        case 'top_level_definition':
          this.extractTopLevelDefinition(node, filePath, symbols, edges);
          break;
        default:
          this.extractDeclarationNode(node, filePath, symbols);
          break;
      }
    }
  }

  /** Handle `top_level_definition` wrappers that some grammar versions use. */
  private extractTopLevelDefinition(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
  ): void {
    for (const child of node.namedChildren) {
      switch (child.type) {
        case 'class_definition':
          this.extractClass(child, filePath, symbols);
          break;
        case 'mixin_declaration':
          this.extractMixin(child, filePath, symbols);
          break;
        case 'enum_declaration':
          this.extractEnum(child, filePath, symbols);
          break;
        case 'extension_declaration':
          this.extractExtension(child, filePath, symbols);
          break;
        case 'extension_type_declaration':
          this.extractExtensionType(child, filePath, symbols);
          break;
        case 'type_alias':
          this.extractTypedef(child, filePath, symbols);
          break;
        case 'function_signature':
        case 'function_definition':
          this.extractTopLevelFunction(child, filePath, symbols);
          break;
        case 'getter_signature':
          this.extractTopLevelGetter(child, filePath, symbols);
          break;
        case 'setter_signature':
          this.extractTopLevelSetter(child, filePath, symbols);
          break;
        case 'import_specification':
        case 'import_directive':
          extractImportEdge(child, edges);
          break;
        case 'export_specification':
        case 'export_directive':
          extractExportEdge(child, edges);
          break;
        case 'part_directive':
          extractPartEdge(child, edges);
          break;
        default:
          this.extractDeclarationNode(child, filePath, symbols);
          break;
      }
    }
  }

  /** Try to extract symbols from a generic declaration node. */
  private extractDeclarationNode(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
  ): void {
    const text = node.text.trimStart();

    if (text.startsWith('const ') || text.match(/^(?:static\s+)?const\s/)) {
      this.extractTopLevelVarOrConst(node, filePath, symbols, 'constant');
      return;
    }
    if (text.match(/^(?:static\s+|late\s+)*final\s/)) {
      this.extractTopLevelVarOrConst(node, filePath, symbols, 'variable');
      return;
    }
    if (text.startsWith('var ') || text.match(/^(?:static\s+|late\s+)*var\s/)) {
      this.extractTopLevelVarOrConst(node, filePath, symbols, 'variable');
      return;
    }

    for (const child of node.namedChildren) {
      switch (child.type) {
        case 'function_signature':
        case 'function_definition':
          this.extractTopLevelFunction(child, filePath, symbols);
          break;
        case 'class_definition':
          this.extractClass(child, filePath, symbols);
          break;
        case 'constant_declaration':
        case 'initialized_variable_definition':
          this.extractTopLevelVarOrConst(child, filePath, symbols);
          break;
      }
    }
  }

  /* ── Classes ─────────────────────────────────────────────────────────── */

  private extractClass(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'class');
    const mods = extractClassModifiers(node);
    const meta: Record<string, unknown> = {};
    if (mods.length > 0) meta.modifiers = mods;

    // Superclass
    const superclass = node.childForFieldName('superclass');
    if (superclass) {
      const superName = superclass.text.replace(/^extends\s+/, '').trim().split(/[\s<{]/, 1)[0];
      if (superName) meta.extends = superName;
    }

    // Interfaces (implements clause)
    const interfaces = node.childForFieldName('interfaces');
    if (interfaces) {
      const implText = interfaces.text.replace(/^implements\s+/, '').trim();
      const impls = implText.split(',').map(s => s.trim().split(/[\s<]/, 1)[0]).filter(Boolean);
      if (impls.length > 0) meta.implements = impls;
    }

    // Mixins (with clause)
    const withClause = this.findChildByType(node, 'mixins');
    if (withClause) {
      const withText = withClause.text.replace(/^with\s+/, '').trim();
      const mixins = withText.split(',').map(s => s.trim().split(/[\s<]/, 1)[0]).filter(Boolean);
      if (mixins.length > 0) meta.mixins = mixins;
    }

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });

    const body = this.findChildByType(node, 'class_body');
    if (body) {
      extractClassMembers(body, filePath, name, symbolId, symbols);
    }
  }

  /* ── Mixins ──────────────────────────────────────────────────────────── */

  private extractMixin(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'trait');
    const meta: Record<string, unknown> = { dartKind: 'mixin' };

    const onClause = this.findChildByType(node, 'on_clause', 'superclass');
    if (onClause) {
      const onText = onClause.text.replace(/^on\s+/, '').trim();
      const bases = onText.split(',').map(s => s.trim().split(/[\s<]/, 1)[0]).filter(Boolean);
      if (bases.length > 0) meta.on = bases;
    }

    symbols.push({
      symbolId,
      name,
      kind: 'trait',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });

    const body = this.findChildByType(node, 'class_body', 'mixin_body');
    if (body) {
      extractClassMembers(body, filePath, name, symbolId, symbols);
    }
  }

  /* ── Extensions ──────────────────────────────────────────────────────── */

  private extractExtension(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'class');
    const meta: Record<string, unknown> = { dartKind: 'extension' };

    const onType = this.findChildByType(node, 'type_identifier', 'on_type');
    if (onType) {
      meta.on = onType.text.trim();
    }

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });

    const body = this.findChildByType(node, 'extension_body', 'class_body');
    if (body) {
      extractClassMembers(body, filePath, name, symbolId, symbols);
    }
  }

  /* ── Extension Types (Dart 3.3+) ────────────────────────────────────── */

  private extractExtensionType(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'class');
    const meta: Record<string, unknown> = { dartKind: 'extension_type' };

    symbols.push({
      symbolId,
      name,
      kind: 'class',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: meta,
    });

    const body = this.findChildByType(node, 'extension_type_body', 'class_body');
    if (body) {
      extractClassMembers(body, filePath, name, symbolId, symbols);
    }
  }

  /* ── Enums ───────────────────────────────────────────────────────────── */

  private extractEnum(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const symbolId = makeSymbolId(filePath, name, 'enum');

    symbols.push({
      symbolId,
      name,
      kind: 'enum',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });

    const body = this.findChildByType(node, 'enum_body');
    if (body) {
      for (const child of body.namedChildren) {
        if (child.type === 'enum_constant') {
          const constName = getNodeName(child) ?? child.text.split(/[\s(,;{]/, 1)[0]?.trim();
          if (constName) {
            symbols.push({
              symbolId: makeSymbolId(filePath, constName, 'enum_case', name),
              name: constName,
              kind: 'enum_case',
              parentSymbolId: symbolId,
              byteStart: child.startIndex,
              byteEnd: child.endIndex,
              lineStart: child.startPosition.row + 1,
              lineEnd: child.endPosition.row + 1,
            });
          }
        }
      }
      extractClassMembers(body, filePath, name, symbolId, symbols);
    }
  }

  /* ── Typedefs ────────────────────────────────────────────────────────── */

  private extractTypedef(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'type'),
      name,
      kind: 'type',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

  /* ── Top-level functions ─────────────────────────────────────────────── */

  private extractTopLevelFunction(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node);
    if (!name) return;

    const meta: Record<string, unknown> = {};
    const text = node.text.trimStart();
    if (text.startsWith('async') || text.includes(' async ')) meta.async = true;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
    });
  }

  /* ── Top-level getters / setters ─────────────────────────────────────── */

  private extractTopLevelGetter(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node) ?? this.extractGetterName(node);
    if (!name) return;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'property'),
      name,
      kind: 'property',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { dartKind: 'getter' },
    });
  }

  private extractTopLevelSetter(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const name = getNodeName(node) ?? this.extractSetterName(node);
    if (!name) return;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, 'property'),
      name,
      kind: 'property',
      signature: extractSignature(node),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { dartKind: 'setter' },
    });
  }

  /* ── Top-level const / final / var ──────────────────────────────────── */

  private extractTopLevelVarOrConst(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    forceKind?: SymbolKind,
  ): void {
    const text = node.text.trimStart();
    let kind: SymbolKind;

    if (forceKind) {
      kind = forceKind;
    } else if (text.match(/^(?:static\s+)?const\s/) || text.startsWith('const ')) {
      kind = 'constant';
    } else if (text.match(/^(?:static\s+|late\s+)*final\s/)) {
      kind = 'variable';
    } else {
      kind = 'variable';
    }

    let name = getNodeName(node);

    if (!name) {
      const m = text.match(
        /^(?:(?:static|late|external|const|final|var)\s+)*(?:[\w<>,?\s]+\s+)?(\w+)\s*[=;]/,
      );
      name = m?.[1];
    }

    if (!name) {
      for (const child of node.namedChildren) {
        if (child.type === 'identifier') {
          name = child.text;
          break;
        }
        if (child.type === 'initialized_identifier') {
          const id = child.childForFieldName('name') ?? child.namedChildren[0];
          name = id?.text;
          break;
        }
      }
    }

    if (!name) return;

    symbols.push({
      symbolId: makeSymbolId(filePath, name, kind),
      name,
      kind,
      signature: text.split('\n')[0].trim().slice(0, 120),
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
    });
  }

}
