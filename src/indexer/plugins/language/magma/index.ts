/**
 * Magma Language Plugin — regex-based symbol extraction.
 *
 * Magma is a computer algebra system for algebra, number theory, and geometry.
 * Extracts: functions, procedures, intrinsics, types, records, and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'magma',
  language: 'magma',
  extensions: ['.m', '.mag', '.magma'],
  priority: 4,
  symbolPatterns: [
    // function name(
    { kind: 'function', pattern: /^\s*function\s+(\w+)\s*\(/gm },
    // procedure name(
    { kind: 'function', pattern: /^\s*procedure\s+(\w+)\s*\(/gm },
    // intrinsic name(
    { kind: 'function', pattern: /^\s*intrinsic\s+(\w+)\s*\(/gm },
    // forward name;
    { kind: 'function', pattern: /^\s*forward\s+(\w+)\s*;/gm },
    // Type name = ...
    { kind: 'type', pattern: /^\s*Type\s+(\w+)/gm },
    // record Name
    { kind: 'class', pattern: /^\s*(?:rec|record)\s+(\w+)/gim },
    // Name := ... (top-level variable assignment)
    { kind: 'variable', pattern: /^(\w+)\s*:=/gm },
  ],
  importPatterns: [
    // load "file";
    { pattern: /^\s*load\s+"([^"]+)"/gm },
    // Attach("file");
    { pattern: /^\s*Attach\s*\(\s*"([^"]+)"/gm },
    // AttachSpec("spec");
    { pattern: /^\s*AttachSpec\s*\(\s*"([^"]+)"/gm },
  ],
});

export const MagmaLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
