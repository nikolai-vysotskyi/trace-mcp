/**
 * GLSL Language Plugin — regex-based symbol extraction.
 *
 * Extracts: functions, structs, uniforms, varyings, attributes, constants, and import edges (preprocessor).
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'glsl',
  language: 'glsl',
  extensions: ['.glsl', '.vert', '.frag', '.geom', '.tesc', '.tese', '.comp'],
  symbolPatterns: [
    // returnType funcName(...)
    { kind: 'function', pattern: /^\s*(?:void|float|int|uint|bool|vec[234]|[iu]?vec[234]|mat[234](?:x[234])?|sampler\w+|[\w]+)\s+(\w+)\s*\(/gm },
    // struct Name {
    { kind: 'class', pattern: /^\s*struct\s+(\w+)/gm },
    // uniform type name
    { kind: 'variable', pattern: /^\s*uniform\s+[\w]+\s+(\w+)/gm, meta: { uniform: true } },
    // in / out / varying / attribute type name
    { kind: 'variable', pattern: /^\s*(?:in|out|varying|attribute)\s+[\w]+\s+(\w+)/gm },
    // layout(...) in/out/uniform type name
    { kind: 'variable', pattern: /^\s*layout\s*\([^)]*\)\s+(?:in|out|uniform)\s+[\w]+\s+(\w+)/gm },
    // const type name
    { kind: 'constant', pattern: /^\s*const\s+[\w]+\s+(\w+)/gm },
    // #define NAME
    { kind: 'constant', pattern: /^\s*#define\s+(\w+)/gm },
  ],
  importPatterns: [
    // #include "file"
    { pattern: /^\s*#include\s+[<"]([^>"]+)[>"]/gm },
  ],
});

export const GlslLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
