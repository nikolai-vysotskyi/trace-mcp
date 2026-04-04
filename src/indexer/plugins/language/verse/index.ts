/**
 * Verse Language Plugin — regex-based symbol extraction.
 *
 * Extracts: class definitions, public methods, properties, variables.
 * Verse is the programming language for Unreal Editor for Fortnite (UEFN).
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'verse',
  language: 'verse',
  extensions: ['.verse'],
  symbolPatterns: [
    // Class definition: name := class
    {
      kind: 'class',
      pattern: /^\s*(\w+)\s*:=\s*class/gm,
    },
    // Public method: name<public>() : type =
    {
      kind: 'method',
      pattern: /^\s*(\w+)\s*<public>\s*\([^)]*\)\s*:\s*\w+/gm,
      meta: { visibility: 'public' },
    },
    // Property/binding: name : type = ...
    {
      kind: 'property',
      pattern: /^\s*(\w+)\s*:\s*\w+\s*=/gm,
    },
    // Variable: var name : type
    {
      kind: 'variable',
      pattern: /^\s*var\s+(\w+)\s*:/gm,
    },
  ],
});

export const VerseLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
