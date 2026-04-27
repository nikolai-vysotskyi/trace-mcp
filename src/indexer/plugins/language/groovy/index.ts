/**
 * Groovy Language Plugin — regex-based symbol extraction.
 *
 * Extracts: classes, interfaces, enums, traits, methods (def / typed),
 * and import edges.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'groovy',
  language: 'groovy',
  extensions: ['.groovy', '.gradle', '.gvy'],
  symbolPatterns: [
    // class
    {
      kind: 'class',
      pattern:
        /^\s*(?:@\w+\s+)*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+|static\s+)*class\s+(\w+)/gm,
    },
    // interface
    {
      kind: 'interface',
      pattern: /^\s*(?:@\w+\s+)*(?:public\s+|private\s+|protected\s+)?interface\s+(\w+)/gm,
    },
    // enum
    {
      kind: 'enum',
      pattern: /^\s*(?:@\w+\s+)*(?:public\s+|private\s+|protected\s+)?enum\s+(\w+)/gm,
    },
    // trait
    {
      kind: 'trait',
      pattern: /^\s*(?:@\w+\s+)*(?:public\s+|private\s+|protected\s+)?trait\s+(\w+)/gm,
    },
    // def method
    {
      kind: 'function',
      pattern:
        /^\s*(?:@\w+\s+)*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:synchronized\s+)?def\s+(\w+)\s*\(/gm,
    },
    // typed method (void/String/int/etc followed by name and paren)
    {
      kind: 'function',
      pattern:
        /^\s*(?:@\w+\s+)*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:synchronized\s+)?(?:void|boolean|byte|char|short|int|long|float|double|[A-Z]\w*(?:<[^>]*>)?)\s+(\w+)\s*\(/gm,
    },
  ],
  importPatterns: [{ pattern: /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/gm }],
});

export const GroovyLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
