/**
 * GDScript Language Plugin — regex-based symbol extraction.
 *
 * Extracts: functions, classes, class_name, enums, signals, constants, variables, @export vars.
 * Imports: preload() and load() calls.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'gdscript',
  language: 'gdscript',
  extensions: ['.gd'],
  symbolPatterns: [
    // class_name Name (allow any valid identifier)
    {
      kind: 'class',
      pattern: /^\s*class_name\s+(\w+)/gm,
    },
    // class Name (inner class)
    {
      kind: 'class',
      pattern: /^\s*class\s+(\w+)\b/gm,
    },
    // func name(
    {
      kind: 'function',
      pattern: /^\s*func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm,
    },
    // enum Name { (allow any valid identifier)
    {
      kind: 'enum',
      pattern: /^\s*enum\s+(\w+)\b/gm,
    },
    // signal name
    {
      kind: 'property',
      pattern: /^\s*signal\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
      meta: { signal: true },
    },
    // const NAME = ...
    {
      kind: 'constant',
      pattern: /^\s*const\s+([A-Z_][A-Z0-9_]*)\b/gm,
    },
    // @export var name or var name
    {
      kind: 'property',
      pattern: /^\s*(?:@export\s+)?var\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
    },
  ],
  importPatterns: [
    // preload("path") or load("path")
    {
      pattern: /\b(?:preload|load)\s*\(\s*["']([^"']+)["']\s*\)/gm,
    },
  ],
});

export const GdscriptLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
