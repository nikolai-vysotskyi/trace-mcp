/**
 * verify_docs — check an existing markdown document against the code graph.
 *
 * `generate_docs` writes docs *from* the graph. This is the other direction:
 * take a document a human wrote and find where it has drifted away from the
 * code it describes.
 *
 * Forward (doc → code): every backticked path and identifier is resolved
 * against the index; the ones that do not resolve come back with the heading
 * path of the section that owns them.
 *
 * Reverse (code → doc): public symbols in a scope that the document never
 * mentions — "is this architecture page still describing the whole module".
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Store } from '../../db/store.js';
import { validatePath } from '../../utils/security.js';

export type RefKind = 'path' | 'symbol';

export interface DocRef {
  /** The code span as written, minus decoration (`()`, `:42`, trailing punctuation). */
  token: string;
  kind: RefKind;
  /** Heading path of the owning section, e.g. `Budgets > Defaults`. */
  heading: string;
  /** 1-based line in the document. */
  line: number;
}

export interface VerifiedRef extends DocRef {
  /** How it resolved: an index row, or the filesystem for a path not indexed. */
  via: 'index' | 'filesystem';
}

export interface VerifyDocsOptions {
  /** Document to check, relative to projectRoot (or absolute). */
  path: string;
  projectRoot: string;
  direction?: 'forward' | 'reverse' | 'both';
  /** File-path prefix for the reverse direction (module or directory). */
  scope?: string;
  /** Return counts plus misses only — the verified list is the large half. */
  compact?: boolean;
}

export interface VerifyDocsResult {
  doc: string;
  forward?: {
    checked: number;
    resolved: number;
    misses: DocRef[];
    verified?: VerifiedRef[];
  };
  reverse?: {
    scope: string;
    public_symbols: number;
    mentioned: number;
    unmentioned: { name: string; kind: string; file: string }[];
  };
}

/** A code span that is prose, not code — measured on our own docs, see ops/docs-audit.md. */
function isProse(token: string): boolean {
  return (
    token.length === 0 ||
    token.length > 200 ||
    /\s/.test(token) ||
    token.startsWith('-') || // CLI flags: --watch, -v
    token.includes('=') ||
    token.includes('*') ||
    token.includes('://') ||
    token.includes('|') ||
    token.startsWith('<') ||
    token.startsWith('{')
  );
}

// `+` and `[]` are segment characters in Next/Nuxt/SvelteKit route trees
// (`src/routes/[id]/page.tsx`, `+page.svelte`), all of which we index.
const PATH_RE = /^[\w.@+[\]-]+(?:\/[\w.@+[\]-]+)+\/?$/;
const CODE_FILE_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|ya?ml|py|go|rs|java|rb|php|cs|kt|swift|sql|sh|toml)$/;
const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * Classify a code span. Returns null for anything that is not plausibly a
 * repo path or a source identifier — package specifiers (`node:fs`,
 * `@scope/pkg`), absolute and home-relative paths (they name state outside
 * the repo), URLs and prose all land here.
 */
function classify(raw: string): { token: string; kind: RefKind } | null {
  let token = raw.trim();
  // `path.ts:42` and `Symbol()` are how we cite code in prose.
  token = token.replace(/:\d+(?:[-:]\d+)?$/, '').replace(/\(\)$/, '');
  // Trailing sentence punctuation swallowed into the span.
  token = token.replace(/[.,;]+$/, '');
  token = token.replace(/^\.\//, '');
  if (isProse(token)) return null;
  if (token.startsWith('~') || token.startsWith('@') || token.startsWith('/')) return null;
  if (token.includes(':')) return null; // node:fs, http:, key: value

  if (token.includes('/')) {
    return PATH_RE.test(token) ? { token: token.replace(/\/$/, ''), kind: 'path' } : null;
  }
  // A bare filename is a path only with a source extension — otherwise
  // `config.tools.preset` reads as `.preset` and never resolves.
  if (CODE_FILE_RE.test(token)) return { token, kind: 'path' };
  if (SYMBOL_RE.test(token)) return { token, kind: 'symbol' };
  return null;
}

/**
 * Code spans of a markdown document with the heading path of their section.
 *
 * Front matter, fenced blocks and `<script>` are stripped: a fenced sample is
 * illustration, and holding it to the index turns every example into a miss.
 */
export function extractDocRefs(markdown: string): DocRef[] {
  const lines = markdown.split('\n');
  const refs: DocRef[] = [];
  const headings: string[] = [];
  let inFence = false;
  let inFrontMatter = lines[0]?.trim() === '---';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFrontMatter) {
      if (i > 0 && line.trim() === '---') inFrontMatter = false;
      continue;
    }
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const depth = h[1].length;
      headings.length = Math.min(headings.length, depth - 1);
      while (headings.length < depth - 1) headings.push('');
      headings[depth - 1] = h[2].replace(/`/g, '').trim();
      continue;
    }

    const heading = headings.filter(Boolean).join(' > ');
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const c = classify(m[1]);
      if (c) refs.push({ ...c, heading, line: i + 1 });
    }
  }
  return refs;
}

function resolveRef(store: Store, projectRoot: string, ref: DocRef): VerifiedRef | null {
  if (ref.kind === 'path') {
    if (store.getFile(ref.token)) return { ...ref, via: 'index' };
    // Directories and non-source files are never indexed but are still real
    // references — a doc pointing at `docs/` is not drift.
    const abs = validatePath(ref.token, projectRoot);
    if (abs.isOk() && existsSync(abs.value)) return { ...ref, via: 'filesystem' };
    return null;
  }
  if (store.getSymbolByFqn(ref.token) || store.getSymbolBySymbolId(ref.token)) {
    return { ...ref, via: 'index' };
  }
  // `Store.getFile` in prose is the method, indexed under its own name.
  const last = ref.token.split('.').pop() as string;
  if (store.getSymbolByName(last)) return { ...ref, via: 'index' };
  return null;
}

export function verifyDocs(store: Store, options: VerifyDocsOptions): VerifyDocsResult {
  const { projectRoot, scope, compact = false } = options;
  const direction = options.direction ?? 'forward';
  // The document path comes from a tool argument; keep it inside the project.
  const docAbs = validatePath(options.path, projectRoot);
  if (docAbs.isErr()) throw new Error(`path escapes the project root: ${options.path}`);
  const markdown = readFileSync(docAbs.value, 'utf-8');
  const result: VerifyDocsResult = { doc: options.path };

  if (direction === 'forward' || direction === 'both') {
    const refs = extractDocRefs(markdown);
    const misses: DocRef[] = [];
    const verified: VerifiedRef[] = [];
    for (const ref of refs) {
      const ok = resolveRef(store, projectRoot, ref);
      if (ok) verified.push(ok);
      else misses.push(ref);
    }
    result.forward = {
      checked: refs.length,
      resolved: verified.length,
      misses,
      ...(compact ? {} : { verified }),
    };
  }

  if (direction === 'reverse' || direction === 'both') {
    const pattern = scope ?? '';
    const exported = store
      .getExportedSymbols(pattern ? `${pattern}%` : undefined)
      .filter((s) => !pattern || s.file_path.startsWith(pattern));
    // Plain-text mention counts: a page may name a symbol without a code span.
    // Tokenised once rather than one regex per symbol — a name is untrusted
    // input, and a set lookup is both safe and cheaper on a large scope.
    const words = new Set(markdown.match(/[A-Za-z_$][\w$]*/g) ?? []);
    const seen = new Set<string>();
    const unmentioned: { name: string; kind: string; file: string }[] = [];
    for (const sym of exported) {
      if (seen.has(sym.name)) continue;
      seen.add(sym.name);
      if (words.has(sym.name)) continue;
      unmentioned.push({ name: sym.name, kind: sym.kind, file: sym.file_path });
    }
    result.reverse = {
      scope: pattern || '(project)',
      public_symbols: seen.size,
      mentioned: seen.size - unmentioned.length,
      unmentioned,
    };
  }

  return result;
}
