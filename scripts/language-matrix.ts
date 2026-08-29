#!/usr/bin/env tsx
/**
 * Generates docs/language-matrix.md — the capability matrix behind the
 * "81 languages" number (TRA-395).
 *
 * docs/_data/counts.yml says how many language plugins exist. It says nothing
 * about what each one can do, and the spread is two orders of magnitude
 * (python ~2600 LOC vs ini ~28). This derives the per-language capabilities
 * from the code itself, so the published page cannot drift:
 * tests/docs/language-matrix.test.ts fails CI when it does.
 *
 * Nothing here is hand-maintained:
 *   name/extensions — the live plugin registry (same source counts.yml checks)
 *   parser          — which extraction engine the plugin is built on
 *   imports         — plugin declares import patterns, or a <lang>-imports resolver exists
 *   calls           — a src/indexer/edge-resolvers/<lang>-calls.ts resolver exists
 *   types           — a <lang>-types.ts / <lang>-heritage.ts resolver exists
 *   tests           — a test file references the plugin's exported class
 *
 * Usage: pnpm run docs:language-matrix [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { TraceMcpConfigSchema } from '../src/config.js';
import { IMPORT_EDGE_LANGUAGES } from '../src/indexer/edge-resolvers/import-capable-languages.js';
import { createAllLanguagePlugins } from '../src/indexer/plugins/language/all.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANG_DIR = path.join(ROOT, 'src/indexer/plugins/language');
const RESOLVER_DIR = path.join(ROOT, 'src/indexer/edge-resolvers');
const OUT = path.join(ROOT, 'docs/language-matrix.md');

function walk(dir: string, filter: (f: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** Which extraction engine a plugin is built on. */
function classifyParser(source: string): string {
  if (/regex-base-v2\.js|createMultiPassLanguagePlugin/.test(source)) return 'regex (multi-pass)';
  if (/regex-base\.js|createRegexLanguagePlugin/.test(source)) return 'regex';
  if (/tree-sitter|TreeSitter|parseWithGrammar|getParser\b/.test(source)) return 'tree-sitter';
  return 'custom';
}

/** class name -> source directory, read off the imports in all.ts. */
function pluginDirs(): Map<string, string> {
  const all = fs.readFileSync(path.join(LANG_DIR, 'all.ts'), 'utf8');
  const map = new Map<string, string>();
  for (const m of all.matchAll(/import \{ (\w+) \} from '(.+?)\/index\.js'/g)) {
    map.set(m[1], path.resolve(LANG_DIR, m[2]));
  }
  return map;
}

export interface MatrixRow {
  language: string;
  extensions: string[];
  parser: string;
  indexedByDefault: boolean;
  imports: boolean;
  calls: boolean;
  types: boolean;
  tested: boolean;
}

/**
 * Does the shipped default `include` config actually reach a file with this
 * extension? A registered plugin whose extensions no default glob matches is
 * dead weight until the user writes their own `include` — the plugin count and
 * the out-of-the-box coverage are different numbers, and this column is the
 * difference.
 */
function defaultIncludeMatcher(): (ext: string) => boolean {
  const { include } = TraceMcpConfigSchema.parse({});
  const isMatch = picomatch(include, { dot: true });
  // Probe the extension both at the repo root and under the directory roots the
  // default globs are anchored to.
  const roots = ['', 'src/', 'lib/', 'app/', 'tests/', 'pages/', 'server/'];
  return (ext) => {
    const file = ext.startsWith('.') ? `file${ext}` : ext;
    return roots.some((root) => isMatch(`${root}${file}`) || isMatch(`${root}sub/${file}`));
  };
}

export function buildMatrix(): { rows: MatrixRow[]; counts: Record<string, number> } {
  const resolvers = new Set(fs.readdirSync(RESOLVER_DIR));
  const testSources = walk(path.join(ROOT, 'tests'), (f) => f.endsWith('.ts'))
    .concat(walk(path.join(ROOT, 'src'), (f) => f.endsWith('.test.ts')))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const dirs = pluginDirs();
  const reachable = defaultIncludeMatcher();

  const rows: MatrixRow[] = [];
  for (const plugin of createAllLanguagePlugins()) {
    const className = plugin.constructor.name;
    const dir = dirs.get(className);
    const source = dir
      ? walk(dir, (f) => f.endsWith('.ts'))
          .map((f) => fs.readFileSync(f, 'utf8'))
          .join('\n')
      : '';
    // Registry names are `<lang>-language`; resolver files use the bare name.
    const key = plugin.manifest.name.replace(/-language$/, '');
    rows.push({
      language: key,
      extensions: plugin.supportedExtensions,
      parser: classifyParser(source),
      indexedByDefault: plugin.supportedExtensions.some(reachable),
      imports: IMPORT_EDGE_LANGUAGES.has(key),
      calls: resolvers.has(`${key}-calls.ts`),
      types: resolvers.has(`${key}-types.ts`) || resolvers.has(`${key}-heritage.ts`),
      tested: testSources.includes(className),
    });
  }
  rows.sort((a, b) => a.language.localeCompare(b.language));

  return {
    rows,
    counts: {
      total: rows.length,
      treeSitter: rows.filter((r) => r.parser === 'tree-sitter').length,
      regex: rows.filter((r) => r.parser.startsWith('regex')).length,
      custom: rows.filter((r) => r.parser === 'custom').length,
      indexedByDefault: rows.filter((r) => r.indexedByDefault).length,
      imports: rows.filter((r) => r.imports).length,
      calls: rows.filter((r) => r.calls).length,
      types: rows.filter((r) => r.types).length,
      tested: rows.filter((r) => r.tested).length,
    },
  };
}

export function renderMatrix(): string {
  const { rows, counts } = buildMatrix();
  const yes = (v: boolean) => (v ? 'yes' : '—');
  const table = rows
    .map(
      (r) =>
        `| ${r.language} | ${r.extensions.slice(0, 4).join(' ') || '—'} | ${r.parser} | ${yes(r.indexedByDefault)} | ${yes(r.imports)} | ${yes(r.calls)} | ${yes(r.types)} | ${yes(r.tested)} |`,
    )
    .join('\n');

  return `---
layout: default
title: Language capability matrix
description: What each of the ${counts.total} supported languages actually extracts — parser, edges, and test coverage.
---

<!-- GENERATED by scripts/language-matrix.ts — do not edit by hand. -->

## Language capability matrix

trace-mcp ships ${counts.total} language plugins. They are not equally deep, and this
page says how deep each one is. Every language in the list gets symbol
extraction; call graphs and type edges are a much smaller set.

- **indexed with the default config:** ${counts.indexedByDefault} (the rest need an \`include\` entry — see below)
- **tree-sitter parser:** ${counts.treeSitter} · **regex parser:** ${counts.regex} · **custom parser:** ${counts.custom}
- **import edges:** ${counts.imports}
- **call edges (\`get_call_graph\`, call-aware \`find_usages\`):** ${counts.calls}
- **type / inheritance edges:** ${counts.types}
- **covered by a plugin test:** ${counts.tested}

### What the columns mean

| Column | Meaning |
| --- | --- |
| Parser | \`tree-sitter\` — real grammar-based AST. \`regex\` — pattern extraction, no AST. \`custom\` — hand-written parser for a structured format. |
| Default | The shipped default \`include\` globs reach files with this extension. Where this is empty the plugin only runs once you add the extension to \`include\` in \`.trace-mcp.json\`. |
| Imports | Import statements are resolved into graph edges. Plugins outside this set still parse imports, but nothing turns them into edges yet. |
| Calls | A call-graph resolver exists, so "who calls this" is answerable for this language. |
| Types | Type-annotation or inheritance edges are resolved. |
| Tests | At least one test exercises this plugin directly. |

**Default config vs. plugin count.** The default \`include\` is one global glob
over every extension the plugins below claim, so ${counts.indexedByDefault} of
the ${counts.total} plugins run wherever their files live in the repo — no
directory anchoring. The remaining ${counts.total - counts.indexedByDefault}
are pure data formats, left out because lockfiles, fixtures and \`.svg\` would
swamp the index for little symbol value. Ask for them explicitly if you want
them:

\`\`\`json
{ "include": ["schemas/**/*.json", "k8s/**/*.xml"] }
\`\`\`

Note that \`include\` in a project config **replaces** the built-in list rather
than adding to it, so copy the default glob alongside your addition if you
still want the rest of the repo indexed.

A regex plugin still gives you working \`search\`, \`get_outline\` and symbol
navigation — that covers most "find it and read it" work. What it does not give
you is a call graph: that needs an AST plus a per-language resolver. Where the
Calls column is empty, \`get_call_graph\` returns nothing for that language
unless you enable LSP enrichment (\`lsp.enabled: true\`) or ingest a SCIP index.

**Imports means edges, not parsing.** Most plugins extract import statements;
far fewer have a pipeline pass that resolves the specifier to a target node, and
without one the extracted import never becomes an edge. This column counts the
second thing, so it is much shorter than the language list — see
\`src/indexer/edge-resolvers/import-capable-languages.ts\`.

### Matrix

| Language | Extensions | Parser | Default | Imports | Calls | Types | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
${table}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const page = renderMatrix();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== page) {
      process.stderr.write(
        'docs/language-matrix.md is stale. Run: pnpm run docs:language-matrix\n',
      );
      process.exit(1);
    }
    process.stdout.write('docs/language-matrix.md is up to date\n');
  } else {
    fs.writeFileSync(OUT, page);
    process.stdout.write(`Wrote docs/language-matrix.md\n`);
  }
}
