/**
 * Nix Language Plugin — regex-based symbol extraction.
 *
 * Extracts: top-level attribute bindings, let-bindings, function args.
 * Imports: import expressions.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'nix',
  language: 'nix',
  extensions: ['.nix'],
  symbolPatterns: [
    // Function-like: name = { arg1, arg2, ... }: or name = args: (function with arg pattern)
    {
      kind: 'function',
      pattern: /^\s{0,2}([a-zA-Z_][a-zA-Z0-9_'-]*)\s*=\s*(?:\{[^}]*\}\s*:|[a-zA-Z_]\w*\s*:)/gm,
    },
    // Attribute set binding at top level (0-2 spaces indent): name = { ... }
    {
      kind: 'variable',
      pattern: /^\s{0,2}([a-zA-Z_][a-zA-Z0-9_'-]*)\s*=\s*\{/gm,
    },
    // Simple top-level binding: name = value; (0-2 spaces indent, value is not `{`)
    {
      kind: 'variable',
      pattern: /^\s{0,2}([a-zA-Z_][a-zA-Z0-9_'-]*)\s*=\s*(?!.*\{)[^;]+;/gm,
    },
    // inherit (name1 name2) — inherited attributes
    {
      kind: 'variable',
      pattern: /^\s*inherit\s+(?:\([^)]+\)\s+)?(\w+)/gm,
      meta: { inherited: true },
    },
  ],
  importPatterns: [
    // import ./path or import <nixpkgs> — only match with path-like argument
    {
      pattern: /\bimport\s+(\.\/[^\s;]+|<[^>]+>)/gm,
    },
  ],
});

export const NixLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
