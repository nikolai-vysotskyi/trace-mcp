/**
 * TOML Language Plugin -- regex-based symbol extraction.
 *
 * Extracts: [table] headers, [[array-of-tables]] headers,
 * and top-level key = value assignments.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'toml',
  language: 'toml',
  extensions: ['.toml'],
  symbolPatterns: [
    // [[array-of-tables]] -- must check before [table] since [[ also matches [
    {
      kind: 'class',
      pattern: /^\s*\[\[([a-zA-Z_][a-zA-Z0-9_.-]*)\]\]/gm,
      meta: { tomlKind: 'array-of-tables' },
    },
    // [table] (but not [[)
    {
      kind: 'namespace',
      pattern: /^\s*\[([a-zA-Z_][a-zA-Z0-9_.-]*)\](?!\])/gm,
      meta: { tomlKind: 'table' },
    },
    // Top-level key = value (only at column 0, not inside tables easily,
    // but regex-based approach captures all key = value at col 0)
    {
      kind: 'constant',
      pattern: /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*=/gm,
      meta: { tomlKind: 'key' },
    },
  ],
});

export const TomlLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
