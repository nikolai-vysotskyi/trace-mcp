/**
 * Assembly Language Plugin — regex-based symbol extraction.
 *
 * Extracts: labels, procedures, macros, equates, sections, defines.
 * Covers NASM, MASM, GAS, and common assembler dialects.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'assembly',
  language: 'assembly',
  extensions: ['.asm', '.s', '.S'],
  symbolPatterns: [
    // Label at start of line: name: (exclude common keywords that use colons)
    {
      kind: 'function',
      pattern: /^([a-zA-Z_][a-zA-Z0-9_]{2,}):/gm,
    },
    // GAS .global / .globl directive
    {
      kind: 'function',
      pattern: /^\s*\.(?:global|globl)\s+(\w+)/gm,
      meta: { exported: true },
    },
    // MASM procedure: name PROC
    {
      kind: 'function',
      pattern: /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+PROC\b/gmi,
      meta: { procedure: true },
    },
    // MASM macro: name MACRO
    {
      kind: 'function',
      pattern: /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+MACRO\b/gmi,
      meta: { macro: true },
    },
    // Equate: name EQU value
    {
      kind: 'constant',
      pattern: /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+[Ee][Qq][Uu]\s+/gm,
    },
    // SECTION / .section directive
    {
      kind: 'namespace',
      pattern: /^\s*(?:SECTION|\.section)\s+\.?(\w+)/gmi,
    },
    // NASM %define
    {
      kind: 'constant',
      pattern: /^\s*%define\s+(\w+)/gm,
    },
    // NASM %macro
    {
      kind: 'function',
      pattern: /^\s*%macro\s+(\w+)/gm,
      meta: { macro: true },
    },
  ],
});

export const AssemblyLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
