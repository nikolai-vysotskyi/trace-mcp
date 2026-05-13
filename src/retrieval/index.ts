/**
 * Public barrel for the retrieval protocol.
 *
 * Consumers (future tool handlers, the eval harness, P03 search-mode
 * dispatchers) should import from here, NOT from internal files. This
 * keeps the public surface narrow and lets us reshuffle internals
 * without breaking call sites.
 */
export type {
  BaseRetriever,
  RetrievedItem,
  RetrieverContext,
  RetrieverRegistry,
} from './types.js';
export { runRetriever } from './types.js';
export { InMemoryRetrieverRegistry, createRetrieverRegistry } from './registry.js';

export {
  LexicalRetriever,
  createLexicalRetriever,
} from './retrievers/lexical-retriever.js';
export type { LexicalQuery, LexicalResult } from './retrievers/lexical-retriever.js';

export {
  SemanticRetriever,
  createSemanticRetriever,
} from './retrievers/semantic-retriever.js';
export type {
  SemanticHit,
  SemanticQuery,
  SemanticResult,
} from './retrievers/semantic-retriever.js';

// P03 — named-mode retrievers (composition over P01 adapters).
export {
  HybridRetriever,
  createHybridRetriever,
  fuseRrf,
} from './retrievers/hybrid-retriever.js';
export type { HybridQuery, HybridResult, HybridHit } from './retrievers/hybrid-retriever.js';

export {
  SummaryRetriever,
  createSummaryRetriever,
} from './retrievers/summary-retriever.js';
export type { SummaryQuery, SummaryResult, SummaryHit } from './retrievers/summary-retriever.js';

export {
  FeelingLuckyRetriever,
  createFeelingLuckyRetriever,
  classifyQuery,
} from './retrievers/feeling-lucky-retriever.js';
export type {
  FeelingLuckyQuery,
  FeelingLuckyResult,
  FeelingLuckyHit,
} from './retrievers/feeling-lucky-retriever.js';

// P03 — search-mode registry (dispatch surface for `search_with_mode`).
export {
  SearchModeRegistry,
  SEARCH_MODE_NAMES,
  createDefaultSearchModeRegistry,
} from './modes/registry.js';
export type { SearchModeName } from './modes/registry.js';
