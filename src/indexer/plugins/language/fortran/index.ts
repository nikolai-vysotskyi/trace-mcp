/**
 * Fortran Language Plugin — regex-based symbol extraction.
 *
 * Extracts: subroutines, functions, modules, programs, types, interfaces.
 * Case-insensitive to match Fortran conventions.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'fortran',
  language: 'fortran',
  extensions: ['.f', '.f90', '.f95', '.f03', '.f08', '.for', '.fpp'],
  symbolPatterns: [
    // SUBROUTINE name
    {
      kind: 'function',
      pattern: /^\s*(?:recursive\s+|pure\s+|elemental\s+|impure\s+)*subroutine\s+(\w+)/gmi,
      meta: { subroutine: true },
    },
    // FUNCTION name(
    {
      kind: 'function',
      pattern: /^\s*(?:recursive\s+|pure\s+|elemental\s+|impure\s+)*(?:integer|real|double\s+precision|complex|character|logical|type\s*\([^)]*\))?\s*function\s+(\w+)\s*\(/gmi,
    },
    // MODULE name
    {
      kind: 'namespace',
      pattern: /^\s*module\s+(\w+)/gmi,
    },
    // PROGRAM name
    {
      kind: 'namespace',
      pattern: /^\s*program\s+(\w+)/gmi,
      meta: { program: true },
    },
    // TYPE :: Name
    {
      kind: 'type',
      pattern: /^\s*type\s*(?:,\s*[^:]+)?\s*::\s*(\w+)/gmi,
    },
    // INTERFACE name
    {
      kind: 'interface',
      pattern: /^\s*interface\s+(\w+)/gmi,
    },
  ],
  importPatterns: [
    // USE module_name
    {
      pattern: /^\s*use\s+(\w+)/gmi,
    },
  ],
});

export const FortranLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
