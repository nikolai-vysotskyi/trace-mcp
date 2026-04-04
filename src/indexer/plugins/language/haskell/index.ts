/**
 * Haskell Language Plugin — regex-based symbol extraction.
 *
 * Extracts: modules, data types, newtypes, type aliases, type classes,
 * instances, top-level type signatures, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'haskell',
  language: 'haskell',
  extensions: ['.hs', '.lhs'],
  symbolPatterns: [
    // module Name where
    { kind: 'namespace', pattern: /^\s*module\s+([\w.]+)/gm },
    // data Name
    { kind: 'type', pattern: /^\s*data\s+(\w+)/gm, meta: { dataType: true } },
    // newtype Name
    { kind: 'type', pattern: /^\s*newtype\s+(\w+)/gm, meta: { newtype: true } },
    // type Name (type alias)
    { kind: 'type', pattern: /^\s*type\s+(?!family\b)(\w+)/gm, meta: { typeAlias: true } },
    // type family Name
    { kind: 'type', pattern: /^\s*type\s+family\s+(\w+)/gm, meta: { typeFamily: true } },
    // class Name
    { kind: 'interface', pattern: /^\s*class\s+(?:.*=>\s*)?(\w+)/gm, meta: { typeClass: true } },
    // instance Name
    { kind: 'class', pattern: /^\s*instance\s+(?:.*=>\s*)?(\w+)/gm, meta: { instance: true } },
    // top-level type signature: name :: type (must start at column 0, no leading whitespace)
    { kind: 'function', pattern: /^([a-z_]\w*)\s*::\s*.+/gm },
    // data constructors: data Foo = Bar | Baz (capture constructors after =)
    { kind: 'enum_case', pattern: /^\s*data\s+\w+[^=]*=\s*([A-Z]\w*)/gm, meta: { constructor: true } },
  ],
  importPatterns: [
    // import [qualified] Module [as Alias] [hiding] [(items)]
    { pattern: /^\s*import\s+(?:qualified\s+)?([\w.]+)/gm },
  ],
  fqnSep: '.',
});

export const HaskellLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
