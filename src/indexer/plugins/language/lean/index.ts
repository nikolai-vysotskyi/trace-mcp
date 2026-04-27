/**
 * Lean 4 Language Plugin — regex-based symbol extraction.
 *
 * Extracts: def, theorem, lemma, structure, class, instance, inductive, abbrev,
 * namespace, section, axiom, and import edges.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'lean',
  language: 'lean',
  extensions: ['.lean'],
  symbolPatterns: [
    // def name
    {
      kind: 'function',
      pattern: /^\s*(?:noncomputable\s+)?(?:private\s+|protected\s+)?def\s+(\w[\w.]*)/gm,
    },
    // theorem name / lemma name
    {
      kind: 'function',
      pattern: /^\s*(?:private\s+|protected\s+)?(?:theorem|lemma)\s+(\w[\w.]*)/gm,
      meta: { proof: true },
    },
    // structure Name
    { kind: 'class', pattern: /^\s*(?:private\s+|protected\s+)?structure\s+(\w[\w.]*)/gm },
    // class Name
    { kind: 'class', pattern: /^\s*(?:private\s+|protected\s+)?class\s+(\w[\w.]*)/gm },
    // instance : TypeClass
    { kind: 'function', pattern: /^\s*(?:noncomputable\s+)?instance\s+(?:(\w[\w.]*)\s*:)?/gm },
    // inductive Name
    { kind: 'type', pattern: /^\s*inductive\s+(\w[\w.]*)/gm },
    // abbrev Name
    { kind: 'type', pattern: /^\s*abbrev\s+(\w[\w.]*)/gm },
    // namespace Name
    { kind: 'namespace', pattern: /^\s*namespace\s+(\w[\w.]*)/gm },
    // section Name
    { kind: 'namespace', pattern: /^\s*section\s+(\w[\w.]*)/gm },
    // axiom Name
    { kind: 'constant', pattern: /^\s*axiom\s+(\w[\w.]*)/gm },
    // variable / constant declarations (Lean 4)
    { kind: 'variable', pattern: /^\s*variable\s+(?:\{|\()?\s*(\w+)/gm },
  ],
  importPatterns: [
    // import Module.Name
    { pattern: /^\s*import\s+([\w.]+)/gm },
    // open Module
    { pattern: /^\s*open\s+([\w.]+)/gm },
  ],
});

export const LeanLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
