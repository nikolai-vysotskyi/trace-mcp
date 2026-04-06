/**
 * Centralized tree-sitter parser factory using web-tree-sitter (WASM).
 *
 * Provides lazy async initialization and per-language parser caching.
 * All language/integration plugins should import `getParser` from here
 * instead of loading native tree-sitter bindings directly.
 */
import Parser from 'web-tree-sitter';
import { createRequire } from 'node:module';

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Parser.Language>();
const parserCache = new Map<string, Parser>();

const LANG_WASM_MAP: Record<string, string> = {
  bash: 'tree-sitter-bash.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  css: 'tree-sitter-css.wasm',
  dart: 'tree-sitter-dart.wasm',
  elisp: 'tree-sitter-elisp.wasm',
  elixir: 'tree-sitter-elixir.wasm',
  elm: 'tree-sitter-elm.wasm',
  embedded_template: 'tree-sitter-embedded_template.wasm',
  go: 'tree-sitter-go.wasm',
  html: 'tree-sitter-html.wasm',
  java: 'tree-sitter-java.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  json: 'tree-sitter-json.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  lua: 'tree-sitter-lua.wasm',
  objc: 'tree-sitter-objc.wasm',
  ocaml: 'tree-sitter-ocaml.wasm',
  php: 'tree-sitter-php.wasm',
  python: 'tree-sitter-python.wasm',
  ql: 'tree-sitter-ql.wasm',
  rescript: 'tree-sitter-rescript.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  rust: 'tree-sitter-rust.wasm',
  scala: 'tree-sitter-scala.wasm',
  solidity: 'tree-sitter-solidity.wasm',
  swift: 'tree-sitter-swift.wasm',
  systemrdl: 'tree-sitter-systemrdl.wasm',
  tlaplus: 'tree-sitter-tlaplus.wasm',
  toml: 'tree-sitter-toml.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  vue: 'tree-sitter-vue.wasm',
  yaml: 'tree-sitter-yaml.wasm',
  zig: 'tree-sitter-zig.wasm',
};

const _require = createRequire(import.meta.url);

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

export async function getParser(language: string): Promise<Parser> {
  await ensureInit();

  if (parserCache.has(language)) return parserCache.get(language)!;

  const wasmFile = LANG_WASM_MAP[language];
  if (!wasmFile) throw new Error(`Unsupported tree-sitter language: ${language}`);

  let lang = languageCache.get(language);
  if (!lang) {
    const wasmPath = _require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
    lang = await Parser.Language.load(wasmPath);
    languageCache.set(language, lang);
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(language, parser);
  return parser;
}

export type TSNode = Parser.SyntaxNode;
