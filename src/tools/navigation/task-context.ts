/**
 * get_task_context — Graph-Aware Context Engine.
 *
 * Given a natural language task description + token budget, returns the optimal
 * subgraph of code context. Adapts strategy based on intent (bugfix, new feature,
 * refactor, understand) and traces execution paths through the dependency graph.
 *
 * Pipeline: Intent Classify → Dual Seeding (FTS+Vector) → Multi-Hop Graph Walk
 *           → Test Coverage → Scoring → Structured Assembly
 */
import path from 'node:path';
import type { Store, SymbolRow, FileRow, EdgeRow } from '../../db/store.js';
import { hybridScore, getTypeBonus, computeRecency } from '../../scoring/hybrid.js';
import { computePageRank } from '../../scoring/pagerank.js';
import { assembleStructuredContext } from '../../scoring/structured-assembly.js';
import type { ContextItem } from '../../scoring/assembly.js';
import { readByteRange } from '../../utils/source-reader.js';
import { tokenizeDescription } from './context.js';
import { hybridSearch } from '../../ai/search.js';
import type { VectorStore, EmbeddingService } from '../../ai/interfaces.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

type TaskIntent = 'bugfix' | 'new_feature' | 'refactor' | 'understand';
type FocusMode = 'minimal' | 'broad' | 'deep';

interface TaskContextOptions {
  task: string;
  tokenBudget?: number;
  focus?: FocusMode;
  includeTests?: boolean;
}

interface TaskContextResult {
  task: string;
  intent: TaskIntent;
  sections: {
    primary: TaskContextItem[];
    dependencies: TaskContextItem[];
    callers: TaskContextItem[];
    tests: TaskContextItem[];
    types: TaskContextItem[];
  };
  totalTokens: number;
  truncated: boolean;
  seedCount: number;
  graphNodesExplored: number;
}

interface TaskContextItem {
  symbolId: string;
  name: string;
  kind: string;
  fqn: string | null;
  filePath: string;
  score: number;
  detail: 'full' | 'no_source' | 'signature_only';
  content: string;
  tokens: number;
}

// ═══════════════════════════════════════════════════════════════════
// INTENT CLASSIFICATION (heuristic, no LLM)
// ═══════════════════════════════════════════════════════════════════

const INTENT_PATTERNS: [RegExp, TaskIntent][] = [
  [/\b(fix|bug|error|crash(?:es|ed|ing)?|broken|issue|fail(?:ing|s|ed)?|wrong|regression|debug|patch|hotfix)\b/i, 'bugfix'],
  [/\b(add|create|new|implement|build|introduce|feature|setup|integrate|wire|connect)\b/i, 'new_feature'],
  [/\b(refactor|extract|move|rename|split|merge|clean|simplify|reorganize|decouple|inline|consolidate)\b/i, 'refactor'],
];

export function classifyIntent(task: string): TaskIntent {
  for (const [pattern, intent] of INTENT_PATTERNS) {
    if (pattern.test(task)) return intent;
  }
  return 'understand';
}

// ═══════════════════════════════════════════════════════════════════
// INTENT CONFIGS
// ═══════════════════════════════════════════════════════════════════

interface IntentConfig {
  graphDepth: number;
  seedCount: Record<FocusMode, number>;
  budgetWeights: { primary: number; dependencies: number; callers: number; typeContext: number };
  /** Edge types to prioritize (if empty, all are followed) */
  priorityEdges: Set<string>;
}

const IMPORT_EDGES = ['esm_imports', 'imports', 'py_imports', 'py_reexports', 'go_imports', 'java_imports', 'ruby_requires'];
const CALL_EDGES = ['calls', 'references', 'dispatches', 'renders', 'uses'];
const TEST_EDGES = ['test_covers'];
const TYPE_EDGES = ['extends', 'implements', 'type_references'];

const INTENT_CONFIGS: Record<TaskIntent, IntentConfig> = {
  bugfix: {
    graphDepth: 3,
    seedCount: { minimal: 5, broad: 10, deep: 15 },
    budgetWeights: { primary: 0.25, dependencies: 0.20, callers: 0.25, typeContext: 0.10 },
    // remaining 0.20 for tests (handled separately)
    priorityEdges: new Set([...CALL_EDGES, ...IMPORT_EDGES, ...TEST_EDGES, ...TYPE_EDGES]),
  },
  new_feature: {
    graphDepth: 2,
    seedCount: { minimal: 5, broad: 15, deep: 20 },
    budgetWeights: { primary: 0.35, dependencies: 0.30, callers: 0.10, typeContext: 0.10 },
    priorityEdges: new Set([...IMPORT_EDGES, ...TYPE_EDGES, ...CALL_EDGES, 'routes_to', 'middleware_applied']),
  },
  refactor: {
    graphDepth: 2,
    seedCount: { minimal: 5, broad: 10, deep: 15 },
    budgetWeights: { primary: 0.30, dependencies: 0.25, callers: 0.25, typeContext: 0.10 },
    priorityEdges: new Set([...IMPORT_EDGES, ...CALL_EDGES, ...TYPE_EDGES]),
  },
  understand: {
    graphDepth: 1,
    seedCount: { minimal: 5, broad: 15, deep: 20 },
    budgetWeights: { primary: 0.40, dependencies: 0.25, callers: 0.15, typeContext: 0.10 },
    priorityEdges: new Set([...IMPORT_EDGES, ...CALL_EDGES, ...TYPE_EDGES]),
  },
};

// Test budget is the remainder after other weights (always sums to ~0.20 for bugfix, ~0.15 for others)
function getTestBudgetRatio(cfg: IntentConfig): number {
  return Math.max(0, 1 - cfg.budgetWeights.primary - cfg.budgetWeights.dependencies - cfg.budgetWeights.callers - cfg.budgetWeights.typeContext);
}

// ═══════════════════════════════════════════════════════════════════
// MULTI-HOP GRAPH WALKER
// ═══════════════════════════════════════════════════════════════════

interface WalkedNode {
  depth: number;
  edgeType: string;
  direction: 'outgoing' | 'incoming';
}

function walkGraph(
  store: Store,
  seedNodeIds: number[],
  maxDepth: number,
  priorityEdges: Set<string>,
): Map<number, WalkedNode> {
  const visited = new Map<number, WalkedNode>();

  // Seeds are depth 0
  for (const id of seedNodeIds) {
    visited.set(id, { depth: 0, edgeType: 'seed', direction: 'outgoing' });
  }

  let frontier = new Set(seedNodeIds);

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (frontier.size === 0) break;

    const frontierArr = [...frontier];
    const edges = store.getEdgesForNodesBatch(frontierArr);
    const nextFrontier = new Set<number>();

    for (const edge of edges) {
      // Filter by priority edges if specified
      if (priorityEdges.size > 0 && !priorityEdges.has(edge.edge_type_name)) continue;

      const pivotId = edge.pivot_node_id;
      const otherId = pivotId === edge.source_node_id ? edge.target_node_id : edge.source_node_id;
      const direction: 'outgoing' | 'incoming' = pivotId === edge.source_node_id ? 'outgoing' : 'incoming';

      if (visited.has(otherId)) continue;

      visited.set(otherId, { depth, edgeType: edge.edge_type_name, direction });
      nextFrontier.add(otherId);
    }

    frontier = nextFrontier;
  }

  return visited;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════════

export async function getTaskContext(
  store: Store,
  rootPath: string,
  opts: TaskContextOptions,
  ai?: { vectorStore: VectorStore | null; embeddingService: EmbeddingService | null } | null,
): Promise<TaskContextResult> {
  const task = opts.task;
  const tokenBudget = opts.tokenBudget ?? 8000;
  const focus: FocusMode = opts.focus ?? 'broad';
  const includeTests = opts.includeTests ?? true;

  const intent = classifyIntent(task);
  const cfg = INTENT_CONFIGS[intent];
  const seedLimit = cfg.seedCount[focus];

  // ─── Step 1: Dual seeding (FTS + Vector via RRF) ───

  interface SeedEntry {
    symbolId: number;
    symbolIdStr: string;
    name: string;
    kind: string;
    fqn: string | null;
    fileId: number;
    score: number;
  }

  let seeds: SeedEntry[];

  const hasAI = ai?.vectorStore && ai?.embeddingService;

  if (hasAI) {
    const results = await hybridSearch(
      store.db,
      task,
      ai!.vectorStore,
      ai!.embeddingService,
      seedLimit,
    );
    seeds = results.map((r) => ({
      symbolId: r.symbolId,
      symbolIdStr: r.symbolIdStr,
      name: r.name,
      kind: r.kind,
      fqn: r.fqn,
      fileId: r.fileId,
      score: r.score,
    }));
  } else {
    // FTS-only fallback
    const tokens = tokenizeDescription(task);
    if (tokens.length === 0) {
      return emptyResult(task, intent);
    }
    const ftsQuery = tokens.map((t) => `"${t}"`).join(' OR ');
    const ftsRows = store.db.prepare(`
      SELECT s.id AS symbolId, s.symbol_id AS symbolIdStr, s.name, s.kind, s.fqn,
             s.file_id AS fileId, rank
      FROM symbols_fts fts
      JOIN symbols s ON s.id = fts.rowid
      WHERE symbols_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, seedLimit * 3) as Array<{
      symbolId: number; symbolIdStr: string; name: string;
      kind: string; fqn: string | null; fileId: number; rank: number;
    }>;

    if (ftsRows.length === 0) {
      return emptyResult(task, intent);
    }

    // Normalize ranks to scores (0-1)
    const minRank = Math.min(...ftsRows.map((r) => r.rank));
    const maxRank = Math.max(...ftsRows.map((r) => r.rank));
    const spread = maxRank - minRank || 1;

    seeds = ftsRows.slice(0, seedLimit).map((r) => ({
      symbolId: r.symbolId,
      symbolIdStr: r.symbolIdStr,
      name: r.name,
      kind: r.kind,
      fqn: r.fqn,
      fileId: r.fileId,
      score: 1 - (r.rank - minRank) / spread,
    }));
  }

  if (seeds.length === 0) {
    return emptyResult(task, intent);
  }

  // ─── Step 2: Resolve node IDs for seeds ───

  const seedSymIds = seeds.map((s) => s.symbolId);
  const seedNodeMap = store.getNodeIdsBatch('symbol', seedSymIds);
  const seedNodeIds = seeds
    .map((s) => seedNodeMap.get(s.symbolId))
    .filter((id): id is number => id != null);

  // ─── Step 3: Multi-hop graph walk ───

  const walkedNodes = walkGraph(store, seedNodeIds, cfg.graphDepth, cfg.priorityEdges);

  // ─── Step 4: Resolve all discovered nodes to symbols + files ───

  const allNodeIds = [...walkedNodes.keys()];
  const nodeRefs = store.getNodeRefsBatch(allNodeIds);

  // Collect symbol ref IDs
  const symbolRefIds: number[] = [];
  for (const [, ref] of nodeRefs) {
    if (ref.nodeType === 'symbol') symbolRefIds.push(ref.refId);
  }

  const symbolMap = store.getSymbolsByIds(symbolRefIds);
  const fileIds = [...new Set([...symbolMap.values()].map((s) => s.file_id))];
  const fileMap = store.getFilesByIds(fileIds);

  // ─── Step 5: PageRank ───

  const pagerankMap = computePageRank(store.db);
  const maxPr = Math.max(...pagerankMap.values(), 0.001);
  const now = new Date();

  // ─── Step 6: Classify and score into sections ───

  const seedNodeIdSet = new Set(seedNodeIds);
  const testEdgeSet = new Set(TEST_EDGES);
  const typeEdgeSet = new Set(TYPE_EDGES);

  interface ScoredEntry {
    symbol: SymbolRow;
    file: FileRow;
    score: number;
    section: 'primary' | 'dependencies' | 'callers' | 'tests' | 'types';
  }

  const entries: ScoredEntry[] = [];
  const seenSymIds = new Set<number>();

  for (const [nodeId, walkInfo] of walkedNodes) {
    const ref = nodeRefs.get(nodeId);
    if (!ref || ref.nodeType !== 'symbol') continue;

    const sym = symbolMap.get(ref.refId);
    if (!sym || seenSymIds.has(sym.id)) continue;
    seenSymIds.add(sym.id);

    const file = fileMap.get(sym.file_id);
    if (!file) continue;

    // Determine section
    let section: ScoredEntry['section'];
    if (walkInfo.depth === 0) {
      section = 'primary';
    } else if (testEdgeSet.has(walkInfo.edgeType)) {
      section = 'tests';
    } else if (typeEdgeSet.has(walkInfo.edgeType)) {
      section = 'types';
    } else if (walkInfo.direction === 'outgoing') {
      section = 'dependencies';
    } else {
      section = 'callers';
    }

    // Score
    const seedEntry = seeds.find((s) => s.symbolId === sym.id);
    const relevance = seedEntry ? seedEntry.score : 0.3;
    const pr = (pagerankMap.get(nodeId) ?? 0) / maxPr;
    const recency = computeRecency(file.indexed_at, now);
    const typeBonus = getTypeBonus(sym.kind);

    let score = hybridScore({ relevance, pagerank: pr, recency, typeBonus });

    // Penalize non-code files (docs, config, yaml, markdown) — they waste tokens
    const NON_CODE_LANGUAGES = new Set(['markdown', 'yaml', 'json', 'toml', 'xml', 'html', 'csv', 'text', 'ini']);
    if (file.language && NON_CODE_LANGUAGES.has(file.language.toLowerCase())) {
      score *= 0.2;
    }

    // Depth decay for graph-expanded items
    if (walkInfo.depth > 0) {
      score *= 1 / (1 + 0.3 * walkInfo.depth);
    }

    entries.push({ symbol: sym, file, score, section });
  }

  // ─── Step 7: Test coverage discovery ───

  if (includeTests) {
    // Find test_covers edges for primary + dependency symbols
    const primaryAndDepNodeIds = entries
      .filter((e) => e.section === 'primary' || e.section === 'dependencies')
      .map((e) => seedNodeMap.get(e.symbol.id) ?? store.getNodeIdsBatch('symbol', [e.symbol.id]).get(e.symbol.id))
      .filter((id): id is number => id != null);

    if (primaryAndDepNodeIds.length > 0) {
      const testEdges = store.getEdgesForNodesBatch(primaryAndDepNodeIds);
      const testNodeIds: number[] = [];
      for (const edge of testEdges) {
        if (edge.edge_type_name !== 'test_covers') continue;
        // test_covers: test → source, so the source_node_id is the test
        const testNodeId = edge.source_node_id;
        if (!seenSymIds.has(testNodeId)) testNodeIds.push(testNodeId);
      }

      if (testNodeIds.length > 0) {
        const testRefs = store.getNodeRefsBatch(testNodeIds);
        const testSymIds = [...testRefs.values()]
          .filter((r) => r.nodeType === 'symbol')
          .map((r) => r.refId);
        const testSyms = store.getSymbolsByIds(testSymIds);
        const testFileIds = [...new Set([...testSyms.values()].map((s) => s.file_id))];
        const testFiles = store.getFilesByIds(testFileIds);

        for (const [, sym] of testSyms) {
          if (seenSymIds.has(sym.id)) continue;
          seenSymIds.add(sym.id);
          const file = testFiles.get(sym.file_id);
          if (!file) continue;

          const pr = 0;
          const recency = computeRecency(file.indexed_at, now);
          const score = hybridScore({ relevance: 0.2, pagerank: pr, recency, typeBonus: 0.5 }) * 0.8;

          entries.push({ symbol: sym, file, score, section: 'tests' });
        }
      }
    }
  }

  // ─── Step 8: Build context items per section ───

  const sectionItems: Record<ScoredEntry['section'], ContextItem[]> = {
    primary: [],
    dependencies: [],
    callers: [],
    tests: [],
    types: [],
  };

  for (const entry of entries) {
    const meta = `[${entry.symbol.kind}] ${entry.symbol.fqn ?? entry.symbol.name} (${entry.file.path})`;

    let source: string | undefined;
    try {
      const absPath = path.resolve(rootPath, entry.file.path);
      source = readByteRange(absPath, entry.symbol.byte_start, entry.symbol.byte_end, !!entry.file.gitignored);
    } catch { /* source unavailable */ }

    sectionItems[entry.section].push({
      id: entry.symbol.symbol_id,
      score: entry.score,
      source,
      signature: entry.symbol.signature ?? undefined,
      metadata: meta,
    });
  }

  // ─── Step 9: Structured assembly with intent-specific budget weights ───

  // Split budget: tests get their own allocation
  const testBudgetRatio = includeTests ? getTestBudgetRatio(cfg) : 0;
  const mainBudget = Math.floor(tokenBudget * (1 - testBudgetRatio));
  const testBudget = tokenBudget - mainBudget;

  const assembled = assembleStructuredContext({
    primary: sectionItems.primary,
    dependencies: sectionItems.dependencies,
    callers: sectionItems.callers,
    typeContext: sectionItems.types,
    totalBudget: mainBudget,
    budgetWeights: cfg.budgetWeights,
  });

  // Assemble tests separately with their own budget
  const testAssembled = assembleStructuredContext({
    primary: sectionItems.tests,
    dependencies: [],
    callers: [],
    typeContext: [],
    totalBudget: testBudget,
    budgetWeights: { primary: 1, dependencies: 0, callers: 0, typeContext: 0 },
  });

  // ─── Step 10: Build result ───

  function mapItems(items: Array<{ id: string; score: number; detail: string; content: string; tokens: number }>): TaskContextItem[] {
    return items.map((ai) => {
      const entry = entries.find((e) => e.symbol.symbol_id === ai.id);
      return {
        symbolId: ai.id,
        name: entry?.symbol.name ?? ai.id,
        kind: entry?.symbol.kind ?? 'unknown',
        fqn: entry?.symbol.fqn ?? null,
        filePath: entry?.file.path ?? '',
        score: ai.score,
        detail: ai.detail as TaskContextItem['detail'],
        content: ai.content,
        tokens: ai.tokens,
      };
    });
  }

  return {
    task,
    intent,
    sections: {
      primary: mapItems(assembled.primary),
      dependencies: mapItems(assembled.dependencies),
      callers: mapItems(assembled.callers),
      tests: mapItems(testAssembled.primary),
      types: mapItems(assembled.typeContext),
    },
    totalTokens: assembled.totalTokens + testAssembled.totalTokens,
    truncated: assembled.truncated || testAssembled.truncated,
    seedCount: seeds.length,
    graphNodesExplored: walkedNodes.size,
  };
}

function emptyResult(task: string, intent: TaskIntent): TaskContextResult {
  return {
    task,
    intent,
    sections: { primary: [], dependencies: [], callers: [], tests: [], types: [] },
    totalTokens: 0,
    truncated: false,
    seedCount: 0,
    graphNodesExplored: 0,
  };
}
