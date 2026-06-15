/**
 * Helper utilities for the Astro language plugin.
 *
 * Handles Astro v6 file structure:
 *   ---        <- frontmatter fence (optional)
 *   TS/JS code
 *   ---        <- closing fence
 *   HTML template body (with optional <script> / <style> blocks)
 */

/** HTML elements to exclude when detecting custom Astro components in templates. */
const HTML_ELEMENTS = new Set([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'menu',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
]);

/** SVG elements to exclude. */
const SVG_ELEMENTS = new Set([
  'svg',
  'circle',
  'clipPath',
  'defs',
  'desc',
  'ellipse',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feImage',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'feSpecularLighting',
  'feTile',
  'feTurbulence',
  'filter',
  'foreignObject',
  'g',
  'image',
  'line',
  'linearGradient',
  'marker',
  'mask',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialGradient',
  'rect',
  'stop',
  'switch',
  'symbol',
  'text',
  'textPath',
  'tspan',
  'use',
  'view',
]);

/** Astro built-in / framework-owned tags that are not user components. */
const ASTRO_BUILTINS = new Set([
  'Fragment',
  'slot',
  'Slot',
  // Astro v2+ built-ins
  'Content',
  'Debug',
]);

/**
 * Result of splitting an Astro source file into its sections.
 * All offsets are byte positions in the original source (after BOM removal).
 */
export interface AstroSections {
  /** TypeScript/JavaScript frontmatter text (between the two `---` fences), or null. */
  frontmatter: string | null;
  /** Byte offset in the original source where the frontmatter content starts. */
  frontmatterOffset: number;
  /** Line number (1-based) where the frontmatter content starts. */
  frontmatterLineStart: number;
  /** The template body (everything after the closing `---` fence, or the whole file if no frontmatter). */
  template: string;
  /** Byte offset in the original source where the template content starts. */
  templateOffset: number;
  /** Line number (1-based) where the template starts. */
  templateLineStart: number;
}

/**
 * Split an Astro source file into its frontmatter and template sections.
 *
 * Handles:
 *  - UTF-8 BOM (stripped before processing)
 *  - CRLF line endings (normalised to LF for splitting, offsets adjusted)
 *  - Malformed / unclosed frontmatter fences (fail-soft: treat entire file as template)
 *  - Leading whitespace before the opening `---`
 */
export function splitAstroSections(rawSource: string): AstroSections {
  // Strip UTF-8 BOM if present.
  const source = rawSource.startsWith('﻿') ? rawSource.slice(1) : rawSource;

  // Normalise CRLF → LF so all line-based logic is consistent.
  // We operate on the normalised string; byte offsets returned are relative to
  // the BOM-stripped, CRLF-normalised source (which is what we pass to sub-parsers).
  const normalised = source.replace(/\r\n/g, '\n');

  // Opening fence must be on the very first non-blank line.
  // The spec says `---` must be the first thing on line 1 (Astro v6).
  const firstLineEnd = normalised.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? normalised : normalised.slice(0, firstLineEnd);

  if (firstLine.trim() !== '---') {
    // No frontmatter — entire file is template.
    return {
      frontmatter: null,
      frontmatterOffset: 0,
      frontmatterLineStart: 1,
      template: normalised,
      templateOffset: 0,
      templateLineStart: 1,
    };
  }

  // Opening fence ends at firstLineEnd + 1 (past the \n).
  const fmContentStart = firstLineEnd + 1;
  const fmContentStartLine = 2; // line after the `---`

  // Find closing fence: a line that is exactly `---`.
  const closingFenceMatch = /^---\s*$/m.exec(normalised.slice(fmContentStart));

  if (!closingFenceMatch) {
    // Unclosed fence — fail-soft: treat entire file as template.
    return {
      frontmatter: null,
      frontmatterOffset: 0,
      frontmatterLineStart: 1,
      template: normalised,
      templateOffset: 0,
      templateLineStart: 1,
    };
  }

  const closingFenceRelOffset = closingFenceMatch.index;
  const frontmatterContent = normalised.slice(
    fmContentStart,
    fmContentStart + closingFenceRelOffset,
  );

  // Template starts after closing fence line.
  const closingFenceAbsOffset = fmContentStart + closingFenceRelOffset;
  // Skip past the `---\n` closing fence line.
  const templateStart = closingFenceAbsOffset + closingFenceMatch[0].length;
  // If the fence wasn't followed by \n (end of file), templateStart may equal source length.
  const templateStartNormalised =
    templateStart < normalised.length
      ? normalised[templateStart] === '\n'
        ? templateStart + 1
        : templateStart
      : templateStart;

  const templateLineStart = countLines(normalised, 0, templateStartNormalised) + 1;

  return {
    frontmatter: frontmatterContent,
    frontmatterOffset: fmContentStart,
    frontmatterLineStart: fmContentStartLine,
    template: normalised.slice(templateStartNormalised),
    templateOffset: templateStartNormalised,
    templateLineStart,
  };
}

/** Count the number of newlines in source[start..end). Returns number of complete lines. */
function countLines(source: string, start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i++) {
    if (source[i] === '\n') count++;
  }
  return count;
}

export interface ScriptBlock {
  content: string;
  /** Offset of the block content start in the template string. */
  contentOffset: number;
  /** tree-sitter language to use for parsing ('typescript' | 'javascript'). */
  lang: 'typescript' | 'javascript';
  /** Whether this is a `<script is:inline>` block (skip symbol extraction). */
  isInline: boolean;
}

export interface StyleBlock {
  content: string;
  contentOffset: number;
  lang: string;
}

/**
 * Extract `<script>` blocks from Astro template HTML.
 *
 * Handles:
 *  - `<script>` (treated as TypeScript per Astro defaults)
 *  - `<script lang="ts">` / `<script lang="tsx">`
 *  - `<script lang="js">` / `<script lang="jsx">`
 *  - `<script type="application/json">` (skipped — not executable code)
 *  - `<script is:inline>` (skipped — not processed by Astro)
 */
export function extractScriptBlocks(template: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];

  // Match <script ...> ... </script> (non-greedy, handles multiline)
  const scriptTagRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;

  while ((m = scriptTagRe.exec(template)) !== null) {
    const attrs = m[1];
    const content = m[2];
    const contentOffset = m.index + '<script'.length + attrs.length + '>'.length;

    // Skip JSON/JSON-LD script blocks.
    const typeMatch = /type\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (typeMatch) {
      const type = typeMatch[1].toLowerCase();
      if (type.includes('json') || type === 'module/json') continue;
      // Skip non-js types (importmap, speculationrules, etc.)
      if (!type.includes('javascript') && !type.includes('module') && !type.includes('text')) {
        continue;
      }
    }

    const isInline = /\bis:inline\b/i.test(attrs);

    // Determine language from lang attribute.
    const langMatch = /lang\s*=\s*["']([^"']+)["']/i.exec(attrs);
    let lang: 'typescript' | 'javascript' = 'typescript'; // Astro default
    if (langMatch) {
      const l = langMatch[1].toLowerCase();
      if (l === 'js' || l === 'jsx') {
        lang = 'javascript';
      } else if (l === 'ts' || l === 'tsx') {
        lang = 'typescript';
      }
    }

    blocks.push({ content, contentOffset, lang, isInline });
  }

  return blocks;
}

/**
 * Extract `<style>` blocks from Astro template HTML.
 */
export function extractStyleBlocks(template: string): StyleBlock[] {
  const blocks: StyleBlock[] = [];
  const styleTagRe = /<style([^>]*)>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = styleTagRe.exec(template)) !== null) {
    const attrs = m[1];
    const content = m[2];
    const contentOffset = m.index + '<style'.length + attrs.length + '>'.length;
    const langMatch = /lang\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const lang = langMatch ? langMatch[1].toLowerCase() : 'css';
    blocks.push({ content, contentOffset, lang });
  }
  return blocks;
}

/**
 * Return true if a tag name is a custom Astro component (not an HTML/SVG built-in).
 *
 * Rules (Astro v6):
 *  - PascalCase tags (start with uppercase) are always custom components.
 *  - Known HTML/SVG elements are excluded.
 *  - Astro built-ins (Fragment, Slot, etc.) are excluded.
 *  - kebab-case names with a hyphen are custom elements.
 */
export function isCustomAstroComponent(tag: string): boolean {
  if (ASTRO_BUILTINS.has(tag)) return false;

  // PascalCase: always a custom component in Astro.
  if (/^[A-Z]/.test(tag)) return true;

  // Lowercase HTML element.
  if (HTML_ELEMENTS.has(tag.toLowerCase())) return false;

  // SVG element.
  if (SVG_ELEMENTS.has(tag)) return false;

  // Custom element (kebab-case with hyphen).
  if (tag.includes('-')) return true;

  return false;
}

/**
 * Extract component usage tags from an Astro template body.
 *
 * Returns unique component names found in the template (PascalCase or
 * kebab-case-with-hyphen custom elements, excluding known HTML/SVG/Astro builtins).
 */
export function extractTemplateComponents(template: string): string[] {
  const tags = new Set<string>();
  // Match opening tags and self-closing tags: <ComponentName or <tag-name
  const tagRe = /<([A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(template)) !== null) {
    const tag = m[1];
    if (isCustomAstroComponent(tag)) {
      tags.add(tag);
    }
  }
  return [...tags];
}

/**
 * Extract `id="value"` attribute constants from Astro template HTML.
 *
 * These are surfaced as `constant` symbols (similar to anchor identifiers
 * in HTML/Markdown plugins), allowing the graph to reference specific
 * template anchor points.
 */
export function extractIdConstants(template: string): Array<{ name: string; offset: number }> {
  const ids: Array<{ name: string; offset: number }> = [];
  const idRe = /\bid\s*=\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(template)) !== null) {
    ids.push({ name: m[1], offset: m.index });
  }
  return ids;
}

/**
 * Derive component name from an Astro file path.
 * e.g., 'src/components/UserCard.astro' → 'UserCard'
 */
export function componentNameFromPath(filePath: string): string {
  const fileName = filePath.split('/').pop() ?? filePath;
  return fileName.replace(/\.astro$/, '');
}
