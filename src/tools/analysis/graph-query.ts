import { searchFts } from '../../db/fts.js';
import type { FileRow, Store, SymbolRow } from '../../db/store.js';
import { err, notFound, ok, type TraceMcpResult } from '../../errors.js';

// ── SQL Detection ────────────────────────────────────────────────────────────
// graph_query is a natural-language graph traversal tool, not a SQL endpoint.
// If a user pastes a SQL statement, the FTS fallback tends to match arbitrary
// keywords ("query", "limit", "from") and produce a misleading subgraph. We
// detect SQL-shaped input up front and refuse it with a clear validation error.

// Tokens that almost never appear outside SQL. Matching ANY of these strongly
// suggests SQL — but bare FROM/WHERE/JOIN appear in English too (e.g. "from A
// to B"), so we require *two or more* distinct tokens before rejecting.
const SQL_TOKENS_RE = /\b(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|JOIN|INSERT|UPDATE|DELETE)\b/gi;

// Strong SQL signals — these don't appear in plain English questions about
// code. Any single occurrence is enough to flag the query as SQL.
const STRONG_SQL_RE =
  /\b(SELECT\s+(?:\*|DISTINCT|COUNT|SUM|AVG|MIN|MAX|TOP))\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bCOUNT\s*\(\s*\*\s*\)/i;

// Graph phrases that suggest the query is NL and should be allowed even when
// it contains a bare SQL token like "from".
const GRAPH_PHRASE_RE = /\b(flow|depends?|breaks?|calls?|imports?|references?|how|path|trace)\b|→/i;

const SQL_REJECTION_EXAMPLES = [
  'how does AuthService flow to Database',
  'what depends on UserModel',
  'trace the flow of LoginHandler',
];

function looksLikeSql(query: string): boolean {
  // Strong signals: any single high-confidence SQL idiom rejects immediately.
  if (STRONG_SQL_RE.test(query)) return true;

  // Otherwise require at least two distinct SQL tokens. "from A to B" has one
  // (FROM), "SELECT … FROM" has two — and that's typically real SQL.
  const matches = query.match(SQL_TOKENS_RE);
  if (!matches) return false;
  const distinct = new Set(matches.map((m) => m.toUpperCase().replace(/\s+/g, ' ')));
  if (distinct.size < 2) return false;

  // Even with 2+ tokens, give NL frames the benefit of the doubt when an
  // explicit graph verb is present (e.g. "trace path from A to B where it
  // calls Database" — contrived, but should not be rejected).
  if (GRAPH_PHRASE_RE.test(query)) return false;
  return true;
}

// ── Types ────────────────────────────────────────────────────────────────────

type GraphQueryIntent =
  | 'path' // "How does X flow to Y?"
  | 'dependents' // "What depends on X?"
  | 'dependencies' // "What does X depend on?"
  | 'flow' // "Trace the flow through X" (bidirectional)
  | 'between'; // "What connects X and Y?"

interface GraphNode {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  fqn: string | null;
}

interface GraphEdge {
  source: string; // symbol_id
  target: string; // symbol_id
  edge_type: string;
}

interface PathStep {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  edge_to_next: string | null;
}

interface GraphQueryResult {
  query: string;
  intent: GraphQueryIntent;
  anchors: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths?: PathStep[][];
  mermaid: string;
  /** Set when the serialized payload would have exceeded MAX_PAYLOAD_BYTES
   *  and we dropped nodes/edges (and regenerated Mermaid) to fit. */
  truncated?: boolean;
  _meta?: { warnings: string[] };
}

// ── Intent Classification ────────────────────────────────────────────────────

const PATH_PATTERNS = [
  /how\s+does?\s+(.+?)\s+(?:flow|get|reach|connect|go)\s+(?:to|from|into|through)\s+(.+)/i,
  /(?:trace|path|flow)\s+(?:from|between)\s+(.+?)\s+(?:to|and|through)\s+(.+)/i,
  /from\s+(.+?)\s+to\s+(.+)/i,
];

const DEPENDENT_PATTERNS = [
  /what\s+(?:depends?\s+on|uses?|imports?|consumes?|calls?)\s+(.+)/i,
  /(?:dependents?|callers?|consumers?|importers?)\s+(?:of|for)\s+(.+)/i,
  /who\s+(?:uses?|calls?|depends?\s+on)\s+(.+)/i,
];

const DEPENDENCY_PATTERNS = [
  /what\s+does?\s+(.+?)\s+(?:depend\s+on|use|import|call|require)/i,
  /(?:dependencies|imports)\s+(?:of|for)\s+(.+)/i,
];

const FLOW_PATTERNS = [
  /(?:trace|show|visuali[sz]e)\s+(?:the\s+)?(?:flow|path|chain|pipeline)\s+(?:of|through|for|in)\s+(.+)/i,
  /(?:flow|lifecycle|chain)\s+(?:of|for)\s+(.+)/i,
];

const BETWEEN_PATTERNS = [
  /(?:what\s+connects?|relationship|link)\s+(?:between\s+)?(.+?)\s+(?:and|to|with)\s+(.+)/i,
  /(?:between)\s+(.+?)\s+(?:and)\s+(.+)/i,
];

interface ClassifiedQuery {
  intent: GraphQueryIntent;
  anchors: string[];
}

function classifyQuery(query: string): ClassifiedQuery {
  for (const re of PATH_PATTERNS) {
    const m = query.match(re);
    if (m) return { intent: 'path', anchors: [m[1].trim(), m[2].trim()] };
  }
  for (const re of BETWEEN_PATTERNS) {
    const m = query.match(re);
    if (m) return { intent: 'between', anchors: [m[1].trim(), m[2].trim()] };
  }
  for (const re of DEPENDENT_PATTERNS) {
    const m = query.match(re);
    if (m) return { intent: 'dependents', anchors: [m[1].trim()] };
  }
  for (const re of DEPENDENCY_PATTERNS) {
    const m = query.match(re);
    if (m) return { intent: 'dependencies', anchors: [m[1].trim()] };
  }
  for (const re of FLOW_PATTERNS) {
    const m = query.match(re);
    if (m) return { intent: 'flow', anchors: [m[1].trim()] };
  }

  // Fallback: extract nouns/identifiers and default to 'flow' for single, 'path' for two
  const tokens = query
    .replace(/[?!.,;:'"]/g, '')
    .split(/\s+/)
    .filter(
      (t) =>
        t.length > 2 &&
        !/^(how|does|the|from|what|is|are|and|to|in|of|for|a|an|this|that|with)$/i.test(t),
    );

  if (tokens.length >= 2) {
    return { intent: 'path', anchors: [tokens[0], tokens[tokens.length - 1]] };
  }
  return { intent: 'flow', anchors: tokens.length > 0 ? [tokens[0]] : [] };
}

// ── Symbol Resolution ────────────────────────────────────────────────────────

/**
 * If the simple name of the matched symbol collides with this many other
 * symbols (case-sensitive exact), and the match came from FTS rather than an
 * exact symbol_id/FQN/name lookup, we consider the anchor weak ("god-name
 * filter"). Mirrors the phantom-god-node filter used in findReferences.
 */
const AMBIGUOUS_NAME_THRESHOLD = 10;

type AnchorMatchKind = 'symbol_id' | 'fqn' | 'name' | 'fts';

interface AnchorResolution {
  /** The candidate symbol. Undefined when nothing matched at all. */
  symbol: SymbolRow | undefined;
  /** How the match was made — informs confidence. */
  matchKind: AnchorMatchKind | 'none';
  /** Heuristic score in [0, 1]. Higher = more confident this is the user's intent. */
  score: number;
  /** How many other symbols share the matched symbol's simple name. */
  nameCollisions: number;
  /** True when the only evidence is a fuzzy text match into a high-collision name. */
  isWeak: boolean;
  /** The original anchor string the user supplied. */
  anchor: string;
}

function scoreFromMatchKind(kind: AnchorMatchKind): number {
  switch (kind) {
    case 'symbol_id':
      return 1.0;
    case 'fqn':
      return 0.9;
    case 'name':
      return 0.7;
    case 'fts':
      return 0.4;
  }
}

function resolveAnchor(store: Store, anchor: string): AnchorResolution {
  // Try exact match by symbol_id
  const bySid = store.getSymbolBySymbolId(anchor);
  if (bySid) {
    return {
      symbol: bySid,
      matchKind: 'symbol_id',
      score: scoreFromMatchKind('symbol_id'),
      nameCollisions: store.countSymbolsByName(bySid.name),
      isWeak: false,
      anchor,
    };
  }

  // Try FQN
  const byFqn = store.getSymbolByFqn(anchor);
  if (byFqn) {
    return {
      symbol: byFqn,
      matchKind: 'fqn',
      score: scoreFromMatchKind('fqn'),
      nameCollisions: store.countSymbolsByName(byFqn.name),
      isWeak: false,
      anchor,
    };
  }

  // Try name match
  const byName = store.getSymbolByName(anchor);
  if (byName) {
    const nameCollisions = store.countSymbolsByName(byName.name);
    // A direct name lookup is normally strong — the user typed the name
    // verbatim — but when the same name is shared by many symbols we still
    // can't tell which one was meant. Flag as weak so the caller knows the
    // disambiguation failed.
    const isWeak = nameCollisions >= AMBIGUOUS_NAME_THRESHOLD;
    return {
      symbol: byName,
      matchKind: 'name',
      score: isWeak ? 0.3 : scoreFromMatchKind('name'),
      nameCollisions,
      isWeak,
      anchor,
    };
  }

  // FTS fallback — pick the best hit
  const ftsResults = searchFts(store.db, anchor, 5);
  if (ftsResults.length > 0) {
    const sym = store.getSymbolById(ftsResults[0].symbolId as unknown as number);
    if (!sym) {
      return {
        symbol: undefined,
        matchKind: 'none',
        score: 0,
        nameCollisions: 0,
        isWeak: true,
        anchor,
      };
    }
    const nameCollisions = store.countSymbolsByName(sym.name);
    // The FTS hit is weakly grounded when the chosen symbol's name is a
    // common token shared by many other symbols — that's the "god-name"
    // signature. A SQL keyword like "query" or "limit" matching a popular
    // identifier is exactly this scenario.
    const anchorLower = anchor.toLowerCase();
    const symNameLower = sym.name.toLowerCase();
    const exactish =
      anchorLower === symNameLower ||
      (sym.fqn != null && sym.fqn.toLowerCase() === anchorLower) ||
      sym.symbol_id.toLowerCase() === anchorLower;
    const isWeak = !exactish && nameCollisions >= AMBIGUOUS_NAME_THRESHOLD;
    return {
      symbol: sym,
      matchKind: 'fts',
      score: isWeak ? 0.1 : scoreFromMatchKind('fts'),
      nameCollisions,
      isWeak,
      anchor,
    };
  }

  return {
    symbol: undefined,
    matchKind: 'none',
    score: 0,
    nameCollisions: 0,
    isWeak: true,
    anchor,
  };
}

// ── Graph Building Helpers ───────────────────────────────────────────────────

const ALL_TRAVERSAL_EDGES = new Set([
  'calls',
  'references',
  'imports',
  'esm_imports',
  'py_imports',
  'extends',
  'implements',
  'uses_trait',
  'dispatches',
  'routes_to',
  'validates_with',
  'nest_injects',
  'graphql_resolves',
  'inertia_renders',
  'renders',
  'has_one',
  'has_many',
  'belongs_to',
  'many_to_many',
  'uses_middleware',
  'listens_to',
]);

function symbolToNode(sym: SymbolRow, fileMap: Map<number, FileRow>): GraphNode {
  const file = fileMap.get(sym.file_id);
  return {
    symbol_id: sym.symbol_id,
    name: sym.name,
    kind: sym.kind,
    file: file?.path ?? '',
    line: sym.line_start,
    fqn: sym.fqn,
  };
}

interface TraversalContext {
  store: Store;
  visitedNodes: Set<number>; // node IDs
  collectedEdges: Map<string, { srcNodeId: number; tgtNodeId: number; edgeType: string }>;
  symbolIds: Set<number>;
  maxNodes: number;
}

function traverseBFS(
  ctx: TraversalContext,
  startNodeIds: number[],
  direction: 'outgoing' | 'incoming' | 'both',
  depth: number,
): void {
  // Start nodes MUST be in the frontier to discover their edges,
  // even if already in visitedNodes (which only prevents re-queuing as neighbors).
  let frontier = [...startNodeIds];
  for (const id of frontier) ctx.visitedNodes.add(id);

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    if (ctx.symbolIds.size >= ctx.maxNodes) break;

    const batchEdges = ctx.store.getEdgesForNodesBatch(frontier);
    const nextFrontier: number[] = [];

    for (const edge of batchEdges) {
      if (!ALL_TRAVERSAL_EDGES.has(edge.edge_type_name)) continue;

      let neighborNodeId: number | undefined;

      if (direction !== 'incoming' && edge.source_node_id === edge.pivot_node_id) {
        neighborNodeId = edge.target_node_id;
      }
      if (direction !== 'outgoing' && edge.target_node_id === edge.pivot_node_id) {
        neighborNodeId = edge.source_node_id;
      }
      if (neighborNodeId == null) continue;

      // Record edge keyed by src-tgt-type
      const edgeKey = `${edge.source_node_id}:${edge.target_node_id}:${edge.edge_type_name}`;
      if (!ctx.collectedEdges.has(edgeKey)) {
        ctx.collectedEdges.set(edgeKey, {
          srcNodeId: edge.source_node_id,
          tgtNodeId: edge.target_node_id,
          edgeType: edge.edge_type_name,
        });
      }

      if (!ctx.visitedNodes.has(neighborNodeId)) {
        ctx.visitedNodes.add(neighborNodeId);
        nextFrontier.push(neighborNodeId);
      }
    }

    // Resolve new nodes to symbols, enforce node cap
    if (nextFrontier.length > 0) {
      const refs = ctx.store.getNodeRefsBatch(nextFrontier);
      for (const [_nid, ref] of refs) {
        if (ref.nodeType === 'symbol') {
          if (ctx.symbolIds.size >= ctx.maxNodes) break;
          ctx.symbolIds.add(ref.refId);
        }
      }
    }

    frontier = nextFrontier;
  }
}

// ── BFS Path Finding ─────────────────────────────────────────────────────────

interface BFSPathResult {
  path: number[]; // node IDs from start to end
  edgeTypes: string[]; // edge type at each step
}

function findShortestPath(
  store: Store,
  startNodeId: number,
  endNodeId: number,
  maxDepth: number,
): BFSPathResult | null {
  if (startNodeId === endNodeId) return { path: [startNodeId], edgeTypes: [] };

  const visited = new Set<number>([startNodeId]);
  const parent = new Map<number, { from: number; edgeType: string }>();
  let frontier = [startNodeId];

  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const batchEdges = store.getEdgesForNodesBatch(frontier);
    const nextFrontier: number[] = [];

    for (const edge of batchEdges) {
      if (!ALL_TRAVERSAL_EDGES.has(edge.edge_type_name)) continue;

      // Bidirectional: check both directions
      const neighbors: Array<{ nodeId: number; from: number }> = [];
      if (edge.source_node_id === edge.pivot_node_id) {
        neighbors.push({ nodeId: edge.target_node_id, from: edge.source_node_id });
      }
      if (edge.target_node_id === edge.pivot_node_id) {
        neighbors.push({ nodeId: edge.source_node_id, from: edge.target_node_id });
      }

      for (const { nodeId, from } of neighbors) {
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);
        parent.set(nodeId, { from, edgeType: edge.edge_type_name });
        nextFrontier.push(nodeId);

        if (nodeId === endNodeId) {
          // Reconstruct path
          const path: number[] = [endNodeId];
          const edgeTypes: string[] = [];
          let cur = endNodeId;
          while (cur !== startNodeId) {
            const p = parent.get(cur)!;
            path.unshift(p.from);
            edgeTypes.unshift(p.edgeType);
            cur = p.from;
          }
          return { path, edgeTypes };
        }
      }
    }

    frontier = nextFrontier;
  }

  return null;
}

// ── Mermaid Generation ───────────────────────────────────────────────────────

function sanitizeMermaid(s: string): string {
  return s.replace(/[[\](){}|<>"]/g, '_');
}

function generateMermaid(nodes: GraphNode[], edges: GraphEdge[], paths?: PathStep[][]): string {
  const lines: string[] = ['graph LR'];

  // Create a short ID mapping for readability
  const idMap = new Map<string, string>();
  let counter = 0;
  for (const n of nodes) {
    const id = `n${counter++}`;
    idMap.set(n.symbol_id, id);
    const label = sanitizeMermaid(`${n.kind}:${n.name}`);
    lines.push(`  ${id}["${label}"]`);
  }

  // Highlight path nodes if present
  if (paths && paths.length > 0) {
    const pathSymbols = new Set(paths.flatMap((p) => p.map((s) => s.symbol_id)));
    const pathIds = [...pathSymbols].map((sid) => idMap.get(sid)).filter(Boolean);
    if (pathIds.length > 0) {
      lines.push(`  style ${pathIds.join(',')} fill:#f9f,stroke:#333,stroke-width:2px`);
    }
  }

  for (const e of edges) {
    const src = idMap.get(e.source);
    const tgt = idMap.get(e.target);
    if (src && tgt) {
      const label = sanitizeMermaid(e.edge_type);
      lines.push(`  ${src} -->|${label}| ${tgt}`);
    }
  }

  return lines.join('\n');
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

const MAX_DEPTH = 6;
const MAX_NODES = 100;
/**
 * Hard ceiling on serialized JSON payload size returned to the caller. If the
 * assembled subgraph exceeds this, we drop nodes (and any edges that referenced
 * them) until it fits, then surface a truncation warning. 100 KB is a balance
 * between giving the LLM useful structure and not blowing context budgets on
 * runaway traversals.
 */
const MAX_PAYLOAD_BYTES = 100 * 1024;

export function graphQuery(
  store: Store,
  query: string,
  options: { depth?: number; max_nodes?: number } = {},
): TraceMcpResult<GraphQueryResult> {
  const depth = Math.min(options.depth ?? 3, MAX_DEPTH);
  const maxNodes = Math.min(options.max_nodes ?? MAX_NODES, 200);
  const warnings: string[] = [];

  // 0. Reject SQL-shaped input before we let FTS run wild on it. Without this
  //    guard, a stray "SELECT … FROM routes" produces a 60+ KB blob of unrelated
  //    nodes because every SQL keyword fuzzy-matches against a popular symbol.
  if (looksLikeSql(query)) {
    return err({
      code: 'VALIDATION_ERROR',
      message:
        'This query looks like SQL. graph_query is a natural-language graph traversal — see examples. For raw SQL over the index, this is not the right tool.',
      details: { examples: SQL_REJECTION_EXAMPLES },
    });
  }

  // 1. Classify intent
  const classified = classifyQuery(query);
  if (classified.anchors.length === 0) {
    return err({
      code: 'VALIDATION_ERROR',
      message:
        'Could not extract any symbol references from query. Try: "how does AuthService flow to Database?" or "what depends on UserModel?"',
    });
  }

  // 2. Resolve anchor symbols (with confidence scoring + god-name filter).
  //    Each anchor gets a score and an `isWeak` flag — a weak anchor means the
  //    only evidence is a fuzzy FTS match into a name shared by many symbols
  //    (e.g. "query" → some QueryOp type from a plugin we don't care about).
  const resolutions: AnchorResolution[] = classified.anchors.map((a) => resolveAnchor(store, a));
  const strongResolutions = resolutions.filter((r) => r.symbol && !r.isWeak);
  const weakResolutions = resolutions.filter((r) => r.symbol && r.isWeak);
  const unresolvedAnchors = resolutions.filter((r) => !r.symbol).map((r) => r.anchor);

  if (strongResolutions.length === 0) {
    // No anchor passed the god-name filter. Surface what we tried so the
    // caller sees why we refused to run the traversal.
    const weakAnchorCandidates = weakResolutions.map((r) => ({
      anchor: r.anchor,
      matched_name: r.symbol?.name ?? null,
      matched_symbol_id: r.symbol?.symbol_id ?? null,
      match_kind: r.matchKind,
      score: Number(r.score.toFixed(2)),
      name_collisions: r.nameCollisions,
    }));

    if (weakResolutions.length > 0) {
      return err({
        code: 'VALIDATION_ERROR',
        message:
          'Could not extract any symbol references from query. All candidate anchors matched too many unrelated symbols (god-name collisions). Try a more specific name, FQN, or symbol_id.',
        details: { weak_anchor_candidates: weakAnchorCandidates },
      });
    }

    const candidates = classified.anchors.flatMap((a) => {
      const fts = searchFts(store.db, a, 3);
      return fts.map((f) => f.name);
    });
    return err(
      notFound(classified.anchors.join(', '), candidates.length > 0 ? candidates : undefined),
    );
  }

  const anchorSymbols: SymbolRow[] = strongResolutions
    .map((r) => r.symbol)
    .filter((s): s is SymbolRow => s !== undefined);

  if (unresolvedAnchors.length > 0) {
    warnings.push(
      `Could not resolve: ${unresolvedAnchors.join(', ')}. Proceeding with resolved symbols only.`,
    );
  }

  if (weakResolutions.length > 0) {
    warnings.push(
      `Dropped ${weakResolutions.length} weakly-grounded anchor(s) (god-name collision): ${weakResolutions
        .map((r) => `"${r.anchor}"`)
        .join(', ')}. Proceeding with stronger anchors only.`,
    );
  }

  // 3. Get node IDs for anchors
  const anchorNodeIds: number[] = [];
  const symbolIds = new Set<number>();
  for (const sym of anchorSymbols) {
    const nodeId = store.getNodeId('symbol', sym.id);
    if (nodeId) {
      anchorNodeIds.push(nodeId);
      symbolIds.add(sym.id);
    }
  }

  if (anchorNodeIds.length === 0) {
    return err(notFound('graph nodes for resolved symbols'));
  }

  // 4. Execute graph operation based on intent
  const ctx: TraversalContext = {
    store,
    visitedNodes: new Set(anchorNodeIds),
    collectedEdges: new Map(),
    symbolIds,
    maxNodes,
  };

  let pathResults: BFSPathResult[] | undefined;

  switch (classified.intent) {
    case 'path':
    case 'between': {
      if (anchorNodeIds.length >= 2) {
        const pathResult = findShortestPath(store, anchorNodeIds[0], anchorNodeIds[1], depth + 2);
        if (pathResult) {
          pathResults = [pathResult];
          // Collect all nodes along the path
          for (const nid of pathResult.path) ctx.visitedNodes.add(nid);
          // Also do a shallow expansion around path nodes for context
          traverseBFS(ctx, pathResult.path, 'both', 1);
        } else {
          warnings.push(
            'No direct path found between the two symbols. Showing neighborhoods instead.',
          );
          traverseBFS(ctx, [anchorNodeIds[0]], 'both', depth);
          traverseBFS(ctx, [anchorNodeIds[1]], 'both', depth);
        }
      } else {
        // Single anchor, trace both directions
        traverseBFS(ctx, anchorNodeIds, 'both', depth);
      }
      break;
    }

    case 'dependents':
      traverseBFS(ctx, anchorNodeIds, 'incoming', depth);
      break;

    case 'dependencies':
      traverseBFS(ctx, anchorNodeIds, 'outgoing', depth);
      break;

    case 'flow':
      traverseBFS(ctx, anchorNodeIds, 'both', depth);
      break;
  }

  // 5. Resolve all collected node IDs to symbols (respecting maxNodes cap)
  const allNodeIds = [...ctx.visitedNodes];
  const nodeRefs = store.getNodeRefsBatch(allNodeIds);
  for (const [, ref] of nodeRefs) {
    if (ref.nodeType === 'symbol') {
      if (symbolIds.size >= maxNodes) break;
      symbolIds.add(ref.refId);
    }
  }

  const allSymbolRefIds = [...symbolIds];
  const symbolMap =
    allSymbolRefIds.length > 0
      ? store.getSymbolsByIds(allSymbolRefIds)
      : new Map<number, SymbolRow>();
  const allFileIds = [...new Set([...symbolMap.values()].map((s) => s.file_id))];
  const fileMap =
    allFileIds.length > 0 ? store.getFilesByIds(allFileIds) : new Map<number, FileRow>();

  // Build nodeId → symbolId mapping
  const nodeToSymbol = new Map<number, SymbolRow>();
  for (const [nid, ref] of nodeRefs) {
    if (ref.nodeType === 'symbol') {
      const sym = symbolMap.get(ref.refId);
      if (sym) nodeToSymbol.set(nid, sym);
    }
  }

  // 6. Build output nodes and edges
  const outputNodes: GraphNode[] = [];
  const seenSymbolIds = new Set<string>();
  for (const sym of symbolMap.values()) {
    if (!seenSymbolIds.has(sym.symbol_id)) {
      seenSymbolIds.add(sym.symbol_id);
      outputNodes.push(symbolToNode(sym, fileMap));
    }
  }

  const outputEdges: GraphEdge[] = [];
  for (const collected of ctx.collectedEdges.values()) {
    const srcSym = nodeToSymbol.get(collected.srcNodeId);
    const tgtSym = nodeToSymbol.get(collected.tgtNodeId);
    if (srcSym && tgtSym) {
      outputEdges.push({
        source: srcSym.symbol_id,
        target: tgtSym.symbol_id,
        edge_type: collected.edgeType,
      });
    }
  }

  // 7. Build path steps if we found paths
  let outputPaths: PathStep[][] | undefined;
  if (pathResults && pathResults.length > 0) {
    outputPaths = pathResults.map((pr) => {
      return pr.path.map((nid, i) => {
        const sym = nodeToSymbol.get(nid);
        const file = sym ? fileMap.get(sym.file_id) : undefined;
        return {
          symbol_id: sym?.symbol_id ?? `node:${nid}`,
          name: sym?.name ?? '?',
          kind: sym?.kind ?? 'unknown',
          file: file?.path ?? '',
          line: sym?.line_start ?? null,
          edge_to_next: i < pr.edgeTypes.length ? pr.edgeTypes[i] : null,
        };
      });
    });
  }

  // 8. Generate Mermaid diagram
  let mermaid = generateMermaid(outputNodes, outputEdges, outputPaths);

  if (outputNodes.length >= maxNodes) {
    warnings.push(`Result capped at ${maxNodes} nodes. Use depth or max_nodes to adjust.`);
  }

  // 9. Apply payload-size cap. Some pathological queries assemble a small node
  //    count but each node carries a long file path / fqn, blowing past sane
  //    serialization budgets. Truncate by repeatedly halving the node list
  //    until the JSON fits, then drop any edges referencing dropped nodes.
  let truncated = false;
  const initialSize = Buffer.byteLength(
    JSON.stringify({ nodes: outputNodes, edges: outputEdges, paths: outputPaths }),
    'utf8',
  );
  let finalNodes = outputNodes;
  let finalEdges = outputEdges;
  let finalPaths = outputPaths;
  if (initialSize > MAX_PAYLOAD_BYTES) {
    truncated = true;
    // Preserve anchor nodes — they're the whole point of the query.
    const anchorSidSet = new Set(anchorSymbols.map((s) => s.symbol_id));
    const sorted = [...outputNodes].sort((a, b) => {
      const aAnchor = anchorSidSet.has(a.symbol_id) ? 1 : 0;
      const bAnchor = anchorSidSet.has(b.symbol_id) ? 1 : 0;
      return bAnchor - aAnchor;
    });

    let lo = 0;
    let hi = sorted.length;
    // Binary search for the largest prefix that fits.
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidateNodes = sorted.slice(0, mid);
      const keepSids = new Set(candidateNodes.map((n) => n.symbol_id));
      const candidateEdges = outputEdges.filter(
        (e) => keepSids.has(e.source) && keepSids.has(e.target),
      );
      const candidatePaths = outputPaths?.filter((p) =>
        p.every((step) => keepSids.has(step.symbol_id)),
      );
      const size = Buffer.byteLength(
        JSON.stringify({
          nodes: candidateNodes,
          edges: candidateEdges,
          paths: candidatePaths,
        }),
        'utf8',
      );
      if (size <= MAX_PAYLOAD_BYTES) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    finalNodes = sorted.slice(0, lo);
    const keepSids = new Set(finalNodes.map((n) => n.symbol_id));
    finalEdges = outputEdges.filter((e) => keepSids.has(e.source) && keepSids.has(e.target));
    finalPaths = outputPaths?.filter((p) => p.every((step) => keepSids.has(step.symbol_id)));
    mermaid = generateMermaid(finalNodes, finalEdges, finalPaths);
    warnings.push(
      `Result payload exceeded ${MAX_PAYLOAD_BYTES} bytes — truncated from ${outputNodes.length} to ${finalNodes.length} nodes.`,
    );
  }

  const result: GraphQueryResult = {
    query,
    intent: classified.intent,
    anchors: anchorSymbols.map((s) => s.symbol_id),
    nodes: finalNodes,
    edges: finalEdges,
    mermaid,
  };

  if (finalPaths) result.paths = finalPaths;
  if (truncated) result.truncated = true;
  if (warnings.length > 0) result._meta = { warnings };

  return ok(result);
}
