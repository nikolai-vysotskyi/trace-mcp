/**
 * Perl Language Plugin — regex-based symbol extraction.
 *
 * Extracts: subroutines, packages.
 * Imports: use/require statements.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'perl',
  language: 'perl',
  extensions: ['.pl', '.pm', '.t'],
  symbolPatterns: [
    // package Name;
    {
      kind: 'namespace',
      pattern: /^\s*package\s+([a-zA-Z_][a-zA-Z0-9_:]*)\s*;/gm,
    },
    // sub name { ... }
    {
      kind: 'function',
      pattern: /^\s*sub\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gm,
    },
  ],
  importPatterns: [
    // use Module; or use Module qw(...);
    {
      pattern: /^\s*use\s+([a-zA-Z_][a-zA-Z0-9_:]*)/gm,
    },
    // require "file"; or require Module;
    {
      pattern: /^\s*require\s+["']?([a-zA-Z_][a-zA-Z0-9_/.:]*)/gm,
    },
  ],
  fqnSep: '::',
});

export const PerlLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
