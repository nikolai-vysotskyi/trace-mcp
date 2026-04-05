/**
 * COBOL Language Plugin — regex-based symbol extraction.
 *
 * Extracts: divisions, sections, paragraphs, data items, COPY statements.
 * COBOL is case-insensitive; patterns use the 'i' flag.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'cobol',
  language: 'cobol',
  extensions: ['.cob', '.cbl', '.cpy', '.cobol'],
  symbolPatterns: [
    // PROGRAM-ID. program-name.
    { kind: 'module', pattern: /^\s*PROGRAM-ID\.\s+(\S+)/gim },
    // IDENTIFICATION/ENVIRONMENT/DATA/PROCEDURE DIVISION
    { kind: 'namespace', pattern: /^\s*(\w[\w-]*)\s+DIVISION/gim },
    // section-name SECTION.
    { kind: 'class', pattern: /^\s{0,6}\s*(\w[\w-]*)\s+SECTION\s*\./gim },
    // paragraph-name.  (at start of line, area A — columns 8-11 typically, but regex is flexible)
    { kind: 'function', pattern: /^(\s{0,3}[\w][\w-]*)\s*\.\s*$/gim },
    // 01-49 level data items: 01 WS-NAME
    { kind: 'variable', pattern: /^\s*(0[1-9]|[1-4]\d)\s+([\w-]+)/gim, nameGroup: 2 },
    // 77 level standalone items
    { kind: 'variable', pattern: /^\s*77\s+([\w-]+)/gim },
    // 88 level condition names
    { kind: 'constant', pattern: /^\s*88\s+([\w-]+)/gim },
  ],
  importPatterns: [
    // COPY copybook-name.
    { pattern: /^\s*COPY\s+(\S+)/gim },
  ],
});

export const CobolLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
