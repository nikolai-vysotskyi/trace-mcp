/**
 * AutoHotkey Language Plugin — regex-based symbol extraction.
 *
 * Extracts: functions, classes, static methods.
 * Supports both AHK v1 and v2 syntax.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'autohotkey',
  language: 'autohotkey',
  extensions: ['.ahk', '.ah2'],
  symbolPatterns: [
    // class Name
    {
      kind: 'class',
      pattern: /^\s*class\s+(\w+)/gm,
    },
    // Static method: static name(
    {
      kind: 'method',
      pattern: /^\s*static\s+(\w+)\s*\(/gm,
      meta: { static: true },
    },
    // Function: name(params) {
    {
      kind: 'function',
      pattern: /^([a-zA-Z_]\w*)\s*\([^)]*\)\s*\{/gm,
    },
  ],
});

export const AutoHotkeyLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
