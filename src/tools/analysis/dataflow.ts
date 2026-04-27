/**
 * Dataflow Analysis — Phase 1 (intra-function).
 *
 * Tracks how function parameters flow into calls, what gets mutated,
 * and what gets returned. Uses lightweight regex-based heuristic analysis
 * on the function source — no full AST parser dependency.
 *
 * Performance: reads a single file per call (the symbol's file), plus
 * batch edge queries for callee resolution. No N+1.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Store, SymbolRow } from '../../db/store.js';
import { err, notFound, ok, type TraceMcpResult, validationError } from '../../errors.js';

// ── Types ──────────────────────────────────────────────────────────────

interface DataflowParam {
  name: string;
  type: string | null;
  flows_to: DataflowSink[];
  mutations: DataflowMutation[];
}

interface DataflowSink {
  kind: 'call_arg' | 'return' | 'assign' | 'property_access';
  target: string; // function name or variable
  line: number;
  symbolId?: string; // resolved symbol_id if known
  file?: string;
}

interface DataflowMutation {
  expression: string; // e.g. "order.status = 'processing'"
  line: number;
  property: string; // e.g. "status"
}

interface DataflowReturn {
  expression: string;
  line: number;
  sources: string[]; // param names or calls that contribute
}

interface DataflowResult {
  symbol: { symbolId: string; name: string; kind: string; file: string };
  parameters: DataflowParam[];
  returns: DataflowReturn[];
  localAssignments: { name: string; source: string; line: number }[];
}

interface DataflowOptions {
  symbolId?: string;
  fqn?: string;
  direction?: 'forward' | 'backward' | 'both';
  depth?: number;
}

// ── Main Entry ─────────────────────────────────────────────────────────

export function getDataflow(
  store: Store,
  projectRoot: string,
  opts: DataflowOptions,
): TraceMcpResult<DataflowResult> {
  // Resolve symbol
  const symbol = opts.symbolId
    ? store.getSymbolBySymbolId(opts.symbolId)
    : opts.fqn
      ? store.getSymbolByFqn(opts.fqn)
      : undefined;

  if (!symbol) {
    return err(notFound(opts.symbolId ?? opts.fqn ?? 'unknown'));
  }

  if (!['function', 'method', 'arrow_function'].includes(symbol.kind)) {
    return err(
      validationError(
        `Dataflow analysis is only supported for functions/methods, got: ${symbol.kind}`,
      ),
    );
  }

  // Read the function source
  const file = store.getFileById(symbol.file_id);
  if (!file) return err(notFound(`file for ${symbol.symbol_id}`));

  const absPath = path.resolve(projectRoot, file.path);
  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return err(validationError(`Cannot read file: ${file.path}`));
  }

  // Extract function body lines
  const lines = content.split('\n');
  const startLine = symbol.line_start ?? 1;
  const endLine = symbol.line_end ?? lines.length;
  const funcLines = lines.slice(startLine - 1, endLine);

  // Parse parameters from signature
  const params = parseParameters(symbol.signature ?? funcLines[0]);

  // Build callee name → symbolId map using graph edges (batch, no N+1)
  const calleeMap = buildCalleeMap(store, symbol);

  // Analyze dataflow for each parameter
  const paramResults: DataflowParam[] = [];
  for (const param of params) {
    const flows_to: DataflowSink[] = [];
    const mutations: DataflowMutation[] = [];

    for (let i = 0; i < funcLines.length; i++) {
      const line = funcLines[i];
      const absLine = startLine + i;

      // Detect mutations: param.prop = value  or  param[key] = value
      const mutationPattern = new RegExp(`\\b${escapeRegex(param.name)}\\.(\\w+)\\s*=(?!=)`, 'g');
      let mutMatch;
      while ((mutMatch = mutationPattern.exec(line)) !== null) {
        mutations.push({
          expression: line.trim(),
          line: absLine,
          property: mutMatch[1],
        });
      }

      // Detect call arguments: someFunc(param) or someFunc(param.prop)
      const callPattern = new RegExp(`(\\w+)\\s*\\([^)]*\\b${escapeRegex(param.name)}\\b`, 'g');
      let callMatch;
      while ((callMatch = callPattern.exec(line)) !== null) {
        const calledFn = callMatch[1];
        // Skip common keywords
        if (
          [
            'if',
            'while',
            'for',
            'switch',
            'return',
            'throw',
            'new',
            'typeof',
            'instanceof',
            'await',
          ].includes(calledFn)
        )
          continue;
        const resolved = calleeMap.get(calledFn);
        flows_to.push({
          kind: 'call_arg',
          target: calledFn,
          line: absLine,
          symbolId: resolved?.symbolId,
          file: resolved?.file,
        });
      }

      // Detect property access pass-through: someFunc(param.prop)
      const propPassPattern = new RegExp(
        `(\\w+)\\s*\\([^)]*\\b${escapeRegex(param.name)}\\.(\\w+)`,
        'g',
      );
      let propMatch;
      while ((propMatch = propPassPattern.exec(line)) !== null) {
        const calledFn = propMatch[1];
        if (
          [
            'if',
            'while',
            'for',
            'switch',
            'return',
            'throw',
            'new',
            'typeof',
            'instanceof',
            'await',
          ].includes(calledFn)
        )
          continue;
        // Avoid duplicating if already captured by call pattern
        if (!flows_to.some((f) => f.target === calledFn && f.line === absLine)) {
          const resolved = calleeMap.get(calledFn);
          flows_to.push({
            kind: 'property_access',
            target: `${calledFn}(${param.name}.${propMatch[2]})`,
            line: absLine,
            symbolId: resolved?.symbolId,
            file: resolved?.file,
          });
        }
      }
    }

    paramResults.push({ name: param.name, type: param.type, flows_to, mutations });
  }

  // Analyze returns
  const returns: DataflowReturn[] = [];
  for (let i = 0; i < funcLines.length; i++) {
    const line = funcLines[i];
    const absLine = startLine + i;
    const retMatch = line.match(/\breturn\s+(.+?)(?:;|\s*$)/);
    if (retMatch) {
      const expr = retMatch[1].trim();
      const sources = params
        .map((p) => p.name)
        .filter((name) => new RegExp(`\\b${escapeRegex(name)}\\b`).test(expr));
      returns.push({ expression: expr, line: absLine, sources });
    }
  }

  // Analyze local assignments (e.g. const result = someCall(param))
  const localAssignments: DataflowResult['localAssignments'] = [];
  for (let i = 0; i < funcLines.length; i++) {
    const line = funcLines[i];
    const absLine = startLine + i;
    const assignMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(.+?)(?:;|\s*$)/);
    if (assignMatch) {
      const [, varName, source] = assignMatch;
      // Only track assignments involving params or function calls
      const involvesParam = params.some((p) =>
        new RegExp(`\\b${escapeRegex(p.name)}\\b`).test(source),
      );
      if (involvesParam || /\w+\s*\(/.test(source)) {
        localAssignments.push({
          name: varName,
          source: source.trim(),
          line: absLine,
        });
      }
    }
  }

  return ok({
    symbol: {
      symbolId: symbol.symbol_id,
      name: symbol.name,
      kind: symbol.kind,
      file: file.path,
    },
    parameters: paramResults,
    returns,
    localAssignments,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

interface ParsedParam {
  name: string;
  type: string | null;
}

function parseParameters(signature: string): ParsedParam[] {
  // Extract content between first ( and last )
  const match = signature.match(/\(([^)]*)\)/);
  if (!match) return [];

  const paramStr = match[1].trim();
  if (!paramStr) return [];

  return paramStr
    .split(',')
    .map((p) => {
      const trimmed = p.trim();
      // Handle TypeScript style: name: type, or name?: type
      const tsMatch = trimmed.match(/^(\w+)\??\s*:\s*(.+)$/);
      if (tsMatch) return { name: tsMatch[1], type: tsMatch[2].trim() };
      // Handle Python style: name: type, or just name
      const pyMatch = trimmed.match(/^(\w+)(?:\s*:\s*(.+))?$/);
      if (pyMatch) return { name: pyMatch[1], type: pyMatch[2]?.trim() ?? null };
      // Fallback: first word is the name
      const word = trimmed.split(/\s/)[0];
      return { name: word, type: null };
    })
    .filter((p) => p.name && p.name !== '...');
}

interface CalleeInfo {
  symbolId: string;
  file: string;
}

/**
 * Build a map of callee names to their symbol IDs.
 * Uses a single batch query for outgoing edges.
 */
function buildCalleeMap(store: Store, symbol: SymbolRow): Map<string, CalleeInfo> {
  const map = new Map<string, CalleeInfo>();
  const nodeId = store.getNodeId('symbol', symbol.id);
  if (!nodeId) return map;

  // Get all outgoing edges (calls, references)
  const edges = store.getOutgoingEdges(nodeId);
  if (edges.length === 0) return map;

  // Batch resolve target node refs
  const targetNodeIds = edges.map((e) => e.target_node_id);
  const nodeRefs = store.getNodeRefsBatch(targetNodeIds);

  // Collect symbol IDs
  const symIds: number[] = [];
  for (const [, ref] of nodeRefs) {
    if (ref.nodeType === 'symbol') symIds.push(ref.refId);
  }

  // Batch fetch symbols
  const symbols = store.getSymbolsByIds(symIds);
  const fileIds = new Set<number>();
  for (const [, sym] of symbols) fileIds.add(sym.file_id);
  const files = store.getFilesByIds([...fileIds]);

  for (const [, sym] of symbols) {
    const file = files.get(sym.file_id);
    map.set(sym.name, {
      symbolId: sym.symbol_id,
      file: file?.path ?? '',
    });
  }

  return map;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
