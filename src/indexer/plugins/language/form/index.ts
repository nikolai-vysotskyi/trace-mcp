/**
 * FORM Language Plugin — regex-based symbol extraction.
 *
 * FORM is a symbolic manipulation language for high-energy physics.
 * Extracts: symbols, indices, vectors, functions, tables, procedures, modules, and #include edges.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'form',
  language: 'form',
  extensions: ['.frm', '.prc', '.h'],
  priority: 4,
  symbolPatterns: [
    // Symbols name1,...,nameN;
    { kind: 'variable', pattern: /^\s*(?:Auto|C)?Symbols?\s+([\w]+)/gim },
    // Index name
    { kind: 'variable', pattern: /^\s*(?:Auto)?Ind(?:ex|ices)\s+([\w]+)/gim },
    // Vector name
    { kind: 'variable', pattern: /^\s*(?:Auto)?Vectors?\s+([\w]+)/gim },
    // Function name
    { kind: 'function', pattern: /^\s*(?:C|Tensor)?Functions?\s+([\w]+)/gim },
    // Table name
    { kind: 'variable', pattern: /^\s*Table\s+([\w]+)/gim },
    // #procedure name
    { kind: 'function', pattern: /^\s*#procedure\s+(\w+)/gm },
    // .global / Local expression
    { kind: 'variable', pattern: /^\s*(?:Local|Global)\s+(\w+)/gim },
    // #define NAME
    { kind: 'constant', pattern: /^\s*#define\s+(\w+)/gm },
    // ModuleOption name
    { kind: 'module', pattern: /^\s*#module\s+(\w+)/gm },
  ],
  importPatterns: [
    // #include file.h
    { pattern: /^\s*#include\s+(\S+)/gm },
    // #call procedure
    { pattern: /^\s*#call\s+(\w+)/gm },
  ],
});

export const FormLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
