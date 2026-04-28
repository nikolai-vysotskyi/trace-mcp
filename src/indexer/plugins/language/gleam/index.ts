/**
 * Gleam Language Plugin — regex-based symbol extraction.
 *
 * Extracts: public/private functions, types, constants, and import edges.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'gleam',
  language: 'gleam',
  extensions: ['.gleam'],
  versions: ['0.30', '0.31', '0.32', '0.33', '0.34', '1.0', '1.1', '1.2', '1.3', '1.4', '1.5'],
  symbolPatterns: [
    // pub fn name
    { kind: 'function', pattern: /^\s*pub\s+fn\s+(\w+)/gm, meta: { public: true } },
    // fn name (private)
    { kind: 'function', pattern: /^\s*fn\s+(\w+)/gm },
    // pub type Name (opaque or not)
    { kind: 'type', pattern: /^\s*pub\s+(?:opaque\s+)?type\s+(\w+)/gm, meta: { public: true } },
    // type Name (private)
    { kind: 'type', pattern: /^\s*type\s+(\w+)/gm },
    // pub const name
    { kind: 'constant', pattern: /^\s*pub\s+const\s+(\w+)/gm, meta: { public: true } },
    // const name (private)
    { kind: 'constant', pattern: /^\s*const\s+(\w+)/gm },
  ],
  importPatterns: [
    // import module/path [.{items}] [as alias]
    { pattern: /^\s*import\s+([\w/]+)/gm },
  ],
  fqnSep: '/',
});

export const GleamLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
