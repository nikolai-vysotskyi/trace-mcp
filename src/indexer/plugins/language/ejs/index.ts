/**
 * EJS Language Plugin — regex-based symbol extraction.
 *
 * Extracts: function declarations and const bindings inside EJS scriptlet
 * blocks, plus include() import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'ejs',
  language: 'ejs',
  extensions: ['.ejs'],
  symbolPatterns: [
    // function declarations inside <% %> blocks: <%- function name(
    {
      kind: 'function',
      pattern: /<%[=-]?\s*function\s+(\w+)/gm,
    },
    // const bindings inside <% %> blocks: <%- const name =
    {
      kind: 'variable',
      pattern: /<%[=-]?\s*const\s+(\w+)\s*=/gm,
    },
  ],
  importPatterns: [
    // include('path')
    {
      pattern: /include\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
    },
  ],
});

export const EjsLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
