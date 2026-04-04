/**
 * Bash/Shell Language Plugin — regex-based symbol extraction.
 *
 * Extracts: function definitions, readonly/exported constants.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'bash',
  language: 'bash',
  extensions: ['.sh', '.bash', '.zsh'],
  symbolPatterns: [
    // function name { ... } or function name() { ... }
    {
      kind: 'function',
      pattern: /^\s*function\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gm,
    },
    // name() { ... } — require `{` after `()` to avoid matching array assignments like `arr=()`
    {
      kind: 'function',
      pattern: /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*\)\s*\{/gm,
    },
    // readonly NAME=...
    {
      kind: 'constant',
      pattern: /^\s*readonly\s+([A-Z_][A-Z0-9_]*)=/gm,
    },
    // declare -r NAME=...
    {
      kind: 'constant',
      pattern: /^\s*declare\s+-r\s+([A-Z_][A-Z0-9_]*)=/gm,
    },
    // export NAME=...
    {
      kind: 'variable',
      pattern: /^\s*export\s+([A-Z_][A-Z0-9_]*)=/gm,
      meta: { exported: true },
    },
  ],
  // No import patterns — `source` is too complex/context-dependent
});

export const BashLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
