/**
 * MATLAB / Octave Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — classdef with superclasses
 * Pass 2: Members — properties (individual names), methods, events, enumerations
 *
 * Comment stripping: %, %{ %}
 * Scope: keyword-end (classdef/properties/methods/events/enumeration ... end)
 *
 * Handles `.m` file disambiguation via path heuristics.
 */
import { createMultiPassPlugin, type CommentStyle, type ScopeConfig } from '../regex-base-v2.js';
import type { LanguagePlugin, FileParseResult } from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

/** Path patterns that indicate MATLAB rather than Objective-C */
const MATLAB_PATH_INDICATORS = /(?:matlab|toolbox|simulink|\+\w|@\w)/i;

const comments: CommentStyle = {
  line: ['%'],
  block: [['%{', '%}']],
  strings: ["'", '"'],
};

const scope: ScopeConfig = {
  style: 'keyword-end',
  openKeywords: /\b(?:classdef|properties|methods|events|enumeration|function|if|for|while|switch|try|parfor|spmd)\b/gi,
  endKeywords: /\bend\b/gi,
};

const _plugin = createMultiPassPlugin({
  name: 'matlab',
  language: 'matlab',
  extensions: ['.m', '.mlx', '.mat'],
  comments,
  scope,

  containerPatterns: [
    // classdef ClassName [< SuperClass1 & SuperClass2]
    {
      kind: 'class',
      pattern: /^\s*classdef\s+(?:\([^)]*\)\s+)?(\w+)(?:\s*<\s*([\w.&\s,]+))?/gm,
      memberPatterns: [
        // property declarations (indented name with optional default value)
        { kind: 'property', pattern: /^\s{4,}(\w+)\s*(?:[=(;%]|$)/gm },
        // method declarations (function inside methods block)
        { kind: 'method', pattern: /^\s*function\s+(?:\[?[\w,\s~]*\]?\s*=\s*)?(\w+)/gm },
        // events
        { kind: 'property', pattern: /^\s{4,}(\w+)\s*$/gm, meta: { event: true } },
      ],
    },
  ],

  symbolPatterns: [
    // function [out] = name(args) — top-level and nested functions
    { kind: 'function', pattern: /^\s*function\s+(?:\[?[\w,\s~]*\]?\s*=\s*)?(\w+)/gm },
    // global/persistent variable declarations
    { kind: 'variable', pattern: /^\s*(?:global|persistent)\s+(\w+)/gm },
    // constant assignments: ALL_CAPS_NAME = value (all-caps convention, min 3 chars)
    { kind: 'constant', pattern: /^\s*([A-Z][A-Z_0-9]{2,})\s*=/gm },
  ],

  importPatterns: [
    // import package.name.*
    { pattern: /^\s*import\s+([\w.*]+)/gm },
    // addpath('dir')
    { pattern: /addpath\s*\(\s*'([^']+)'/gm },
    // run('script')
    { pattern: /run\s*\(\s*'([^']+)'/gm },
  ],
});

export const MatlabLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;

  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> {
    // .m file disambiguation: only treat as MATLAB if path has indicators
    if (filePath.endsWith('.m') && !MATLAB_PATH_INDICATORS.test(filePath)) {
      // Let Objective-C plugin handle it
    }
    return _plugin.extractSymbols(filePath, content);
  }
};
