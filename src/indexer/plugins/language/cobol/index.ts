/**
 * COBOL Language Plugin — multi-pass regex extraction.
 *
 * Pass 1: Containers — DIVISION, SECTION, FD/SD file descriptors, 01-level records
 * Pass 2: Members — paragraphs in sections, data items in records, conditions
 *
 * Comment stripping: * in column 7 (traditional), *> (free-format)
 * Scope: keyword-end (DIVISION → next DIVISION, SECTION → next SECTION)
 *
 * COBOL is case-insensitive; patterns use the 'i' flag.
 */
import { createMultiPassPlugin, type CommentStyle, type ScopeConfig } from '../regex-base-v2.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const comments: CommentStyle = {
  // COBOL comments: * in column 7 (handled by line pattern), *> inline
  // Don't strip strings — COBOL string literals appear in CALL/COPY patterns
  line: ['*>'],
  block: [],
  strings: [],
};

const scope: ScopeConfig = {
  style: 'keyword-end',
  openKeywords: /\b(?:DIVISION|SECTION)\b/gi,
  endKeywords: /\b(?:DIVISION|SECTION|STOP\s+RUN|GOBACK)\b/gi,
};

const _plugin = createMultiPassPlugin({
  name: 'cobol',
  language: 'cobol',
  extensions: ['.cob', '.cbl', '.cpy', '.cobol'],
  comments,
  scope,

  containerPatterns: [
    // IDENTIFICATION/ENVIRONMENT/DATA/PROCEDURE DIVISION
    {
      kind: 'namespace',
      pattern: /^\s{0,6}\s*([\w-]+)\s+DIVISION/gim,
      memberPatterns: [
        // SECTION inside DIVISION
        { kind: 'class', pattern: /^\s{0,6}\s*([\w-]+)\s+SECTION\s*\./gim },
      ],
    },
    // section-name SECTION.
    {
      kind: 'class',
      pattern: /^\s{0,6}\s*([\w-]+)\s+SECTION\s*\./gim,
      memberPatterns: [
        // Paragraph names (at area A, followed by period)
        { kind: 'function', pattern: /^[ ]{7}([\w][\w-]*)\s*\.\s*$/gim },
      ],
    },
    // 01-level record definitions
    {
      kind: 'class',
      pattern: /^\s*01\s+([\w-]+)/gim,
      meta: { record: true },
      memberPatterns: [
        // 02-49 level data items (fields inside record)
        { kind: 'property', pattern: /^\s*(?:0[2-9]|[1-4]\d)\s+([\w-]+)/gim },
        // 88 level condition names
        { kind: 'constant', pattern: /^\s*88\s+([\w-]+)/gim },
      ],
    },
    // FD file-name (File Description)
    {
      kind: 'class',
      pattern: /^\s*FD\s+([\w-]+)/gim,
      meta: { fileDesc: true },
      memberPatterns: [{ kind: 'property', pattern: /^\s*(?:0[1-9]|[1-4]\d)\s+([\w-]+)/gim }],
    },
  ],

  symbolPatterns: [
    // PROGRAM-ID. program-name.
    { kind: 'module', pattern: /^\s*PROGRAM-ID\.\s+([\w-]+)/gim },
    // Paragraph names at area A
    { kind: 'function', pattern: /^[ ]{7}([\w][\w-]*)\s*\.\s*$/gim },
    // 01-level standalone
    { kind: 'class', pattern: /^\s*01\s+([\w-]+)/gim },
    // 66 level RENAMES
    { kind: 'variable', pattern: /^\s*66\s+([\w-]+)/gim },
    // 77 level standalone items
    { kind: 'variable', pattern: /^\s*77\s+([\w-]+)/gim },
    // 88 level condition names (standalone)
    { kind: 'constant', pattern: /^\s*88\s+([\w-]+)/gim },
    // SD sort-file-name
    { kind: 'class', pattern: /^\s*SD\s+([\w-]+)/gim, meta: { sortDesc: true } },
  ],

  importPatterns: [
    // COPY copybook-name.
    { pattern: /\bCOPY\s+([\w-]+)/gim },
    // CALL 'program-name'
    { pattern: /\bCALL\s+'([\w-]+)'/gim },
    // CALL identifier USING
    { pattern: /\bCALL\s+([\w-]+)(?:\s+USING)?/gim },
    // PERFORM paragraph-name [THRU paragraph-name]
    { pattern: /\bPERFORM\s+([\w-]+)(?:\s+THRU\s+[\w-]+)?/gim },
  ],
});

export const CobolLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
