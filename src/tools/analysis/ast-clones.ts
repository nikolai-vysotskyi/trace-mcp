/**
 * AST Type-2 clone detector via subtree hashing.
 *
 * For each function/method symbol, re-parse its source with tree-sitter,
 * normalize the AST subtree (replace identifiers/literals with a placeholder
 * token, strip comments), and hash the resulting structural signature.
 * Symbols sharing a hash are Type-2 clones: structurally identical code with
 * potentially renamed identifiers and different literal values.
 *
 * Complements the name/signature-similarity duplication detector in
 * analysis/duplication.ts, which catches Type-1-ish clones by name.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';
import { ok, type TraceMcpResult } from '../../errors.js';
import { getParser, type TSNode } from '../../parser/tree-sitter.js';

// Languages we hash. A language is only useful here if its tree-sitter
// grammar is available via getParser().
const SUPPORTED_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'python',
  'ruby',
  'go',
  'java',
  'rust',
  'php',
  'c',
  'cpp',
  'csharp',
  'swift',
  'kotlin',
  'scala',
  'elixir',
]);

// Nodes replaced with a '$' placeholder during normalization. This makes the
// signature Type-2: insensitive to renamed identifiers and changed literals.
const NORMALIZED_NODE_TYPES = new Set([
  // identifiers
  'identifier',
  'property_identifier',
  'type_identifier',
  'field_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
  'variable_name',
  'constant',
  'simple_identifier',
  // literals
  'string',
  'string_literal',
  'string_content',
  'template_string',
  'raw_string',
  'raw_string_literal',
  'interpreted_string_literal',
  'number',
  'integer',
  'integer_literal',
  'float',
  'float_literal',
  'decimal_integer_literal',
  'hex_integer_literal',
  'true',
  'false',
  'null',
  'none',
  'nil',
  'undefined',
  'null_literal',
  'character',
  'character_literal',
]);

const COMMENT_NODE_TYPES = new Set([
  'comment',
  'line_comment',
  'block_comment',
  'doc_comment',
  'documentation_comment',
]);

interface CloneCandidate {
  symbol_id: string;
  name: string;
  file: string;
  line_start: number;
  line_end: number;
  loc: number;
  hash: string;
  signature: string;
}

/**
 * Resolve the actual tree-sitter grammar to use for a (language, filePath) pair.
 *
 * The DB stores `language` as 'typescript' / 'javascript' for both plain TS/JS
 * and TSX/JSX files (see src/indexer/file-extractor.ts). But the TS plugin
 * itself uses the dedicated `tsx` grammar at index time for .tsx/.jsx files,
 * because the plain `typescript` grammar mis-parses JSX content — producing
 * collapsed ancestor nodes and accidental hash collisions across unrelated
 * components. Mirror that choice here so ast-clones agrees with the indexer.
 */
function resolveGrammar(language: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsx' || ext === '.jsx') return 'tsx';
  return language;
}

export interface CloneGroup {
  hash: string;
  size: number;
  loc: number;
  symbols: Array<{
    symbol_id: string;
    name: string;
    file: string;
    line_start: number;
    line_end: number;
  }>;
}

export interface AstCloneResult {
  groups: CloneGroup[];
  total_groups: number;
  total_duplicated_symbols: number;
  files_scanned: number;
  symbols_scanned: number;
  _warnings?: string[];
  _methodology: {
    algorithm: string;
    min_loc: number;
    min_nodes: number;
    languages: string[];
    signals: string[];
    limitations: string[];
  };
}

/**
 * Build a structural signature by walking the AST subtree. Skips comments,
 * replaces identifier/literal nodes with `$` so renamed vars don't break
 * matches. Returns both the signature and a total node count to filter out
 * trivial clones (getters, delegates).
 */
function normalize(node: TSNode): { signature: string; nodes: number } {
  if (!node) return { signature: '', nodes: 0 };
  if (COMMENT_NODE_TYPES.has(node.type)) return { signature: '', nodes: 0 };

  const typeSymbol = NORMALIZED_NODE_TYPES.has(node.type) ? '$' : node.type;

  if (node.childCount === 0) {
    return { signature: typeSymbol, nodes: 1 };
  }

  const parts: string[] = [typeSymbol, '('];
  let total = 1;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const sub = normalize(child);
    if (sub.signature) {
      if (parts.length > 2) parts.push(',');
      parts.push(sub.signature);
      total += sub.nodes;
    }
  }
  parts.push(')');
  return { signature: parts.join(''), nodes: total };
}

export async function detectAstClones(
  store: Store,
  projectRoot: string,
  opts: {
    min_loc?: number;
    min_nodes?: number;
    limit?: number;
    file_pattern?: string;
  } = {},
): Promise<TraceMcpResult<AstCloneResult>> {
  const minLoc = opts.min_loc ?? 10;
  const minNodes = opts.min_nodes ?? 30;
  const limit = opts.limit ?? 100;

  const callables = store.db
    .prepare(`
    SELECT s.symbol_id, s.name, s.kind, s.byte_start, s.byte_end,
           s.line_start, s.line_end, f.path as file_path, f.language, f.id as file_id
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.kind IN ('method', 'function', 'constructor')
      AND s.line_start IS NOT NULL
      AND s.line_end IS NOT NULL
      AND (s.line_end - s.line_start) >= ?
      AND f.gitignored = 0
    ORDER BY f.id, s.byte_start
  `)
    .all(minLoc) as Array<{
    symbol_id: string;
    name: string;
    kind: string;
    byte_start: number;
    byte_end: number;
    line_start: number;
    line_end: number;
    file_path: string;
    language: string;
    file_id: number;
  }>;

  const fileContentCache = new Map<number, string>();
  const parsedTreeCache = new Map<number, { tree: unknown; content: string } | null>();
  const candidates: CloneCandidate[] = [];
  const filesSet = new Set<number>();
  const warnings: string[] = [];
  let symbolsScanned = 0;

  for (const c of callables) {
    if (!SUPPORTED_LANGUAGES.has(c.language)) continue;
    if (opts.file_pattern && !c.file_path.includes(opts.file_pattern)) continue;

    let parsed = parsedTreeCache.get(c.file_id);
    if (parsed === undefined) {
      let content = fileContentCache.get(c.file_id);
      if (content === undefined) {
        try {
          const buf = readFileSync(path.resolve(projectRoot, c.file_path));
          if (buf.length > 1024 * 1024) {
            parsedTreeCache.set(c.file_id, null);
            continue;
          }
          content = buf.toString('utf-8');
        } catch {
          parsedTreeCache.set(c.file_id, null);
          continue;
        }
        fileContentCache.set(c.file_id, content);
      }
      try {
        const grammar = resolveGrammar(c.language, c.file_path);
        const parser = await getParser(grammar);
        const tree = parser.parse(content);
        parsed = { tree, content };
        parsedTreeCache.set(c.file_id, parsed);
      } catch {
        parsedTreeCache.set(c.file_id, null);
        continue;
      }
    }
    if (parsed === null) continue;

    filesSet.add(c.file_id);

    try {
      const node = parsed.tree.rootNode.descendantForIndex(c.byte_start, c.byte_end);
      if (!node) continue;

      // Ensure we get a reasonable containing node — if the descendant is a
      // tiny leaf inside the function signature, walk up.
      let target: TSNode = node;
      while (
        target.parent &&
        target.endIndex - target.startIndex < (c.byte_end - c.byte_start) * 0.6
      ) {
        target = target.parent;
      }

      // Walk DOWN through named children whenever a single child still fully
      // covers the symbol body. This narrows past wrapper nodes like
      // `program` or `export_statement` to the actual function/class node.
      // Without this, a symbol sitting at file offset 0 alongside sibling
      // code lands on `program` and gets hashed together with its siblings.
      const bodyLength = c.byte_end - c.byte_start;
      const tolerance = Math.max(50, Math.floor(bodyLength * 0.1));
      let drillGuard = 0;
      while (drillGuard++ < 64) {
        let next: TSNode | null = null;
        for (let i = 0; i < target.namedChildCount; i++) {
          const child = target.namedChild(i);
          if (!child) continue;
          if (child.startIndex <= c.byte_start && child.endIndex >= c.byte_end - 1) {
            next = child;
            break;
          }
        }
        // Stop drilling when no single child covers the body (we're at the
        // narrowest enclosing node) or when the new candidate is smaller than
        // the symbol body itself (we've gone too far — keep the parent).
        if (!next) break;
        const nextLen = next.endIndex - next.startIndex;
        if (nextLen < bodyLength * 0.6) break;
        target = next;
      }

      // Defensive backstop: after locating, if the node start is far from
      // the symbol byte_start the re-parse disagrees with the indexer
      // (typical cause: JSX content + wrong grammar). Skip rather than emit
      // a phantom hash.
      const startOffBy = Math.abs(target.startIndex - c.byte_start);
      const targetLen = target.endIndex - target.startIndex;
      const tooBig = targetLen > bodyLength * 2 + tolerance;
      if (startOffBy > tolerance || tooBig) {
        warnings.push(`could not locate AST node for ${c.symbol_id}`);
        continue;
      }

      const { signature, nodes } = normalize(target);
      if (nodes < minNodes) continue;

      const hash = createHash('sha1').update(signature).digest('hex').slice(0, 16);
      candidates.push({
        symbol_id: c.symbol_id,
        name: c.name,
        file: c.file_path,
        line_start: c.line_start,
        line_end: c.line_end,
        loc: c.line_end - c.line_start,
        hash,
        signature,
      });
      symbolsScanned++;
    } catch {
      // ignore parse/walk failures for individual symbols
    }
  }

  // Release WASM heap held by tree-sitter Trees cached across callables.
  // V8 GC cannot reclaim Tree objects on its own — explicit delete() required.
  for (const cached of parsedTreeCache.values()) {
    if (cached) {
      try {
        (cached.tree as { delete?: () => void }).delete?.();
      } catch {
        /* ignore */
      }
    }
  }
  parsedTreeCache.clear();

  const byHash = new Map<string, CloneCandidate[]>();
  for (const cand of candidates) {
    const arr = byHash.get(cand.hash);
    if (arr) arr.push(cand);
    else byHash.set(cand.hash, [cand]);
  }

  const groups: CloneGroup[] = [];
  for (const [hash, members] of byHash) {
    if (members.length < 2) continue;
    // Skip groups where all members are in the same file at the same byte range (edge case)
    const uniqueLocations = new Set(members.map((m) => `${m.file}:${m.line_start}`));
    if (uniqueLocations.size < 2) continue;

    // LOC sanity filter: a Type-2 clone group should have members of roughly
    // the same size. Drop any member whose LOC differs from the smallest by
    // more than 2x — they slipped in via a hash collision, not real cloning.
    const minMemberLoc = Math.min(...members.map((m) => Math.max(1, m.loc)));
    const sized = members.filter((m) => Math.max(1, m.loc) <= minMemberLoc * 2);
    if (sized.length < 2) continue;

    // Hash collision double-check: large same-file clusters are the typical
    // shape of an indexer-vs-tool grammar mismatch. Verify the first two
    // members really have the same normalized signature; if not, drop the
    // group as a false collision.
    if (sized.length >= 5) {
      const filesInGroup = new Set(sized.map((m) => m.file));
      if (filesInGroup.size === 1) {
        if (sized[0].signature !== sized[1].signature) {
          warnings.push(`dropped hash-collision group ${hash} in ${sized[0].file}`);
          continue;
        }
      }
    }

    groups.push({
      hash,
      size: sized.length,
      loc: Math.max(...sized.map((m) => m.loc)),
      symbols: sized.map((m) => ({
        symbol_id: m.symbol_id,
        name: m.name,
        file: m.file,
        line_start: m.line_start,
        line_end: m.line_end,
      })),
    });
  }

  groups.sort((a, b) => b.size - a.size || b.loc - a.loc);
  const totalDups = groups.reduce((acc, g) => acc + g.size, 0);

  return ok({
    groups: groups.slice(0, limit),
    total_groups: groups.length,
    total_duplicated_symbols: totalDups,
    files_scanned: filesSet.size,
    symbols_scanned: symbolsScanned,
    ...(warnings.length > 0 ? { _warnings: warnings } : {}),
    _methodology: {
      algorithm: 'tree_sitter_ast_subtree_hash_type2',
      min_loc: minLoc,
      min_nodes: minNodes,
      languages: [...SUPPORTED_LANGUAGES].sort(),
      signals: [
        'Tree-sitter AST subtree per function/method body',
        'Identifier and literal nodes replaced with $ placeholder (Type-2 equivalence)',
        'Comments stripped before hashing',
        'SHA-1 truncated to 16 hex chars as group key',
      ],
      limitations: [
        'Only detects exact structural matches — refactored or rearranged code with equivalent semantics is missed',
        'File-scoped parsing: cross-repo clones are detected only within this index',
        'Symbol body is identified via tree-sitter descendantForIndex — nested/nested-lambda fragments may collapse into their outer function',
        'Languages without a tree-sitter-wasms grammar are skipped (see `languages` list)',
      ],
    },
  });
}
