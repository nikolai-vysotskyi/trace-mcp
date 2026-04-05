/**
 * OCaml Language Plugin — regex-based symbol extraction.
 *
 * Extracts: let/val bindings, type definitions, modules, module types, classes, exceptions, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'ocaml',
  language: 'ocaml',
  extensions: ['.ml', '.mli'],
  symbolPatterns: [
    // let name / let rec name — top-level function/value bindings
    { kind: 'function', pattern: /^let\s+(?:rec\s+)?(\w+)/gm },
    // val name : — signatures in .mli
    { kind: 'function', pattern: /^val\s+(\w+)\s*:/gm },
    // type name
    { kind: 'type', pattern: /^type\s+(?:'?\w+\s+)*(\w+)/gm },
    // module Name
    { kind: 'module', pattern: /^module\s+(\w+)/gm },
    // module type Name
    { kind: 'type', pattern: /^module\s+type\s+(\w+)/gm },
    // class name
    { kind: 'class', pattern: /^class\s+(?:virtual\s+)?(\w+)/gm },
    // exception Name
    { kind: 'constant', pattern: /^exception\s+(\w+)/gm },
  ],
  importPatterns: [
    // open Module
    { pattern: /^\s*open\s+(\w[\w.]*)/gm },
  ],
});

export const OcamlLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
