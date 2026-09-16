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
import {
  Edit,
  Language,
  type Node,
  type ParseCallback,
  Parser,
  type Point,
  type Tree,
} from 'web-tree-sitter';

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
/** In-flight per-language loads coalesced by getParser (TRA-1577). */
const parserInitPromises = new Map<string, Promise<TSParser>>();

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

  const hit = parserCache.get(language);
  if (hit) return hit;

  // TRA-1577: coalesce concurrent first-loads. Without this, N files
  // extracting in one `Promise.all` chunk (the standard in-process path)
  // each miss the cache, each `Language.load()` the same grammar, and the
  // last writer wins — leaving duplicate WASM Language instances alive and,
  // worse, trees pinned to a Language instance no cached parser uses. This
  // build returns null when an old tree's Language address differs from the
  // parsing parser's, so cross-instance reuse silently poisoned the per-file
  // incremental cache. Sharing one in-flight promise per language keeps a
  // single Language + Parser per grammar however the calls interleave.
  let inflight = parserInitPromises.get(language);
  if (!inflight) {
    inflight = loadParser(language);
    parserInitPromises.set(language, inflight);
  }
  try {
    return await inflight;
  } finally {
    if (parserInitPromises.get(language) === inflight) parserInitPromises.delete(language);
  }
}

async function loadParser(language: string): Promise<TSParser> {
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

/**
 * UTF-16 offset → tree-sitter Point (row + column).
 *
 * web-tree-sitter 0.27 feeds the parser through `stringToUTF16`, so indices
 * AND columns are UTF-16 code units — not the UTF-8 bytes classic tree-sitter
 * uses. Verified empirically: `const x = 関数;` reports the identifier as
 * [10,12] (2 UTF-16 units), not [10,16] (6 UTF-8 bytes). ASCII-only inputs
 * take the same path — no separate fast path to keep the two from drifting
 * apart.
 */
function offsetToPoint(text: string, utf16Offset: number): Point {
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < utf16Offset; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      row++;
      lineStart = i + 1;
    }
  }
  return { row, column: utf16Offset - lineStart };
}

/**
 * Describe the change from `oldText` to `newText` as a single tree-sitter
 * Edit (common prefix + common suffix). Returns null when the texts are
 * identical — there is nothing to apply to the old tree.
 *
 * Single-edit only: a watcher coalesces one file write into one call, so one
 * contiguous span covers the prototype. Callers with several disjoint edits
 * should apply one Edit per span (oldest span first) instead of forcing them
 * through here.
 */
export function computeSingleEdit(oldText: string, newText: string): Edit | null {
  if (oldText === newText) return null;
  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  // All indices/columns are UTF-16 code units (see offsetToPoint): the scan
  // above already works in those units, so no byte conversion here.
  return new Edit({
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: offsetToPoint(oldText, start),
    oldEndPosition: offsetToPoint(oldText, oldEnd),
    newEndPosition: offsetToPoint(newText, newEnd),
  });
}

/**
 * Prototype incremental reparse for single-file watcher edits (TRA-1540).
 *
 * Applies `tree.edit()` for the oldText → newText change, then reuses the
 * cached parser with the edited old tree so unchanged subtrees are recycled
 * instead of reparsed. Returns a tree whose S-expression is identical to a
 * full `parse(newText)` — see `incremental-reparse.test.ts`.
 *
 * Ownership: mirrors `Parser.parse` — the old tree is NOT freed (the caller
 * deletes it when done; tests need it alive for `getChangedRanges`). When the
 * texts are identical no reparse happens and `oldTree` itself is returned.
 */
export async function parseIncremental(
  language: string,
  oldTree: Tree,
  oldText: string,
  newText: string,
): Promise<Tree> {
  if (oldText === newText) return oldTree;
  const edit = computeSingleEdit(oldText, newText);
  if (!edit) return oldTree;
  oldTree.edit(edit);
  const parser = await getParser(language);
  return parser.parse(newText, oldTree);
}

export type TSNode = Node;
