/**
 * AI layer interfaces — all optional, everything degrades gracefully.
 */

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions(): number;
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
