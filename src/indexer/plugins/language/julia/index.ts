/**
 * Julia Language Plugin — regex-based symbol extraction.
 *
 * Extracts: functions (long + short form), structs, abstract types,
 *           modules, macros, constants.
 * Imports: using/import statements.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'julia',
  language: 'julia',
  extensions: ['.jl'],
  symbolPatterns: [
    // module Name (Julia convention is CamelCase but allow any)
    {
      kind: 'namespace',
      pattern: /^\s*(?:bare)?module\s+(\w+)/gm,
    },
    // abstract type Name end or abstract type Name <: Parent end
    {
      kind: 'type',
      pattern: /^\s*abstract\s+type\s+(\w+)/gm,
    },
    // primitive type Name N end
    {
      kind: 'type',
      pattern: /^\s*primitive\s+type\s+(\w+)/gm,
      meta: { primitive: true },
    },
    // mutable struct Name or struct Name
    {
      kind: 'class',
      pattern: /^\s*(?:mutable\s+)?struct\s+(\w+)/gm,
    },
    // function name(
    {
      kind: 'function',
      pattern: /^\s*function\s+([a-zA-Z_][a-zA-Z0-9_!]*)\s*\(/gm,
    },
    // name(args) = ... (short-form function, must start at line beginning)
    {
      kind: 'function',
      pattern: /^([a-zA-Z_][a-zA-Z0-9_!]*)\s*\([^)]*\)\s*=/gm,
    },
    // macro name
    {
      kind: 'function',
      pattern: /^\s*macro\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
      meta: { macro: true },
    },
    // const name = ... (Julia uses any case for constants)
    {
      kind: 'constant',
      pattern: /^\s*const\s+(\w+)\s*=/gm,
    },
  ],
  importPatterns: [
    // using Module or using Module: name1, name2
    {
      pattern: /^\s*using\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gm,
    },
    // import Module or import Module: name1, name2
    {
      pattern: /^\s*import\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gm,
    },
  ],
});

export const JuliaLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
