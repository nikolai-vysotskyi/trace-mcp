/**
 * Lua Language Plugin — regex-based symbol extraction.
 *
 * Extracts: global/local functions, module methods, local variables.
 * Imports: require() calls.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'lua',
  language: 'lua',
  extensions: ['.lua'],
  symbolPatterns: [
    // function Module.name( or function Module:name(
    {
      kind: 'method',
      pattern: /\bfunction\s+([a-zA-Z_][a-zA-Z0-9_]*)([.:])([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm,
      nameGroup: 3,
      parentGroup: 1,
    },
    // local function name(
    {
      kind: 'function',
      pattern: /\blocal\s+function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm,
      meta: { local: true },
    },
    // function name( (global, but not Module.name which is matched above)
    {
      kind: 'function',
      pattern: /\bfunction\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm,
    },
    // Table field function assignment: Module.name = function( or Module:name = function(
    {
      kind: 'method',
      pattern: /\b([a-zA-Z_]\w*)[.:]\s*([a-zA-Z_]\w*)\s*=\s*function\s*\(/gm,
      nameGroup: 2,
      parentGroup: 1,
    },
    // local name = ...
    {
      kind: 'variable',
      pattern: /\blocal\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/gm,
    },
  ],
  importPatterns: [
    // require("module") or require "module" or require('module') or require 'module'
    {
      pattern: /\brequire\s*\(?["']([^"']+)["']\)?/gm,
    },
  ],
});

export const LuaLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
