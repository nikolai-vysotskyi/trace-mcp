/**
 * Markdown Language Plugin — regex-based symbol extraction.
 *
 * Extracts: headings (as structural hierarchy), code block languages,
 * link definitions, and front-matter keys.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'markdown',
  language: 'markdown',
  extensions: ['.md', '.mdx', '.markdown'],
  priority: 3,
  symbolPatterns: [
    // # Heading 1
    { kind: 'class', pattern: /^#\s+(.+)/gm, meta: { level: 1 } },
    // ## Heading 2
    { kind: 'class', pattern: /^##\s+(.+)/gm, meta: { level: 2 } },
    // ### Heading 3
    { kind: 'class', pattern: /^###\s+(.+)/gm, meta: { level: 3 } },
    // #### Heading 4-6
    { kind: 'class', pattern: /^####\s+(.+)/gm, meta: { level: 4 } },
    // [ref-name]: url — reference-style link definitions
    { kind: 'constant', pattern: /^\[([^\]]+)\]:\s+\S+/gm, meta: { link_ref: true } },
    // ```language — fenced code block language tags
    { kind: 'variable', pattern: /^```(\w+)/gm, meta: { code_block: true } },
  ],
});

export const MarkdownLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
