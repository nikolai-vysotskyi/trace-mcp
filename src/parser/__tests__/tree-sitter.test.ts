/**
 * Guard for the grammar WASM contract.
 *
 * A grammar built for an ABI the installed web-tree-sitter no longer accepts
 * fails at `Language.load` with an empty-message Error, which every plugin
 * swallows into "0 symbols extracted" — silently, across hundreds of tests.
 * That is exactly how the 0.24 → 0.26 bump stayed stuck for four months
 * (TRA-330), so assert every advertised language really parses.
 */

import { describe, expect, it } from 'vitest';
import { getParser, LANG_GRAMMARS } from '../tree-sitter.js';

describe('tree-sitter grammars', () => {
  it.each(Object.keys(LANG_GRAMMARS))('loads and parses %s', async (language) => {
    const parser = await getParser(language);
    const tree = parser.parse('x');
    try {
      expect(tree.rootNode.type).toBeTruthy();
    } finally {
      tree.delete();
    }
  });

  it('rejects an unknown language', async () => {
    await expect(getParser('klingon')).rejects.toThrow(/Unsupported tree-sitter language/);
  });
});
