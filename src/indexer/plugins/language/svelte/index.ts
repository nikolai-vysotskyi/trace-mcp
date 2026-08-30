/**
 * Svelte Language Plugin — regex-based symbol extraction.
 *
 * Extracts: script-level exports, component props (`export let` and Svelte 5
 * `$props()` destructuring), reactive declarations, stores, runes, snippets,
 * and import edges.
 */

import type { FileParseResult, LanguagePlugin, RawSymbol } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { createRegexLanguagePlugin, lineAt, makeSymbolId } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'svelte',
  language: 'svelte',
  extensions: ['.svelte'],
  symbolPatterns: [
    // export let name (Svelte 4 props)
    { kind: 'property', pattern: /^\s*export\s+let\s+(\w+)/gm, meta: { prop: true } },
    // export const name
    { kind: 'constant', pattern: /^\s*export\s+const\s+(\w+)/gm },
    // export function name
    { kind: 'function', pattern: /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm },
    // $: name = (reactive declarations - Svelte 4)
    { kind: 'variable', pattern: /^\s*\$:\s+(\w+)\s*=/gm, meta: { reactive: true } },
    // $derived / $state / $effect (Svelte 5 runes)
    {
      kind: 'variable',
      pattern: /^\s*(?:let|const)\s+(\w+)\s*=\s*\$(?:state|derived|effect)/gm,
      meta: { rune: true },
    },
    // function name (non-exported)
    { kind: 'function', pattern: /^\s*(?:async\s+)?function\s+(\w+)/gm },
    // const name = (non-exported)
    { kind: 'variable', pattern: /^\s*(?:const|let)\s+(\w+)\s*=/gm },
    // {#snippet name} — template blocks
    { kind: 'variable', pattern: /\{#snippet\s+(\w+)/gm, meta: { snippet: true } },
  ],
  importPatterns: [
    // import ... from 'module'
    { pattern: /import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm },
    // import 'module'
    { pattern: /import\s+['"]([^'"]+)['"]/gm },
  ],
});

/**
 * `let { a, b = 1, ...rest }: Props = $props()` — Svelte 5's declaration of a
 * component's public API. Each destructured binding is a prop. The regex-base
 * one-capture-group model can't express "N names from one match", so props are
 * extracted here instead.
 */
const PROPS_DESTRUCTURE = /(?:let|const)\s*\{([^}]*)\}\s*(?::[^=]*?)?=\s*\$props\s*\(/g;

/** Split on commas that are not nested inside (), [], {} or a string. */
function splitTopLevel(source: string): Array<{ text: string; offset: number }> {
  const parts: Array<{ text: string; offset: number }> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote && source[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push({ text: source.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  parts.push({ text: source.slice(start), offset: start });
  return parts;
}

/**
 * Local binding name of one destructured entry:
 *   `children` → children · `open = false` → open · `...rest` → rest
 *   `class: className` → className (the local name is what the code uses)
 */
function bindingName(part: string): string | undefined {
  // Drop the default value; `=>` inside a default must not be mistaken for it.
  let head = part;
  const eq = head.search(/=(?!>)/);
  if (eq !== -1) head = head.slice(0, eq);
  const alias = head.split(':');
  const name = alias[alias.length - 1].replace(/\.\.\./, '').trim();
  return /^\w+$/.test(name) ? name : undefined;
}

function extractRuneProps(filePath: string, source: string): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const seen = new Set<string>();
  PROPS_DESTRUCTURE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROPS_DESTRUCTURE.exec(source)) !== null) {
    const blockOffset = m.index + m[0].indexOf('{') + 1;
    for (const part of splitTopLevel(m[1])) {
      const name = bindingName(part.text);
      if (!name) continue;
      const symbolId = makeSymbolId(filePath, name, 'property');
      if (seen.has(symbolId)) continue;
      seen.add(symbolId);
      const nameOffset = blockOffset + part.offset + part.text.indexOf(name);
      const line = lineAt(source, nameOffset);
      symbols.push({
        symbolId,
        name,
        kind: 'property',
        fqn: name,
        signature: part.text.trim(),
        byteStart: nameOffset,
        byteEnd: nameOffset + name.length,
        lineStart: line,
        lineEnd: line,
        metadata: { prop: true, rune: true },
      });
    }
  }
  return symbols;
}

export const SvelteLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    // regex-base is synchronous, so the union's Promise arm is unreachable here.
    const base = _plugin.extractSymbols(filePath, content) as TraceMcpResult<FileParseResult>;
    return base.map((parsed) => {
      const existing = new Set(parsed.symbols.map((s) => s.symbolId));
      const props = extractRuneProps(filePath, content.toString('utf-8')).filter(
        (s) => !existing.has(s.symbolId),
      );
      return props.length > 0 ? { ...parsed, symbols: [...parsed.symbols, ...props] } : parsed;
    });
  }
};
