/**
 * Local ONNX embedding provider — zero-config, no API keys, offline-capable.
 * Uses @huggingface/transformers (optional dep) with all-MiniLM-L6-v2 (~23 MB).
 * Falls back gracefully if the package is not installed.
 */
import type { AIProvider, EmbeddingService, InferenceService } from './interfaces.js';
import { FallbackProvider } from './fallback.js';
import { logger } from '../logger.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;

// Lazy singleton — loaded once on first embed call
let pipelineInstance: any = null;
let pipelineModel: string | null = null;

async function getTransformers(): Promise<typeof import('@huggingface/transformers') | null> {
  try {
    return await import('@huggingface/transformers');
  } catch {
    return null;
  }
}

async function getPipeline(model: string): Promise<any> {
  if (pipelineInstance && pipelineModel === model) return pipelineInstance;

  const transformers = await getTransformers();
  if (!transformers) throw new Error('@huggingface/transformers is not installed');

  logger.info({ model }, 'Loading ONNX embedding model (first run downloads ~23 MB)…');
  pipelineInstance = await transformers.pipeline('feature-extraction', model, {
    dtype: 'fp32',
  });
  pipelineModel = model;
  logger.info({ model }, 'ONNX embedding model loaded');
  return pipelineInstance;
}

class OnnxEmbeddingService implements EmbeddingService {
  constructor(
    private readonly model: string,
    private readonly dims: number,
  ) {}

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const pipe = await getPipeline(this.model);
    const results: number[][] = [];

    for (const text of texts) {
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      results.push(Array.from(output.data as Float32Array).slice(0, this.dims));
    }

    return results;
  }

  dimensions(): number {
    return this.dims;
  }

  modelName(): string {
    return this.model;
  }
}

/**
 * ONNX provider — embedding-only (inference falls back to no-op).
 * For full inference + embedding, combine with ollama/openai provider.
 */
export class OnnxProvider implements AIProvider {
  private readonly model: string;
  private readonly dims: number;

  constructor(config?: { model?: string; dimensions?: number }) {
    this.model = config?.model ?? DEFAULT_MODEL;
    this.dims = config?.dimensions ?? DEFAULT_DIMENSIONS;
  }

  async isAvailable(): Promise<boolean> {
    const transformers = await getTransformers();
    return transformers !== null;
  }

  embedding(): EmbeddingService {
    return new OnnxEmbeddingService(this.model, this.dims);
  }

  inference(): InferenceService {
    // ONNX provider is embedding-only — return fallback for inference
    return new FallbackProvider().inference();
  }

  fastInference(): InferenceService {
    return new FallbackProvider().fastInference();
  }
}

/** Check if @huggingface/transformers is importable without loading a model. */
export async function isOnnxAvailable(): Promise<boolean> {
  return (await getTransformers()) !== null;
}
