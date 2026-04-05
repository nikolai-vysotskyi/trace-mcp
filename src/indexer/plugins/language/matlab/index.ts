/**
 * MATLAB / Octave Language Plugin — regex-based symbol extraction.
 *
 * Extracts: functions, classdef, properties, methods, events, enumerations, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'matlab',
  language: 'matlab',
  extensions: ['.m', '.mlx', '.mat'],
  symbolPatterns: [
    // function [out] = name(args) or function name(args) or function out = name(args)
    { kind: 'function', pattern: /^\s*function\s+(?:\[?[\w,\s~]*\]?\s*=\s*)?(\w+)/gm },
    // classdef Name [< SuperClass]
    { kind: 'class', pattern: /^\s*classdef\s+(?:\([^)]*\)\s+)?(\w+)/gm },
    // properties block (marker)
    { kind: 'class', pattern: /^\s*properties\s*(?:\([^)]*\))?/gm },
    // methods block (marker)
    { kind: 'class', pattern: /^\s*methods\s*(?:\([^)]*\))?/gm },
    // global/persistent variable declarations
    { kind: 'variable', pattern: /^\s*(?:global|persistent)\s+(\w+)/gm },
    // constant assignments: NAME = value (at top level, all-caps convention)
    { kind: 'constant', pattern: /^\s*([A-Z][A-Z_0-9]+)\s*=/gm },
  ],
  importPatterns: [
    // import package.name.*
    { pattern: /^\s*import\s+([\w.]+)/gm },
    // addpath('dir')
    { pattern: /^\s*addpath\s*\(\s*'([^']+)'/gm },
  ],
});

export const MatlabLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
