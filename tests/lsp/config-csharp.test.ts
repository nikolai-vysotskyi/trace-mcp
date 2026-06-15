/**
 * Regression guard: C# must resolve through the LSP language gates.
 *
 * The failure mode being guarded is silent — if either mapping is dropped,
 * collectCallableSymbols() filters out every C# symbol before LSP enrichment
 * runs, so the call graph never gets upgraded and nothing errors. Keep both.
 */
import { describe, expect, it } from 'vitest';
import { EXTENSION_TO_LANGUAGE, fileLanguageToLspLanguage } from '../../src/lsp/config.js';

describe('C# LSP language gates', () => {
  it('maps the file language to an LSP language id (the collectCallableSymbols gate)', () => {
    expect(fileLanguageToLspLanguage('csharp')).toBe('csharp');
  });

  it('maps .cs / .csx extensions to csharp (the didOpen languageId)', () => {
    expect(EXTENSION_TO_LANGUAGE['.cs']).toBe('csharp');
    expect(EXTENSION_TO_LANGUAGE['.csx']).toBe('csharp');
  });
});
