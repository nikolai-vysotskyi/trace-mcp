/**
 * Zig Language Plugin — regex-based symbol extraction.
 *
 * Extracts: functions, structs, enums, unions, constants, variables, test declarations, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'zig',
  language: 'zig',
  extensions: ['.zig'],
  symbolPatterns: [
    // pub fn name / fn name
    { kind: 'function', pattern: /^\s*(?:pub\s+)?fn\s+(\w+)/gm },
    // pub const name = struct { / enum { / union {
    { kind: 'class', pattern: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*(?:packed\s+|extern\s+)?struct\b/gm },
    { kind: 'class', pattern: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*(?:packed\s+|extern\s+)?enum\b/gm },
    { kind: 'class', pattern: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*(?:packed\s+|extern\s+)?union\b/gm },
    // pub const / const (non-struct/enum/union)
    { kind: 'constant', pattern: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*(?!(?:packed\s+|extern\s+)?(?:struct|enum|union)\b)/gm },
    // var declarations
    { kind: 'variable', pattern: /^\s*(?:pub\s+)?var\s+(\w+)/gm },
    // test "name" or test name
    { kind: 'function', pattern: /^\s*test\s+"([^"]+)"/gm, meta: { test: true } },
    { kind: 'function', pattern: /^\s*test\s+(\w+)/gm, meta: { test: true } },
  ],
  importPatterns: [
    // @import("path")
    { pattern: /@import\("([^"]+)"\)/gm },
  ],
});

export const ZigLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
