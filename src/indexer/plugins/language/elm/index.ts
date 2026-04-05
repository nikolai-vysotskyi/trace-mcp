/**
 * Elm Language Plugin — regex-based symbol extraction.
 *
 * Extracts: functions, type aliases, custom types, ports, modules, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'elm',
  language: 'elm',
  extensions: ['.elm'],
  symbolPatterns: [
    // type alias Name
    { kind: 'type', pattern: /^type\s+alias\s+(\w+)/gm },
    // type Name
    { kind: 'type', pattern: /^type\s+(?!alias\b)(\w+)/gm },
    // port name :
    { kind: 'function', pattern: /^port\s+(\w+)\s*:/gm, meta: { port: true } },
    // name : Type -> Type (type annotation, function signature)
    { kind: 'function', pattern: /^(\w+)\s*:(?:\s*\w)/gm },
    // name arg1 arg2 = (function definition)
    { kind: 'function', pattern: /^(\w+)(?:\s+\w+)+\s*=/gm },
    // module Name exposing
    { kind: 'module', pattern: /^module\s+([\w.]+)/gm },
  ],
  importPatterns: [
    // import Module.Name [as Alias] [exposing (..)]
    { pattern: /^\s*import\s+([\w.]+)/gm },
  ],
});

export const ElmLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
