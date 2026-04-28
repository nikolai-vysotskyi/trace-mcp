/**
 * Wolfram / Mathematica Language Plugin — regex-based symbol extraction.
 *
 * Extracts: function definitions, module/block scoping, package declarations,
 * Set/SetDelayed assignments, and import edges (Get/Needs).
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'wolfram',
  language: 'wolfram',
  extensions: ['.wl', '.wls', '.m', '.nb', '.mt'],
  priority: 4,
  symbolPatterns: [
    // name[args_] := body (SetDelayed — function definition)
    { kind: 'function', pattern: /^\s*(\w+)\s*\[[^\]]*_[^\]]*\]\s*:=/gm },
    // name[args_] = body (Set — function definition)
    { kind: 'function', pattern: /^\s*(\w+)\s*\[[^\]]*_[^\]]*\]\s*(?::=|=)/gm },
    // BeginPackage["Name`"]
    { kind: 'namespace', pattern: /BeginPackage\s*\[\s*"([^"]+)"/gm },
    // Begin["`Private`"]
    { kind: 'namespace', pattern: /Begin\s*\[\s*"([^"]+)"/gm },
    // name::usage = "..."
    { kind: 'variable', pattern: /^\s*(\w+)::usage\s*=/gm, meta: { usage: true } },
    // Options[name] = { ... }
    { kind: 'variable', pattern: /^\s*Options\s*\[\s*(\w+)\s*\]/gm, meta: { options: true } },
    // name = value (simple top-level assignment, capitalized convention)
    { kind: 'variable', pattern: /^\s*([A-Z]\w+)\s*=\s*[^=]/gm },
    // SetAttributes[name, ...]
    { kind: 'variable', pattern: /SetAttributes\s*\[\s*(\w+)/gm, meta: { attributes: true } },
  ],
  importPatterns: [
    // Get["file"] or << file
    { pattern: /Get\s*\[\s*"([^"]+)"/gm },
    { pattern: /<<\s*(\S+)/gm },
    // Needs["Package`"]
    { pattern: /Needs\s*\[\s*"([^"]+)"/gm },
  ],
});

export const WolframLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
