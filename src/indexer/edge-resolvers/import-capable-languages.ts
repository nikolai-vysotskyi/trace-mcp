/**
 * Which languages' `imports` edges actually reach the graph (TRA-449).
 *
 * A plugin extracting import statements is not enough — the specifier has to be
 * resolved to a target node by a pipeline pass, or the edge is dropped. The
 * capability matrix used to derive its Imports column from "the plugin declares
 * import patterns" and so claimed 66 of 81 languages. Indexing a fixture where
 * every language performs one real cross-file import originally produced edges
 * for only four: php, python, typescript and vue. Go, Rust, C, C++, Java,
 * Ruby, Astro, Svelte, C# and Kotlin have since gained resolvers (in that
 * order); Swift, Elixir and Lua still extract an import that nothing
 * consumes.
 *
 * Astro and Svelte needed no new resolver pass (TRA-451): both extract
 * `imports` edges carrying plain filesystem-path specifiers — Astro's
 * frontmatter/`<script>` blocks go through the same tree-sitter helper as
 * TypeScript, Svelte's regex plugin already emits `from`/`module` specifiers
 * — so joining `ESM_IMPORT_LANGUAGES` was sufficient. `.svelte` was already
 * in the resolver's extension list (for `.ts` files importing a component);
 * `.astro` was added alongside it.
 *
 * Adding a language here means adding or extending a resolver pass in
 * `src/indexer/pipeline.ts` — not editing a list.
 */

/**
 * Languages whose `imports` edges carry filesystem-path specifiers and are
 * resolved by `resolveEsmImportEdges` via oxc-resolver. CSS/HTML/XML/SVG
 * `@import`/`href`/`src` targets go through the same pass — without them asset
 * files stay isolated in the graph.
 */
export const ESM_IMPORT_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'vue',
  'astro',
  'svelte',
  'css',
  'scss',
  'sass',
  'less',
  'stylus',
  'html',
  'xml',
  'svg',
]);

/** Every language with a pipeline pass that turns its imports into graph edges. */
export const IMPORT_EDGE_LANGUAGES: ReadonlySet<string> = new Set([
  ...ESM_IMPORT_LANGUAGES,
  'python', // resolvePythonImportEdges
  'php', // resolvePhpImportEdges
  'go', // resolveGoImportEdges
  'java', // resolveJavaImportEdges
  'rust', // resolveRustImportEdges
  'c', // resolveCImportEdges
  'cpp', // resolveCImportEdges
  'ruby', // resolveRubyImportEdges
  'csharp', // resolveCSharpImportEdges
  'kotlin', // resolveKotlinImportEdges
  'yaml', // resolveIacImportEdges — kustomize / docker-compose refs
  'hcl', // resolveIacImportEdges — local terraform module sources
  'markdown', // resolveMarkdownWikilinkEdges
]);
