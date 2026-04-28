/**
 * INI / Config File Language Plugin — regex-based symbol extraction.
 *
 * Extracts: sections and key-value pairs from INI-style configuration files.
 * Covers .ini, .cfg, .conf, .properties, .env, .editorconfig.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'ini',
  language: 'ini',
  extensions: ['.ini', '.cfg', '.conf', '.properties', '.editorconfig'],
  symbolPatterns: [
    // [section_name] or [section.subsection]
    { kind: 'class', pattern: /^\s*\[([^\]]+)\]/gm },
    // key = value or key: value
    { kind: 'variable', pattern: /^\s*([a-zA-Z_][\w.-]*)\s*[=:]/gm },
  ],
});

export const IniLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
