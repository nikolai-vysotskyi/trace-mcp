/**
 * In-memory retriever registry. One instance per consumer — no global
 * singleton. See `types.ts` for the rationale.
 */
import type { BaseRetriever, RetrieverRegistry } from './types.js';

/** Default `RetrieverRegistry` implementation. Map-backed, sync. */
export class InMemoryRetrieverRegistry implements RetrieverRegistry {
  private readonly retrievers = new Map<string, BaseRetriever<unknown, unknown>>();

  register(retriever: BaseRetriever<unknown, unknown>): void {
    const name = retriever.name;
    if (!name) {
      throw new Error('Retriever must have a non-empty `name`');
    }
    if (this.retrievers.has(name)) {
      throw new Error(`Retriever "${name}" is already registered`);
    }
    this.retrievers.set(name, retriever);
  }

  get(name: string): BaseRetriever<unknown, unknown> | undefined {
    return this.retrievers.get(name);
  }

  list(): string[] {
    return [...this.retrievers.keys()].sort();
  }
}

/** Construct a fresh registry. Equivalent to `new InMemoryRetrieverRegistry()`. */
export function createRetrieverRegistry(): RetrieverRegistry {
  return new InMemoryRetrieverRegistry();
}
