/**
 * YAML Language Plugin -- regex-based symbol extraction.
 *
 * Extracts top-level keys (keys at column 0) as constants.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'yaml',
  language: 'yaml',
  extensions: ['.yaml', '.yml'],
  priority: 8, // lower priority so framework-specific YAML plugins win
  symbolPatterns: [
    // Top-level keys: "key:" at column 0 (not comments, not list items)
    {
      kind: 'constant',
      pattern: /^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*:/gm,
    },
  ],
});

export const YamlLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
