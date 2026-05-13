/**
 * Search-mode registry (plan P03).
 *
 * Maps a stable `mode_name` (string) to a `BaseRetriever` instance.
 * This is the dispatch surface for the new `search_with_mode` MCP tool.
 *
 * ## Bundled modes (6)
 *
 * | Mode              | Composition                                    |
 * |-------------------|------------------------------------------------|
 * | `lexical`         | LexicalRetriever (P01)                         |
 * | `semantic`        | SemanticRetriever (P01)                        |
 * | `hybrid`          | Lexical + Semantic via RRF                     |
 * | `summary`         | Lexical, augmented with symbols.summary text   |
 * | `feeling_lucky`   | Auto-router: symbol-shape → lexical, else hybrid|
 * | `graph_completion`| Lexical seeds expanded by 1-hop graph walk     |
 *
 * Pure composition over P01 adapters — no new search algorithms. Existing
 * `search` MCP tool stays unchanged; this is an additive surface.
 */
import type { Store } from '../../db/store.js';
import type { EmbeddingService, VectorStore } from '../../ai/interfaces.js';
import type { BaseRetriever } from '../types.js';
import { createLexicalRetriever } from '../retrievers/lexical-retriever.js';
import { createSemanticRetriever } from '../retrievers/semantic-retriever.js';
import { createHybridRetriever } from '../retrievers/hybrid-retriever.js';
import { createSummaryRetriever } from '../retrievers/summary-retriever.js';
import { createFeelingLuckyRetriever } from '../retrievers/feeling-lucky-retriever.js';
import { createGraphCompletionRetriever } from '../retrievers/graph-completion-retriever.js';

export const SEARCH_MODE_NAMES = [
  'lexical',
  'semantic',
  'hybrid',
  'summary',
  'feeling_lucky',
  'graph_completion',
] as const;

export type SearchModeName = (typeof SEARCH_MODE_NAMES)[number];

/** Map-backed registry. One instance per `ServerContext`, no global. */
export class SearchModeRegistry {
  private readonly modes = new Map<string, BaseRetriever<unknown, unknown>>();

  register(name: string, retriever: BaseRetriever<unknown, unknown>): void {
    if (!name) {
      throw new Error('Search mode must have a non-empty name');
    }
    if (this.modes.has(name)) {
      throw new Error(`Search mode "${name}" is already registered`);
    }
    this.modes.set(name, retriever);
  }

  getMode(name: string): BaseRetriever<unknown, unknown> | undefined {
    return this.modes.get(name);
  }

  listModes(): string[] {
    return [...this.modes.keys()].sort();
  }
}

/**
 * Build the standard 5-mode registry using the supplied dependencies.
 *
 * `embedding`/`vectorStore` may be `null` when no AI provider is configured;
 * the `semantic` and `hybrid` modes still register but degrade to `[]` /
 * lexical-only respectively (matches trace-mcp's existing soft-degradation).
 */
export function createDefaultSearchModeRegistry(deps: {
  store: Store;
  embedding: EmbeddingService | null;
  vectorStore: VectorStore | null;
}): SearchModeRegistry {
  const registry = new SearchModeRegistry();

  const lexical = createLexicalRetriever(deps.store);
  const semantic = createSemanticRetriever(deps.embedding, deps.vectorStore);
  const hybrid = createHybridRetriever(
    lexical,
    deps.embedding && deps.vectorStore ? semantic : null,
  );
  const summary = createSummaryRetriever(lexical, deps.store);
  const feelingLucky = createFeelingLuckyRetriever(lexical, hybrid);
  const graphCompletion = createGraphCompletionRetriever(deps.store);

  registry.register('lexical', lexical as unknown as BaseRetriever<unknown, unknown>);
  registry.register('semantic', semantic as unknown as BaseRetriever<unknown, unknown>);
  registry.register('hybrid', hybrid as unknown as BaseRetriever<unknown, unknown>);
  registry.register('summary', summary as unknown as BaseRetriever<unknown, unknown>);
  registry.register('feeling_lucky', feelingLucky as unknown as BaseRetriever<unknown, unknown>);
  registry.register(
    'graph_completion',
    graphCompletion as unknown as BaseRetriever<unknown, unknown>,
  );

  return registry;
}
