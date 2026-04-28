import path from 'node:path';
import { err, ok } from 'neverthrow';
import type { Store } from '../../db/store.js';
import { notFound, type TraceMcpResult } from '../../errors.js';
import { resolveSymbolInput } from '../shared/resolve.js';

interface TestReference {
  test_file: string;
  /** Symbol ID of the test function/method, if resolved */
  symbol_id?: string;
  test_name?: string;
  edge_type: string;
}

interface GetTestsForResult {
  target: { symbol_id?: string; file?: string };
  tests: TestReference[];
  total: number;
}

/**
 * Find test files/symbols that cover a given symbol or file.
 *
 * Strategy (in order):
 * 1. Walk incoming `test_covers` edges from the graph. These are created by the
 *    edge resolver (Pass 2h) for test files that import the target file or symbol.
 *    When the target is a symbol, both the symbol node and its parent file node
 *    are checked for incoming test_covers edges.
 * 2. Heuristic path-based matching: look for test files whose path contains
 *    the target file's base name (e.g. UserService → user.service.spec.ts).
 *
 * Results are deduplicated — a test file found via graph edges won't appear
 * again from heuristic matching.
 */
export function getTestsFor(
  store: Store,
  opts: { symbolId?: string; fqn?: string; filePath?: string },
): TraceMcpResult<GetTestsForResult> {
  let targetFile: string | undefined;
  let targetSymbolId: string | undefined;
  let symbolNodeId: number | undefined;
  let fileNodeId: number | undefined;

  if (opts.symbolId || opts.fqn) {
    const resolved = resolveSymbolInput(store, opts);
    if (!resolved) return err(notFound(opts.symbolId ?? opts.fqn ?? 'unknown'));
    const symbol = resolved.symbol;
    targetSymbolId = symbol.symbol_id;
    targetFile = resolved.file.path;
    symbolNodeId = store.getNodeId('symbol', symbol.id);
    fileNodeId = store.getNodeId('file', resolved.file.id);
  } else if (opts.filePath) {
    const f = store.getFile(opts.filePath);
    if (!f) return err(notFound(opts.filePath));
    targetFile = f.path;
    fileNodeId = store.getNodeId('file', f.id);
  } else {
    return err(notFound('provide symbol_id, fqn, or file_path'));
  }

  const tests: TestReference[] = [];
  const seen = new Set<string>();

  // Strategy 1: explicit test_covers edges
  // Check both symbol node and file node — test_covers edges may target either level.
  const nodeIdsToCheck = new Set<number>();
  if (symbolNodeId !== undefined) nodeIdsToCheck.add(symbolNodeId);
  if (fileNodeId !== undefined) nodeIdsToCheck.add(fileNodeId);

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
          edge_type: 'test_covers',
        });
      }
    }
  }

  // Strategy 2: heuristic path-based matching
  if (targetFile) {
    const baseName = path.basename(targetFile, path.extname(targetFile));
    // Normalize: UserService → user-service, userService → user-service
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

  return ok({
    target: { symbol_id: targetSymbolId, file: targetFile },
    tests,
    total: tests.length,
  });
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
