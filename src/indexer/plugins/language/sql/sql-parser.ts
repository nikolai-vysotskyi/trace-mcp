/**
 * Lazy tree-sitter-sql parser (WASM). Not yet registered in LANG_GRAMMARS —
 * SQL indexing still uses the regex plugin until Phase 3 integration.
 */
import { getWasmPath } from 'tree-sitter-wasm';
import { ensureInitialized } from '../../../../parser/tree-sitter.js';
import { Language, Parser, type Tree } from 'web-tree-sitter';

let languagePromise: Promise<Language> | null = null;
let parserPromise: Promise<Parser> | null = null;

async function loadLanguage(): Promise<Language> {
  if (!languagePromise) {
    languagePromise = ensureInitialized().then(() => Language.load(getWasmPath('sql')));
  }
  return languagePromise;
}

export async function parseSqlSource(source: string): Promise<Tree> {
  if (!parserPromise) {
    parserPromise = loadLanguage().then((lang) => {
      const parser = new Parser();
      parser.setLanguage(lang);
      return parser;
    });
  }
  const parser = await parserPromise;
  const tree = parser.parse(source);
  if (!tree) throw new Error('tree-sitter-sql returned null tree');
  return tree;
}
