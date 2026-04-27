/**
 * R Language Plugin — regex-based symbol extraction.
 *
 * Extracts: function definitions (name <- function, name = function),
 *           S4 classes (setClass), generics (setGeneric), methods (setMethod).
 * Imports: library(), require(), source().
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'r',
  language: 'r',
  extensions: ['.r', '.R', '.Rmd'],
  symbolPatterns: [
    // name <- function(
    {
      kind: 'function',
      pattern: /\b([a-zA-Z_.][a-zA-Z0-9_.]*)\s*<-\s*function\s*\(/gm,
    },
    // name = function(
    {
      kind: 'function',
      pattern: /\b([a-zA-Z_.][a-zA-Z0-9_.]*)\s*=\s*function\s*\(/gm,
    },
    // setClass("Name", ...)
    {
      kind: 'class',
      pattern: /\bsetClass\s*\(\s*["']([^"']+)["']/gm,
      meta: { s4: true },
    },
    // setGeneric("name", ...)
    {
      kind: 'function',
      pattern: /\bsetGeneric\s*\(\s*["']([^"']+)["']/gm,
      meta: { s4: true, generic: true },
    },
    // setMethod("name", ...)
    {
      kind: 'method',
      pattern: /\bsetMethod\s*\(\s*["']([^"']+)["']/gm,
      meta: { s4: true },
    },
  ],
  importPatterns: [
    // library(name) or require(name)
    {
      pattern: /\b(?:library|require)\s*\(\s*["']?([a-zA-Z_.][a-zA-Z0-9_.]*)["']?\s*\)/gm,
    },
    // source("file")
    {
      pattern: /\bsource\s*\(\s*["']([^"']+)["']\s*\)/gm,
    },
  ],
});

export const RLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
