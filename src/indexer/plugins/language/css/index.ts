/**
 * CSS/SCSS/SASS/LESS/Stylus Language Plugin — tree-sitter for CSS, regex for preprocessors.
 *
 * Extracts: CSS custom properties (variables), class selectors, ID selectors,
 * @import/@use/@forward edges, @mixin definitions, @keyframes, @font-face,
 * and preprocessor variables ($var in SCSS/SASS, @var in LESS).
 *
 * For .css files: uses tree-sitter-css for accurate AST-based extraction.
 * For preprocessor files (.scss, .sass, .less, .styl, .stylus): regex fallback
 * since tree-sitter-css only handles pure CSS syntax.
 */
import { ok, err } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { parseError } from '../../../../errors.js';
import { getParser, type TSNode } from '../../../../parser/tree-sitter.js';

export class CssLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'css-language',
    version: '2.0.0',
    priority: 6,
  };

  supportedExtensions = ['.css', '.scss', '.sass', '.less', '.styl', '.stylus'];

  async extractSymbols(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    if (ext === '.css') {
      return this.extractWithTreeSitter(filePath, content);
    }
    return this.extractWithRegex(filePath, content, ext);
  }

  // ---------------------------------------------------------------------------
  // tree-sitter path (pure CSS only)
  // ---------------------------------------------------------------------------

  private async extractWithTreeSitter(filePath: string, content: Buffer): Promise<TraceMcpResult<FileParseResult>> {
    try {
      const parser = await getParser('css');
      const sourceCode = content.toString('utf-8');
      const tree = parser.parse(sourceCode);
      const root: TSNode = tree.rootNode;

      const hasError = root.hasError;
      const symbols: RawSymbol[] = [];
      const edges: RawEdge[] = [];
      const warnings: string[] = [];

      const seenVars = new Set<string>();
      const seenClasses = new Set<string>();
      const seenIds = new Set<string>();

      if (hasError) {
        warnings.push('Source contains syntax errors; extraction may be incomplete');
      }

      this.walkTreeSitter(root, filePath, symbols, edges, seenVars, seenClasses, seenIds);

      return ok({
        language: 'css',
        status: hasError ? 'partial' : 'ok',
        symbols,
        edges: edges.length > 0 ? edges : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(parseError(filePath, `CSS tree-sitter parse failed: ${msg}`));
    }
  }

  /** Recursively walk tree-sitter CSS nodes. */
  private walkTreeSitter(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    seenVars: Set<string>,
    seenClasses: Set<string>,
    seenIds: Set<string>,
  ): void {
    for (const child of node.namedChildren) {
      switch (child.type) {
        case 'import_statement':
          this.extractTsImport(child, edges);
          break;

        case 'rule_set':
          this.extractTsRuleSet(child, filePath, symbols, edges, seenVars, seenClasses, seenIds);
          break;

        case 'keyframes_statement':
          this.extractTsKeyframes(child, filePath, symbols);
          break;

        case 'at_rule': {
          // @font-face is parsed as a generic at_rule with an at_keyword child
          const keyword = child.namedChildren.find(c => c.type === 'at_keyword') ?? child.namedChildren[0];
          if (keyword && (keyword.text === '@font-face' || keyword.text === 'font-face')) {
            this.extractTsFontFace(child, filePath, symbols);
          }
          break;
        }

        case 'declaration':
          this.extractTsDeclaration(child, filePath, symbols, seenVars);
          break;

        default:
          // Recurse into other container nodes (e.g. media_statement)
          if (child.namedChildCount > 0) {
            this.walkTreeSitter(child, filePath, symbols, edges, seenVars, seenClasses, seenIds);
          }
          break;
      }
    }
  }

  /** Extract @import url("...") or @import "..." edges. */
  private extractTsImport(node: TSNode, edges: RawEdge[]): void {
    // The import target can be a call_expression (url(...)) or a string_value
    for (const child of node.namedChildren) {
      if (child.type === 'string_value' || child.type === 'string_content') {
        edges.push({
          edgeType: 'imports',
          metadata: { from: stripQuotes(child.text), kind: 'stylesheet' },
        });
        return;
      }
      if (child.type === 'call_expression') {
        // url("path")
        const arg = child.namedChildren.find(
          c => c.type === 'arguments' || c.type === 'string_value',
        );
        if (arg) {
          const strNode = arg.type === 'string_value'
            ? arg
            : arg.namedChildren.find(c => c.type === 'string_value');
          if (strNode) {
            edges.push({
              edgeType: 'imports',
              metadata: { from: stripQuotes(strNode.text), kind: 'stylesheet' },
            });
            return;
          }
        }
      }
    }

    // Fallback: extract from raw text
    const raw = node.text;
    const m = raw.match(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/);
    if (m) {
      edges.push({
        edgeType: 'imports',
        metadata: { from: m[1], kind: 'stylesheet' },
      });
    }
  }

  /** Extract selectors and declarations from a rule_set. */
  private extractTsRuleSet(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    edges: RawEdge[],
    seenVars: Set<string>,
    seenClasses: Set<string>,
    seenIds: Set<string>,
  ): void {
    // Walk selectors
    const selectors = node.childForFieldName('selectors') ?? node.namedChildren.find(c => c.type === 'selectors');
    if (selectors) {
      this.extractTsSelectors(selectors, filePath, symbols, seenClasses, seenIds, node);
    }

    // Walk block for declarations (custom properties) and nested rules
    const block = node.childForFieldName('block') ?? node.namedChildren.find(c => c.type === 'block');
    if (block) {
      for (const child of block.namedChildren) {
        if (child.type === 'declaration') {
          this.extractTsDeclaration(child, filePath, symbols, seenVars);
        } else if (child.type === 'rule_set') {
          // Nested rules (CSS nesting)
          this.extractTsRuleSet(child, filePath, symbols, edges, seenVars, seenClasses, seenIds);
        }
      }
    }
  }

  /** Recursively extract class and ID selectors from a selectors node. */
  private extractTsSelectors(
    node: TSNode,
    filePath: string,
    symbols: RawSymbol[],
    seenClasses: Set<string>,
    seenIds: Set<string>,
    ruleNode: TSNode,
  ): void {
    for (const child of node.children) {
      switch (child.type) {
        case 'class_selector': {
          const nameNode = child.namedChildren.find(c => c.type === 'class_name') ?? child.childForFieldName('name');
          const name = nameNode ? nameNode.text : child.text.replace(/^\./, '');
          if (!seenClasses.has(name)) {
            seenClasses.add(name);
            symbols.push({
              symbolId: `${filePath}::.${name}#variable`,
              name: `.${name}`,
              kind: 'variable',
              byteStart: ruleNode.startIndex,
              byteEnd: ruleNode.endIndex,
              lineStart: ruleNode.startPosition.row + 1,
              lineEnd: ruleNode.endPosition.row + 1,
              metadata: { cssClass: true },
            });
          }
          // Recurse into child selectors (compound selectors)
          this.extractTsSelectors(child, filePath, symbols, seenClasses, seenIds, ruleNode);
          break;
        }

        case 'id_selector': {
          const nameNode = child.namedChildren.find(c => c.type === 'id_name') ?? child.childForFieldName('name');
          const name = nameNode ? nameNode.text : child.text.replace(/^#/, '');
          if (!seenIds.has(name)) {
            seenIds.add(name);
            symbols.push({
              symbolId: `${filePath}::#${name}#variable`,
              name: `#${name}`,
              kind: 'variable',
              byteStart: ruleNode.startIndex,
              byteEnd: ruleNode.endIndex,
              lineStart: ruleNode.startPosition.row + 1,
              lineEnd: ruleNode.endPosition.row + 1,
              metadata: { cssId: true },
            });
          }
          // Recurse into child selectors
          this.extractTsSelectors(child, filePath, symbols, seenClasses, seenIds, ruleNode);
          break;
        }

        default:
          // Recurse into compound selectors, pseudo selectors, etc.
          if (child.namedChildCount > 0 || child.childCount > 1) {
            this.extractTsSelectors(child, filePath, symbols, seenClasses, seenIds, ruleNode);
          }
          break;
      }
    }
  }

  /** Extract CSS custom property (--var-name) from a declaration node. */
  private extractTsDeclaration(node: TSNode, filePath: string, symbols: RawSymbol[], seenVars: Set<string>): void {
    const propNode = node.childForFieldName('property') ?? node.namedChildren.find(c => c.type === 'property_name');
    if (!propNode) return;

    const propName = propNode.text;
    if (!propName.startsWith('--')) return;

    if (seenVars.has(propName)) return;
    seenVars.add(propName);

    symbols.push({
      symbolId: `${filePath}::${propName}#variable`,
      name: propName,
      kind: 'variable',
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { cssCustomProperty: true },
    });
  }

  /** Extract @keyframes name. */
  private extractTsKeyframes(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    const nameNode = node.childForFieldName('name') ?? node.namedChildren.find(c => c.type === 'keyframes_name');
    if (!nameNode) return;

    const name = nameNode.text;
    symbols.push({
      symbolId: `${filePath}::@keyframes:${name}#variable`,
      name: `@keyframes ${name}`,
      kind: 'variable',
      byteStart: node.startIndex,
      byteEnd: node.endIndex,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      metadata: { keyframes: true },
    });
  }

  /** Extract @font-face with font-family name. */
  private extractTsFontFace(node: TSNode, filePath: string, symbols: RawSymbol[]): void {
    // Find the block and look for font-family declaration
    const block = node.namedChildren.find(c => c.type === 'block');
    if (!block) return;

    for (const child of block.namedChildren) {
      if (child.type !== 'declaration') continue;
      const propNode = child.childForFieldName('property') ?? child.namedChildren.find(c => c.type === 'property_name');
      if (!propNode || propNode.text !== 'font-family') continue;

      const valNode = child.namedChildren.find(
        c => c.type === 'string_value' || c.type === 'plain_value',
      ) ?? child.childForFieldName('value');
      if (!valNode) continue;

      // Strip quotes from string values
      const name = stripQuotes(valNode.text).trim();
      if (!name) continue;

      symbols.push({
        symbolId: `${filePath}::@font-face:${name}#variable`,
        name: `@font-face ${name}`,
        kind: 'variable',
        byteStart: node.startIndex,
        byteEnd: node.endIndex,
        lineStart: node.startPosition.row + 1,
        lineEnd: node.endPosition.row + 1,
        metadata: { fontFace: true, fontFamily: name },
      });
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Regex fallback path (preprocessors: SCSS, SASS, LESS, Stylus)
  // ---------------------------------------------------------------------------

  private extractWithRegex(filePath: string, content: Buffer, ext: string): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const symbols: RawSymbol[] = [];
    const edges: RawEdge[] = [];

    const language = LANG_MAP[ext] ?? 'css';

    // --- @import / @use / @forward edges ---
    const importRe = /@(?:import|use|forward)\s+['"]([^'"]+)['"]|@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(source)) !== null) {
      edges.push({
        edgeType: 'imports',
        metadata: { from: m[1] ?? m[2], kind: 'stylesheet' },
      });
    }

    // --- CSS custom properties (--var-name) ---
    const customPropRe = /(--[a-zA-Z0-9_-]+)\s*:/gm;
    const seenVars = new Set<string>();
    while ((m = customPropRe.exec(source)) !== null) {
      const name = m[1];
      if (seenVars.has(name)) continue;
      seenVars.add(name);
      symbols.push({
        symbolId: `${filePath}::${name}#variable`,
        name,
        kind: 'variable',
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart: lineAt(source, m.index),
        lineEnd: lineAt(source, m.index),
        metadata: { cssCustomProperty: true },
      });
    }

    // --- SCSS/SASS variables ($var) ---
    if (ext === '.scss' || ext === '.sass') {
      const scssVarRe = /(\$[a-zA-Z_][a-zA-Z0-9_-]*)\s*:/gm;
      while ((m = scssVarRe.exec(source)) !== null) {
        const name = m[1];
        if (seenVars.has(name)) continue;
        seenVars.add(name);
        symbols.push({
          symbolId: `${filePath}::${name}#variable`,
          name,
          kind: 'variable',
          byteStart: m.index,
          byteEnd: m.index + m[0].length,
          lineStart: lineAt(source, m.index),
          lineEnd: lineAt(source, m.index),
          metadata: { scssVariable: true },
        });
      }
    }

    // --- LESS variables (@var) ---
    if (ext === '.less') {
      const lessVarRe = /(@[a-zA-Z_][a-zA-Z0-9_-]*)\s*:/gm;
      while ((m = lessVarRe.exec(source)) !== null) {
        const name = m[1];
        // Skip @import, @media, @keyframes, etc.
        if (name.startsWith('@import') || name.startsWith('@media') || name.startsWith('@keyframes')
            || name === '@font-face' || name.startsWith('@charset') || name.startsWith('@supports')
            || name.startsWith('@namespace') || name.startsWith('@layer') || name.startsWith('@container')
            || name.startsWith('@page')) continue;
        if (seenVars.has(name)) continue;
        seenVars.add(name);
        symbols.push({
          symbolId: `${filePath}::${name}#variable`,
          name,
          kind: 'variable',
          byteStart: m.index,
          byteEnd: m.index + m[0].length,
          lineStart: lineAt(source, m.index),
          lineEnd: lineAt(source, m.index),
          metadata: { lessVariable: true },
        });
      }
    }

    // --- Stylus variables (ident = value) ---
    if (ext === '.styl' || ext === '.stylus') {
      const stylVarRe = /^([a-zA-Z_$][a-zA-Z0-9_-]*)\s*=/gm;
      while ((m = stylVarRe.exec(source)) !== null) {
        const name = m[1];
        if (seenVars.has(name)) continue;
        seenVars.add(name);
        symbols.push({
          symbolId: `${filePath}::${name}#variable`,
          name,
          kind: 'variable',
          byteStart: m.index,
          byteEnd: m.index + m[0].length,
          lineStart: lineAt(source, m.index),
          lineEnd: lineAt(source, m.index),
          metadata: { stylusVariable: true },
        });
      }
    }

    // --- @mixin definitions (SCSS/SASS/LESS) ---
    const mixinRe = /@mixin\s+([a-zA-Z_][a-zA-Z0-9_-]*)|\.([a-zA-Z_][a-zA-Z0-9_-]*)\s*\(.*\)\s*\{/gm;
    if (ext === '.scss' || ext === '.sass' || ext === '.less') {
      while ((m = mixinRe.exec(source)) !== null) {
        const name = m[1] ?? m[2];
        if (!name) continue;
        symbols.push({
          symbolId: `${filePath}::@mixin:${name}#function`,
          name: `@mixin ${name}`,
          kind: 'function',
          byteStart: m.index,
          byteEnd: m.index + m[0].length,
          lineStart: lineAt(source, m.index),
          lineEnd: lineAt(source, m.index),
          metadata: { mixin: true },
        });
      }
    }

    // --- SCSS/SASS @function definitions ---
    if (ext === '.scss' || ext === '.sass') {
      const funcRe = /@function\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s*\(/gm;
      while ((m = funcRe.exec(source)) !== null) {
        const name = m[1];
        symbols.push({
          symbolId: `${filePath}::@function:${name}#function`,
          name: `@function ${name}`,
          kind: 'function',
          byteStart: m.index,
          byteEnd: m.index + m[0].length,
          lineStart: lineAt(source, m.index),
          lineEnd: lineAt(source, m.index),
          metadata: { scssFunction: true },
        });
      }
    }

    // --- SCSS/SASS %placeholder selectors (extend targets) ---
    if (ext === '.scss' || ext === '.sass') {
      // Match both brace-style (.scss) and indented style (.sass) placeholders
      const placeholderRe = /^[ \t]*(%[a-zA-Z_][a-zA-Z0-9_-]*)[ \t]*(?:\{|$)/gm;
      const seenPlaceholders = new Set<string>();
      while ((m = placeholderRe.exec(source)) !== null) {
        const name = m[1];
        if (seenPlaceholders.has(name)) continue;
        seenPlaceholders.add(name);
        symbols.push({
          symbolId: `${filePath}::${name}#variable`,
          name,
          kind: 'variable',
          byteStart: m.index,
          byteEnd: m.index + m[0].length,
          lineStart: lineAt(source, m.index),
          lineEnd: lineAt(source, m.index),
          metadata: { scssPlaceholder: true },
        });
      }

      // @extend %placeholder / @extend .class → imports edges (enables find_usages)
      const extendRe = /@extend\s+([%.]?[a-zA-Z_][a-zA-Z0-9_-]*)/gm;
      while ((m = extendRe.exec(source)) !== null) {
        edges.push({
          edgeType: 'imports',
          metadata: { module: m[1], kind: 'scss-extend' },
        });
      }

      // @include mixin-name → calls edges (enables get_change_impact on mixins)
      const includeRe = /@include\s+([a-zA-Z_][a-zA-Z0-9_-]*)/gm;
      while ((m = includeRe.exec(source)) !== null) {
        edges.push({
          edgeType: 'calls',
          metadata: { module: `@mixin ${m[1]}`, kind: 'scss-include' },
        });
      }
    }

    // --- @keyframes ---
    const keyframesRe = /@keyframes\s+([a-zA-Z_][a-zA-Z0-9_-]*)/gm;
    while ((m = keyframesRe.exec(source)) !== null) {
      symbols.push({
        symbolId: `${filePath}::@keyframes:${m[1]}#variable`,
        name: `@keyframes ${m[1]}`,
        kind: 'variable',
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart: lineAt(source, m.index),
        lineEnd: lineAt(source, m.index),
        metadata: { keyframes: true },
      });
    }

    // --- @font-face ---
    const fontFaceRe = /@font-face\s*\{([^}]*)}/gm;
    while ((m = fontFaceRe.exec(source)) !== null) {
      const familyMatch = m[1].match(/font-family\s*:\s*['"]?([^;'"]+)/i);
      if (familyMatch) {
        const name = familyMatch[1].trim();
        symbols.push({
          symbolId: `${filePath}::@font-face:${name}#variable`,
          name: `@font-face ${name}`,
          kind: 'variable',
          byteStart: m.index,
          byteEnd: m.index + m[0].length,
          lineStart: lineAt(source, m.index),
          lineEnd: lineAt(source, m.index),
          metadata: { fontFace: true, fontFamily: name },
        });
      }
    }

    // --- Class selectors (top-level only, deduplicated) ---
    const classRe = /\.([a-zA-Z_][a-zA-Z0-9_-]*)\s*(?:[,{:[\s])/gm;
    const seenClasses = new Set<string>();
    while ((m = classRe.exec(source)) !== null) {
      const name = m[1];
      if (seenClasses.has(name)) continue;
      seenClasses.add(name);
      symbols.push({
        symbolId: `${filePath}::.${name}#variable`,
        name: `.${name}`,
        kind: 'variable',
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart: lineAt(source, m.index),
        lineEnd: lineAt(source, m.index),
        metadata: { cssClass: true },
      });
    }

    // --- ID selectors (deduplicated) ---
    const idRe = /#([a-zA-Z_][a-zA-Z0-9_-]*)\s*(?:[,{:[\s])/gm;
    const seenIds = new Set<string>();
    while ((m = idRe.exec(source)) !== null) {
      const name = m[1];
      if (seenIds.has(name)) continue;
      seenIds.add(name);
      symbols.push({
        symbolId: `${filePath}::#${name}#variable`,
        name: `#${name}`,
        kind: 'variable',
        byteStart: m.index,
        byteEnd: m.index + m[0].length,
        lineStart: lineAt(source, m.index),
        lineEnd: lineAt(source, m.index),
        metadata: { cssId: true },
      });
    }

    return ok({
      language,
      status: 'ok',
      symbols,
      edges: edges.length > 0 ? edges : undefined,
    });
  }
}

const LANG_MAP: Record<string, string> = {
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.styl': 'stylus',
  '.stylus': 'stylus',
};

/** Get 1-based line number from byte offset. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/** Strip surrounding quotes from a tree-sitter string_value node text. */
function stripQuotes(text: string): string {
  return text.replace(/^['"]|['"]$/g, '');
}
