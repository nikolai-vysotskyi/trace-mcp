import { estimateTokens } from '../utils/token-counter.js';

export interface ContextItem {
  id: string;
  score: number;
  /** Full source code of the symbol */
  source?: string;
  /** Just the signature */
  signature?: string;
  /** Metadata line (kind, fqn, file, etc.) */
  metadata: string;
}

export type DetailLevel = 'full' | 'no_source' | 'signature_only';

export interface AssembledItem {
  id: string;
  score: number;
  detail: DetailLevel;
  content: string;
  tokens: number;
}

interface AssembledContext {
  items: AssembledItem[];
  totalTokens: number;
  truncated: boolean;
}

/**
 * Greedy context assembly within a token budget.
 *
 * Items are sorted by score descending. For each item, we try:
 *   1. full (source + metadata)
 *   2. no_source (signature + metadata)
 *   3. signature_only (just signature)
 * We pick the highest detail level that fits the remaining budget.
 */
export function assembleContext(items: ContextItem[], tokenBudget: number): AssembledContext {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const result: AssembledItem[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const item of sorted) {
    const remaining = tokenBudget - totalTokens;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const assembled = tryAssemble(item, remaining);
    if (assembled) {
      result.push(assembled);
      totalTokens += assembled.tokens;
    } else {
      truncated = true;
    }
  }

  return { items: result, totalTokens, truncated };
}

function tryAssemble(item: ContextItem, remainingTokens: number): AssembledItem | null {
  // Try full
  if (item.source) {
    const content = `${item.metadata}\n${item.source}`;
    const tokens = estimateTokens(content);
    if (tokens <= remainingTokens) {
      return { id: item.id, score: item.score, detail: 'full', content, tokens };
    }
  }

  // Try no_source (signature + metadata)
  if (item.signature) {
    // TRA-1144: when a body existed and the budget refused it, say so. A bare
    // signature reads like the whole answer — `module tests/test_requests.py`
    // was the entire context served for a 30,000-token file — and nothing in
    // the payload distinguished that from a symbol which genuinely has no body.
    const omitted = item.source
      ? `\n[body omitted — ${estimateTokens(item.source)} tokens, over this section's budget]`
      : '';
    const content = `${item.metadata}\n${item.signature}${omitted}`;
    const tokens = estimateTokens(content);
    if (tokens <= remainingTokens) {
      return { id: item.id, score: item.score, detail: 'no_source', content, tokens };
    }
  }

  // Try signature_only
  if (item.signature) {
    const tokens = estimateTokens(item.signature);
    if (tokens <= remainingTokens) {
      return {
        id: item.id,
        score: item.score,
        detail: 'signature_only',
        content: item.signature,
        tokens,
      };
    }
  }

  return null;
}
