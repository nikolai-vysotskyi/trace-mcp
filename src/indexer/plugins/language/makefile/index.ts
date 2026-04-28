/**
 * Makefile Language Plugin — regex-based symbol extraction.
 *
 * Extracts: targets, variable definitions, define blocks, include directives.
 */

import type { LanguagePlugin } from '../../../../plugin-api/types.js';
import { createRegexLanguagePlugin } from '../regex-base.js';

const _plugin = createRegexLanguagePlugin({
  name: 'makefile',
  language: 'makefile',
  extensions: ['Makefile', 'makefile', '.mk', 'GNUmakefile'],
  symbolPatterns: [
    // target: [deps] (not variable assignments, not comments, not tabs)
    { kind: 'function', pattern: /^([a-zA-Z_][\w.-]*)(?:\s+[a-zA-Z_][\w.-]*)?\s*:[^=]/gm },
    // .PHONY: target1 target2
    { kind: 'function', pattern: /^\.PHONY:\s+(.+)/gm },
    // NAME = value / NAME := value / NAME ?= value / NAME += value
    { kind: 'variable', pattern: /^([A-Za-z_]\w*)\s*(?::=|\?=|\+=|=)/gm },
    // define NAME
    { kind: 'function', pattern: /^define\s+(\w+)/gm, meta: { define: true } },
    // export NAME
    { kind: 'variable', pattern: /^export\s+([A-Za-z_]\w*)/gm, meta: { exported: true } },
  ],
  importPatterns: [
    // include file.mk / -include file.mk
    { pattern: /^-?include\s+(\S+)/gm },
  ],
});

export const MakefileLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
