/**
 * JSON Language Plugin -- regex-based symbol extraction.
 *
 * Extracts top-level object keys as constants.
 * Handles .json, .jsonc, and .json5 files.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'json',
  language: 'json',
  extensions: ['.json', '.jsonc', '.json5'],
  priority: 8, // lower priority so framework-specific JSON plugins win
  symbolPatterns: [
    // Top-level keys: "key": at indent level 2 (inside root object)
    // Matches keys indented by exactly 2 spaces or 1 tab (first level inside {})
    {
      kind: 'constant',
      pattern: /^(?:\s{2}|\t)"([^"]+)"\s*:/gm,
    },
  ],
});

export const JsonLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
