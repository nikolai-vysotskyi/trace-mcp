/**
 * AL Language Plugin — regex-based symbol extraction.
 *
 * Extracts: tables, pages, codeunits, reports, enums, interfaces,
 * procedures, and triggers for Microsoft Dynamics 365 Business Central.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'al',
  language: 'al',
  extensions: ['.al'],
  symbolPatterns: [
    // table N "Name"
    {
      kind: 'class',
      pattern: /^\s*table\s+\d+\s+"([^"]+)"/gmi,
      meta: { alKind: 'table' },
    },
    // page N "Name"
    {
      kind: 'class',
      pattern: /^\s*page\s+\d+\s+"([^"]+)"/gmi,
      meta: { alKind: 'page' },
    },
    // codeunit N "Name"
    {
      kind: 'class',
      pattern: /^\s*codeunit\s+\d+\s+"([^"]+)"/gmi,
      meta: { alKind: 'codeunit' },
    },
    // report N "Name"
    {
      kind: 'class',
      pattern: /^\s*report\s+\d+\s+"([^"]+)"/gmi,
      meta: { alKind: 'report' },
    },
    // enum N "Name"
    {
      kind: 'enum',
      pattern: /^\s*enum\s+\d+\s+"([^"]+)"/gmi,
    },
    // interface "Name"
    {
      kind: 'interface',
      pattern: /^\s*interface\s+"([^"]+)"/gmi,
    },
    // procedure Name(
    {
      kind: 'function',
      pattern: /^\s*(?:local\s+|internal\s+)?procedure\s+(\w+)\s*\(/gmi,
    },
    // trigger Name(
    {
      kind: 'function',
      pattern: /^\s*trigger\s+(\w+)\s*\(/gmi,
      meta: { trigger: true },
    },
  ],
});

export const AlLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
