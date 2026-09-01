/**
 * Centralized tree-sitter parser factory using web-tree-sitter (WASM).
 *
 * Provides lazy async initialization and per-language parser caching.
 * All language/integration plugins should import `getParser` from here
 * instead of loading native tree-sitter bindings directly.
 *
 * Note on native bindings: we evaluated `tree-sitter` (N-API) as a faster
 * alternative for top languages (TS/JS/PHP/Python). Native parses ~2.4×
 * faster than WASM, but every JS-side property access on a `SyntaxNode`
 * (`type`, `children`, `text`, `startIndex`, ...) crosses the N-API
 * boundary, which is ~2× slower than the in-process WASM↔JS path.
 * Plugins do far more walking than parsing, so native produced a net
 * regression on this workload (~+30% extract time). Keeping pure WASM.
 */

import { getWasmPath, type SupportedLanguage } from 'tree-sitter-wasm';
import { Language, type Node, type ParseCallback, Parser, type Tree } from 'web-tree-sitter';

/**
 * A `Parser` whose `parse()` is narrowed to non-nullable.
 *
 * web-tree-sitter 0.25+ types `parse()` as `Tree | null`, and per its own docs
 * null is returned only when (a) the parser has no language assigned, or (b) a
 * `ParseOptions` progress callback returned true. `getParser` always assigns a
 * language before handing the parser out, and the narrowed signature drops the
 * `options` parameter so no caller can install a progress callback. Both null
 * branches are therefore unreachable, and the ~80 plugin call sites stay free
 * of dead null checks.
 *
 * ponytail: if a caller ever needs `ParseOptions`, it must use the raw
 * `Parser` type and handle `null` itself rather than widening this alias.
 */
export type TSParser = Omit<Parser, 'parse'> & {
  parse(input: string | ParseCallback, oldTree?: Tree | null): Tree;
};

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Language>();
const parserCache = new Map<string, TSParser>();

/**
 * This codebase's language name → the tree-sitter grammar that parses it.
 * Typed against tree-sitter-wasm, so a grammar that the package stops shipping
 * fails the build instead of throwing on first parse.
 *
 * Adding one here also adds it to the desktop app's server payload — see
 * PAYLOAD_GRAMMARS in `packages/app/scripts/stage-server.mjs`, which ships only
 * these and drops the other 92 MB the package carries. Its test fails if the
 * two drift apart.
 */
export const LANG_GRAMMARS: Record<string, SupportedLanguage> = {
  bash: 'bash',
  c: 'c',
  cpp: 'cpp',
  csharp: 'c_sharp',
  css: 'css',
  dart: 'dart',
  elisp: 'elisp',
  elixir: 'elixir',
  elm: 'elm',
  embedded_template: 'embedded_template',
  go: 'go',
  html: 'html',
  java: 'java',
  javascript: 'javascript',
  json: 'json',
  kotlin: 'kotlin',
  lua: 'lua',
  objc: 'objc',
  ocaml: 'ocaml',
  php: 'php',
  python: 'python',
  ruby: 'ruby',
  rust: 'rust',
  scala: 'scala',
  solidity: 'solidity',
  swift: 'swift',
  toml: 'toml',
  tsx: 'tsx',
  typescript: 'typescript',
  vue: 'vue',
  yaml: 'yaml',
  zig: 'zig',
};

// WHY exported: daemon boot warms Parser.init() eagerly so the first request
// after listen() doesn't pay the WASM cold-start tax.
export function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

function ensureInit(): Promise<void> {
  return ensureInitialized();
}

/**
 * Pre-load tree-sitter grammars for the given languages in parallel.
 * WHY: per-language WASM load is ~30-80 ms; doing it lazily on the first
 * parse stalls the first reindex-file request after daemon cold-start.
 * Unknown languages are silently skipped (no throw) — best-effort warm-up.
 */
export async function warmUpGrammars(languages: readonly string[]): Promise<void> {
  await ensureInitialized();
  const unique = Array.from(new Set(languages.filter((l) => l && LANG_GRAMMARS[l])));
  await Promise.all(
    unique.map((lang) =>
      getParser(lang).catch(() => {
        /* best-effort warm-up: a failed grammar load shouldn't abort the rest */
      }),
    ),
  );
}

export async function getParser(language: string): Promise<TSParser> {
  await ensureInit();

  if (parserCache.has(language)) return parserCache.get(language)!;

  const grammar = LANG_GRAMMARS[language];
  if (!grammar) throw new Error(`Unsupported tree-sitter language: ${language}`);

  let lang = languageCache.get(language);
  if (!lang) {
    lang = await Language.load(getWasmPath(grammar));
    languageCache.set(language, lang);
  }

  // The narrowing holds because setLanguage() runs before the parser escapes.
  const parser = new Parser() as TSParser;
  parser.setLanguage(lang);
  parserCache.set(language, parser);
  return parser;
}

export type TSNode = Node;
