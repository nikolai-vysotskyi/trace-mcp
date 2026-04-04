/**
 * CSS/SCSS/SASS/LESS/Stylus Language Plugin — regex-based extraction.
 *
 * Extracts: CSS custom properties (variables), class selectors, ID selectors,
 * @import/@use/@forward edges, @mixin definitions, @keyframes, @font-face,
 * and preprocessor variables ($var in SCSS/SASS, @var in LESS).
 */
import { ok } from 'neverthrow';
import type { LanguagePlugin, PluginManifest, FileParseResult, RawSymbol, RawEdge } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

export class CssLanguagePlugin implements LanguagePlugin {
  manifest: PluginManifest = {
    name: 'css-language',
    version: '1.0.0',
    priority: 6,
  };

  supportedExtensions = ['.css', '.scss', '.sass', '.less', '.styl', '.stylus'];

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const ext = filePath.substring(filePath.lastIndexOf('.'));
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
