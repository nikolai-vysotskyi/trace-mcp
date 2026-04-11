/**
 * Signal Fusion Pipeline — Weighted Reciprocal Rank Fusion across multiple retrieval channels.
 *
 * Channels:
 *   1. lexical  — BM25 full-text search ranks
 *   2. structural — PageRank (graph centrality)
 *   3. similarity — embedding cosine similarity (when AI available)
 *   4. identity — exact / prefix / segment match bonus
 *
 * Each channel produces its own ranked list.  WRR fuses them:
 *   score(item) = Σ_c weight_c × 1 / (k + rank_c(item))
 *
 * where rank_c(item) is the 0-based position in channel c's ranking,
 * and k is the RRF smoothing constant (default 60).
 */

// ── Types ────────────────────────────────────────────────────────────

export interface FusionWeights {
  lexical: number;
  structural: number;
  similarity: number;
  identity: number;
}

export interface FusionOptions {
  /** Per-channel weights (default: balanced). Values are auto-normalized to sum to 1. */
  weights?: Partial<FusionWeights>;
  /** RRF smoothing constant k (default 60). Higher = less top-heavy. */
  k?: number;
  /** Return per-channel debug info in each result. */
  debug?: boolean;
}

export interface ChannelRank {
  /** 0-based rank in this channel's result list. undefined = not present in channel. */
  rank: number | undefined;
  /** Raw score from the channel (for debug). */
  rawScore?: number;
}

export interface FusionDebugInfo {
  lexical: ChannelRank;
  structural: ChannelRank;
  similarity: ChannelRank;
  identity: ChannelRank;
  /** Per-channel contribution to final score. */
  contributions: FusionWeights;
}

export interface FusionCandidate {
  id: string;  // symbolIdStr
  /** Any extra data to carry through (symbol row, file, etc.) */
  data?: unknown;
}

export interface FusionResult {
  id: string;
  score: number;
  data?: unknown;
  debug?: FusionDebugInfo;
}

// ── Channel input ────────────────────────────────────────────────────

/** A ranked list from a single channel. Items are in rank order (best first). */
export interface ChannelInput {
  /** Items in rank order (index = rank). */
  items: Array<{ id: string; rawScore?: number; data?: unknown }>;
}

export interface FusionChannels {
  lexical?: ChannelInput;
  structural?: ChannelInput;
  similarity?: ChannelInput;
  identity?: ChannelInput;
}

// ── Default weights ──────────────────────────────────────────────────

const DEFAULT_WEIGHTS: FusionWeights = {
  lexical: 0.40,
  structural: 0.25,
  similarity: 0.20,
  identity: 0.15,
};

const DEFAULT_K = 60;

// ── Identity scoring ─────────────────────────────────────────────────

/**
 * Score a symbol name against the query for the identity channel.
 * Returns 0-1 score based on match quality.
 */
export function computeIdentityScore(query: string, symbolName: string, symbolFqn?: string | null): number {
  const q = query.toLowerCase();
  const name = symbolName.toLowerCase();
  const fqnLower = symbolFqn?.toLowerCase() ?? '';

  // Exact match (name or FQN)
  if (name === q) return 1.0;
  if (fqnLower === q) return 1.0;

  // FQN ends with query (e.g. query="search", fqn="navigation.ts::search")
  if (fqnLower.endsWith(q)) return 0.9;

  // Prefix match
  if (name.startsWith(q)) return 0.8;

  // Segment match: query matches a camelCase/snake_case segment
  // Use original casing for camelCase split, then lowercase
  const segments = splitSegments(symbolName);
  if (segments.some((s) => s === q)) return 0.7;

  // FQN segment match
  if (symbolFqn) {
    const fqnSegments = symbolFqn.toLowerCase().split(/[::#./\-]+/);
    if (fqnSegments.some((seg) => seg === q)) return 0.6;
  }

  // Partial segment prefix
  if (segments.some((s) => s.startsWith(q))) return 0.5;

  // Substring containment
  if (name.includes(q)) return 0.3;
  if (fqnLower.includes(q)) return 0.2;

  return 0;
}

/** Split a name into camelCase / snake_case / kebab-case segments. */
function splitSegments(name: string): string[] {
  // Split on _ - . :: then further split camelCase
  return name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .split(/[_\-.:]+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);
}

// ── Fusion engine ────────────────────────────────────────────────────

/**
 * Fuse multiple retrieval channels using Weighted Reciprocal Rank Fusion.
 *
 * Each channel provides a ranked list of candidates. WRR computes:
 *   score(item) = Σ_c  normalizedWeight_c × 1 / (k + rank_c(item))
 *
 * Items not present in a channel receive no contribution from that channel.
 */
export function signalFusion(
  channels: FusionChannels,
  options?: FusionOptions,
): FusionResult[] {
  const k = options?.k ?? DEFAULT_K;
  const debug = options?.debug ?? false;

  // Normalize weights — only include channels that have data
  const rawWeights = { ...DEFAULT_WEIGHTS, ...options?.weights };
  const activeChannels = (Object.keys(channels) as Array<keyof FusionChannels>)
    .filter((ch) => channels[ch] && channels[ch]!.items.length > 0);

  if (activeChannels.length === 0) return [];

  // Zero out weights for channels without data, then normalize
  const weights: FusionWeights = { lexical: 0, structural: 0, similarity: 0, identity: 0 };
  let weightSum = 0;
  for (const ch of activeChannels) {
    weights[ch] = rawWeights[ch];
    weightSum += rawWeights[ch];
  }
  if (weightSum > 0) {
    for (const ch of activeChannels) {
      weights[ch] /= weightSum;
    }
  }

  // Build rank maps for each channel: id → { rank, rawScore }
  const rankMaps = new Map<keyof FusionChannels, Map<string, { rank: number; rawScore?: number }>>();
  for (const ch of activeChannels) {
    const map = new Map<string, { rank: number; rawScore?: number }>();
    const items = channels[ch]!.items;
    for (let i = 0; i < items.length; i++) {
      map.set(items[i].id, { rank: i, rawScore: items[i].rawScore });
    }
    rankMaps.set(ch, map);
  }

  // Collect all unique candidate IDs and their data
  const allIds = new Map<string, unknown>();
  for (const ch of activeChannels) {
    for (const item of channels[ch]!.items) {
      if (!allIds.has(item.id)) {
        allIds.set(item.id, item.data);
      }
    }
  }

  // Compute fused score for each candidate
  const results: FusionResult[] = [];

  for (const [id, data] of allIds) {
    let score = 0;
    let debugInfo: FusionDebugInfo | undefined;

    if (debug) {
      debugInfo = {
        lexical: { rank: undefined },
        structural: { rank: undefined },
        similarity: { rank: undefined },
        identity: { rank: undefined },
        contributions: { lexical: 0, structural: 0, similarity: 0, identity: 0 },
      };
    }

    for (const ch of activeChannels) {
      const rankMap = rankMaps.get(ch)!;
      const entry = rankMap.get(id);

      if (entry !== undefined) {
        const contribution = weights[ch] * (1 / (k + entry.rank));
        score += contribution;

        if (debugInfo) {
          debugInfo[ch] = { rank: entry.rank, rawScore: entry.rawScore };
          debugInfo.contributions[ch] = contribution;
        }
      }
    }

    results.push({ id, score, data, ...(debugInfo ? { debug: debugInfo } : {}) });
  }

  // Sort descending by score
  results.sort((a, b) => b.score - a.score);

  return results;
}

/**
 * Build identity channel from a query and candidate symbols.
 * Returns candidates sorted by identity score (best first), filtering out zero-score items.
 */
export function buildIdentityChannel(
  query: string,
  candidates: Array<{ id: string; name: string; fqn?: string | null; data?: unknown }>,
): ChannelInput {
  const scored = candidates
    .map((c) => ({
      id: c.id,
      rawScore: computeIdentityScore(query, c.name, c.fqn),
      data: c.data,
    }))
    .filter((c) => c.rawScore > 0)
    .sort((a, b) => b.rawScore - a.rawScore);

  return { items: scored };
}
