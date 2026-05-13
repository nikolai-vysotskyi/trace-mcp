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
