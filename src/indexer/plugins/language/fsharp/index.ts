/**
 * F# Language Plugin — regex-based symbol extraction.
 *
 * Extracts: let bindings, type definitions, modules, exceptions, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'fsharp',
  language: 'fsharp',
  extensions: ['.fs', '.fsi', '.fsx'],
  symbolPatterns: [
    // let name / let rec name — functions and values
    { kind: 'function', pattern: /^\s*let\s+(?:rec\s+)?(?:inline\s+)?(\w+)/gm },
    // let private / let internal
    { kind: 'function', pattern: /^\s*let\s+(?:private|internal)\s+(?:rec\s+)?(\w+)/gm },
    // member [this.]name
    { kind: 'method', pattern: /^\s*(?:abstract\s+)?member\s+(?:\w+\.)?(\w+)/gm },
    // type Name
    { kind: 'type', pattern: /^\s*type\s+(?:private\s+|internal\s+)?(\w+)/gm },
    // module Name
    { kind: 'module', pattern: /^\s*module\s+(?:rec\s+)?(?:private\s+|internal\s+)?(\w+)/gm },
    // exception Name
    { kind: 'constant', pattern: /^\s*exception\s+(\w+)/gm },
    // val name : (signatures)
    { kind: 'function', pattern: /^\s*val\s+(\w+)\s*:/gm },
  ],
  importPatterns: [
    // open Namespace.Module
    { pattern: /^\s*open\s+([\w.]+)/gm },
  ],
});

export const FSharpLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
