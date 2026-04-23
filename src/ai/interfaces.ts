/**
 * AI layer interfaces — all optional, everything degrades gracefully.
 */

/**
 * Hint for providers that produce different embeddings for indexing vs retrieval
 * (Voyage `input_type`, Vertex `task_type`). Providers that don't distinguish
 * ignore this parameter. Default: `'document'` (indexing path) — callers
 * embedding a search query MUST pass `'query'` to get optimal retrieval quality.
 */
export type EmbeddingTask = 'document' | 'query';

export interface EmbeddingService {
  embed(text: string, task?: EmbeddingTask): Promise<number[]>;
  embedBatch(texts: string[], task?: EmbeddingTask): Promise<number[][]>;
  dimensions(): number;
  /** Identifier of the embedding model in use (empty for no-op/fallback). */
  modelName(): string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface InferenceService {
  generate(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string>;
  generateStream?(
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number },
  ): AsyncIterable<string>;
}

export interface VectorStore {
  insert(id: number, vector: number[]): void;
  search(query: number[], limit: number): { id: number; score: number }[];
  delete(id: number): void;
  /** Wipe all vectors. Used when the embedding space changes. */
  clear(): void;
  /** Stamp the producing model + dimensionality for the current vectors. */
  setMeta(model: string, dim: number): void;
  /** Returns the stamped meta, or null if vectors have never been written. */
  getMeta(): { model: string; dim: number } | null;
}

export interface RerankerService {
  rerank(query: string, documents: { id: number; text: string }[], topK: number): Promise<{ id: number; score: number }[]>;
}

export interface AIProvider {
  isAvailable(): Promise<boolean>;
  embedding(): EmbeddingService;
  inference(): InferenceService;
  fastInference(): InferenceService;
}
