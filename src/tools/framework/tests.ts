import fs from 'node:fs';
import path from 'node:path';
import { err, ok } from 'neverthrow';
import type { Store } from '../../db/store.js';
import type { SymbolRow } from '../../db/types.js';
import { notFound, type TraceMcpResult } from '../../errors.js';
import { resolveSymbolInput } from '../shared/resolve.js';

export type TestsForConfidence = 'text_match' | 'import_and_call' | 'direct_invocation';

interface TestReference {
  test_file: string;
  /** Symbol ID of the enclosing test function (e.g. it/test/describe block), if resolved. */
  symbol_id?: string;
  test_name?: string;
  /** Line number of the matched test (1-based) when resolvable. */
  line?: number;
  /** How the test was matched: explicit edge, heuristic path, or content scan. */
  edge_type: string;
  /**
   * Strength of the symbol-level association. Absent in pure file-level mode
   * (no symbol_id provided) or when matched via graph `test_covers` edge.
   */
  confidence?: TestsForConfidence;
}

interface GetTestsForResult {
  target: { symbol_id?: string; file?: string };
  tests: TestReference[];
  total: number;
  /** Set when symbol_id was provided and per-symbol narrowing was applied. */
  symbol_filtered?: boolean;
  /** True when no per-symbol hits existed and the file-level fallback fired. */
  fell_back_to_file_level?: boolean;
}

const CONFIDENCE_RANK: Record<TestsForConfidence, number> = {
  text_match: 0,
  import_and_call: 1,
  direct_invocation: 2,
};

/**
 * Find test files/symbols that cover a given symbol or file.
 *
 * Two modes:
 *
 * 1. **file-level** (when only `filePath` is provided, or `symbol_id` resolves
 *    to nothing more specific): walks incoming `test_covers` edges + heuristic
 *    path matching. Same behaviour as before.
 *
 * 2. **symbol-level** (when `symbolId`/`fqn` is provided): same candidate
 *    discovery, then narrowed to test files that actually exercise the symbol.
 *    Each candidate is classified:
 *      - `direct_invocation`: the graph has a `calls`/`references` edge from a
 *        symbol inside the test file to the target symbol. Strongest signal.
 *      - `import_and_call`: the test file imports the source file (or the
 *        symbol is referenced via any non-text edge) AND the symbol name
 *        appears (word-boundary) in the file body.
 *      - `text_match`: only the symbol name appears in the file (could be a
 *        string literal or a doc comment).
 *
 *    Default threshold is `import_and_call`. If symbol-level narrowing yields
 *    zero hits the tool falls back to the file-level result so callers don't
 *    lose signal entirely — this is flagged via `fell_back_to_file_level`.
 */
export function getTestsFor(
  store: Store,
  opts: {
    symbolId?: string;
    fqn?: string;
    filePath?: string;
    projectRoot?: string;
    minConfidence?: TestsForConfidence;
  },
): TraceMcpResult<GetTestsForResult> {
  let targetFile: string | undefined;
  let targetSymbolId: string | undefined;
  let targetSymbol: SymbolRow | undefined;
  let symbolNodeId: number | undefined;
  let fileNodeId: number | undefined;

  if (opts.symbolId || opts.fqn) {
    const resolved = resolveSymbolInput(store, opts);
    if (!resolved) return err(notFound(opts.symbolId ?? opts.fqn ?? 'unknown'));
    targetSymbol = resolved.symbol;
    targetSymbolId = targetSymbol.symbol_id;
    targetFile = resolved.file.path;
    symbolNodeId = store.getNodeId('symbol', targetSymbol.id);
    fileNodeId = store.getNodeId('file', resolved.file.id);
  } else if (opts.filePath) {
    const f = store.getFile(opts.filePath);
    if (!f) return err(notFound(opts.filePath));
    targetFile = f.path;
    fileNodeId = store.getNodeId('file', f.id);
  } else {
    return err(notFound('provide symbol_id, fqn, or file_path'));
  }

  const fileLevelTests = collectFileLevelCandidates(store, {
    targetFile,
    symbolNodeId,
    fileNodeId,
  });

  // No symbol_id → pure file-level result, identical to legacy behaviour.
  if (!targetSymbol) {
    return ok({
      target: { symbol_id: targetSymbolId, file: targetFile },
      tests: fileLevelTests,
      total: fileLevelTests.length,
    });
  }

  // Symbol-level narrowing.
  const minConfidence: TestsForConfidence = opts.minConfidence ?? 'import_and_call';
  const minRank = CONFIDENCE_RANK[minConfidence];

  const symbolHits = narrowToSymbol(store, {
    candidates: fileLevelTests,
    targetSymbol,
    symbolNodeId,
    fileNodeId,
    projectRoot: opts.projectRoot,
  });

  const filtered = symbolHits.filter(
    (t) => t.confidence !== undefined && CONFIDENCE_RANK[t.confidence] >= minRank,
  );

  if (filtered.length === 0) {
    // Fall back to file-level so callers still get *some* signal.
    return ok({
      target: { symbol_id: targetSymbolId, file: targetFile },
      tests: fileLevelTests,
      total: fileLevelTests.length,
      symbol_filtered: true,
      fell_back_to_file_level: true,
    });
  }

  return ok({
    target: { symbol_id: targetSymbolId, file: targetFile },
    tests: filtered,
    total: filtered.length,
    symbol_filtered: true,
  });
}

/** Collect candidate test files via test_covers edges + heuristic path match. */
function collectFileLevelCandidates(
  store: Store,
  opts: {
    targetFile?: string;
    symbolNodeId?: number;
    fileNodeId?: number;
  },
): TestReference[] {
  const tests: TestReference[] = [];
  const seen = new Set<string>();

  // Strategy 1: explicit test_covers edges
  const nodeIdsToCheck = new Set<number>();
  if (opts.symbolNodeId !== undefined) nodeIdsToCheck.add(opts.symbolNodeId);
  if (opts.fileNodeId !== undefined) nodeIdsToCheck.add(opts.fileNodeId);

  for (const nid of nodeIdsToCheck) {
    const incoming = store.getIncomingEdges(nid);
    for (const edge of incoming) {
      if (edge.edge_type_name !== 'test_covers') continue;
      const ref = store.getNodeRef(edge.source_node_id);
      if (!ref) continue;

      if (ref.nodeType === 'file') {
        const f = store.getFileById(ref.refId);
        if (!f || seen.has(f.path)) continue;
        seen.add(f.path);
        tests.push({ test_file: f.path, edge_type: 'test_covers' });
      } else if (ref.nodeType === 'symbol') {
        const s = store.getSymbolById(ref.refId);
        const f = s ? store.getFileById(s.file_id) : undefined;
        if (!s || !f || seen.has(f.path)) continue;
        seen.add(f.path);
        tests.push({
          test_file: f.path,
          symbol_id: s.symbol_id,
          test_name: s.name,
          line: s.line_start ?? undefined,
          edge_type: 'test_covers',
        });
      }
    }
  }

  // Strategy 2: heuristic path-based matching
  if (opts.targetFile) {
    const baseName = path.basename(opts.targetFile, path.extname(opts.targetFile));
    const normalized = baseName
      .replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`)
      .replace(/^-/, '')
      .toLowerCase();
    const variants = [baseName.toLowerCase(), normalized];

    const allFiles = store.getAllFiles();
    for (const f of allFiles) {
      if (seen.has(f.path)) continue;
      if (!isTestFile(f.path)) continue;

      const testBase = path.basename(f.path).toLowerCase();
      if (variants.some((v) => testBase.includes(v))) {
        seen.add(f.path);
        tests.push({ test_file: f.path, edge_type: 'heuristic_path' });
      }
    }
  }

  return tests;
}

/**
 * Score each candidate test file against the target symbol. Returns one entry
 * per candidate that has at least a `text_match`; entries without any signal
 * are dropped.
 *
 * Uses three signals, strongest wins:
 *
 *  - graph: any non-test, non-text edge (`calls`, `references`, `renders`, …)
 *    from a symbol inside the test file to the target symbol → direct_invocation.
 *  - graph + text: the test file imports the source file (file-level `imports`
 *    edge) AND the symbol name appears in the test body → import_and_call.
 *  - text only: the symbol name appears with a word boundary → text_match.
 *
 * Tests already attributed via `test_covers` edges keep their high signal.
 */
function narrowToSymbol(
  store: Store,
  opts: {
    candidates: TestReference[];
    targetSymbol: SymbolRow;
    symbolNodeId?: number;
    fileNodeId?: number;
    projectRoot?: string;
  },
): TestReference[] {
  const { candidates, targetSymbol, symbolNodeId, fileNodeId, projectRoot } = opts;
  if (candidates.length === 0) return [];

  // Build the set of test-file IDs that have a direct edge into the target
  // symbol (any non-test_covers, non-text_matched edge counts as a real call).
  const directFileIds = new Set<number>();
  if (symbolNodeId !== undefined) {
    const incoming = store.getIncomingEdges(symbolNodeId);
    for (const edge of incoming) {
      if (edge.edge_type_name === 'test_covers') continue;
      if (edge.resolution_tier === 'text_matched') continue;
      const ref = store.getNodeRef(edge.source_node_id);
      if (!ref) continue;
      if (ref.nodeType === 'symbol') {
        const s = store.getSymbolById(ref.refId);
        if (s) directFileIds.add(s.file_id);
      } else if (ref.nodeType === 'file') {
        directFileIds.add(ref.refId);
      }
    }
  }

  // Test files that import the source file (file-level edge).
  const importerFileIds = new Set<number>();
  if (fileNodeId !== undefined) {
    const incoming = store.getIncomingEdges(fileNodeId);
    for (const edge of incoming) {
      const ref = store.getNodeRef(edge.source_node_id);
      if (!ref || ref.nodeType !== 'file') continue;
      importerFileIds.add(ref.refId);
    }
  }

  const namePattern = buildWordBoundaryRegex(targetSymbol.name);
  const out: TestReference[] = [];

  for (const cand of candidates) {
    // Tests promoted via graph `test_covers` edges are already authoritative —
    // keep them as direct_invocation.
    if (cand.edge_type === 'test_covers') {
      out.push({ ...cand, confidence: 'direct_invocation' });
      continue;
    }

    const file = store.getFile(cand.test_file);
    if (!file) continue;

    let confidence: TestsForConfidence | undefined;
    let line: number | undefined;
    let enclosing: { symbolId: string; name: string; line: number } | undefined;

    if (directFileIds.has(file.id)) {
      confidence = 'direct_invocation';
    }

    // Look for textual mention on disk. This is the symbol-level filter that
    // distinguishes "test file imports the source" from "test file actually
    // exercises this symbol".
    const lineHit = projectRoot
      ? findFirstMatchingLine(projectRoot, cand.test_file, namePattern)
      : undefined;
    if (lineHit !== undefined) {
      line = lineHit;
      enclosing = findEnclosingTestBlock(store, file.id, lineHit);
      if (confidence === undefined) {
        confidence = importerFileIds.has(file.id) ? 'import_and_call' : 'text_match';
      }
    } else if (confidence === 'direct_invocation') {
      // Direct graph edge but no text hit (e.g. minified or transpiled) —
      // still high-confidence.
    } else if (importerFileIds.has(file.id)) {
      // Importer but no name in body and no graph edge — most likely a
      // tangential import; do not include in default output.
      continue;
    } else {
      // No signal at all.
      continue;
    }

    out.push({
      test_file: cand.test_file,
      symbol_id: enclosing?.symbolId ?? cand.symbol_id,
      test_name: enclosing?.name ?? cand.test_name,
      line: enclosing?.line ?? line ?? cand.line,
      edge_type: cand.edge_type,
      confidence,
    });
  }

  return out;
}

function buildWordBoundaryRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`);
}

/**
 * Stream the file on disk looking for the first line that matches `pattern`.
 * Returns the 1-based line number, or undefined if no match / file missing.
 */
function findFirstMatchingLine(
  projectRoot: string,
  relPath: string,
  pattern: RegExp,
): number | undefined {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return undefined;
}

/**
 * Map a 1-based line number inside a test file to the enclosing
 * describe/it/test block by walking indexed symbols in that file.
 * Returns the innermost (smallest) symbol that contains the line.
 */
function findEnclosingTestBlock(
  store: Store,
  fileId: number,
  line: number,
): { symbolId: string; name: string; line: number } | undefined {
  const symbols = store.getSymbolsByFile(fileId);
  let best: SymbolRow | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;

  for (const s of symbols) {
    const start = s.line_start;
    const end = s.line_end;
    if (start == null || end == null) continue;
    if (line < start || line > end) continue;
    const span = end - start;
    if (span < bestSpan) {
      bestSpan = span;
      best = s;
    }
  }

  if (!best) return undefined;
  return { symbolId: best.symbol_id, name: best.name, line: best.line_start ?? line };
}

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.py$/,
  /test_\w+\.py$/,
  /Test\.php$/,
  /tests?\//,
  /__tests__\//,
];

function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(filePath));
}
