/**
 * Local ONNX embedding provider — zero-config, no API keys, offline-capable.
 * Uses @huggingface/transformers (optional dep) with all-MiniLM-L6-v2 quantized
 * to int8 (~23 MB download vs ~90 MB fp32; min cosine(q8, fp32) = 0.995 measured
 * on code docs, 2026-09-15). Falls back gracefully if the package is not installed.
 */

import { logger } from '../logger.js';
import { FallbackProvider } from './fallback.js';
import type {
  AIProvider,
  EmbeddingService,
  EmbeddingTask,
  InferenceService,
} from './interfaces.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;
/**
 * q8 is also the transformers.js default for the WASM (CPU) backend — we used
 * to force fp32 explicitly, paying ~4x model size/load for no measurable
 * retrieval gain. Roll back with `TRACE_MCP_ONNX_DTYPE=fp32` (or the
 * constructor `dtype` option) if a quantized build ever misbehaves.
 */
const DEFAULT_DTYPE = 'q8';
/** Rollback knob: env override, validated against the dtypes transformers.js knows. */
const KNOWN_DTYPES = new Set(['fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'q4f16', 'bnb4']);

/** Quantization levels accepted by transformers.js `pipeline(..., { dtype })`. */
export type OnnxDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'q4f16' | 'bnb4';

type Transformers = typeof import('@huggingface/transformers');
/**
 * Raw pipeline output: transformers.js returns ONE Tensor for both single and
 * batched inputs (batched along dim 0 → dims [N, hidden], row-major `.data`).
 * Older mocks/shims may return an array of per-text outputs or a bare
 * `{ data }` — all three shapes are handled by {@link splitPipeOutput}.
 */
type PipeOutput = { data: ArrayLike<number>; dims?: readonly number[] };
type FeatureExtractionPipeline = (
  text: string | string[],
  options?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
) => Promise<PipeOutput | PipeOutput[]>;

// Lazy singletons — loaded once per model+dtype on first embed call
let pipelineInstance: FeatureExtractionPipeline | null = null;
let pipelineKey: string | null = null;

export function resolveOnnxDtype(explicit?: string): OnnxDtype {
  if (explicit && KNOWN_DTYPES.has(explicit)) return explicit as OnnxDtype;
  const env = process.env.TRACE_MCP_ONNX_DTYPE;
  if (env && KNOWN_DTYPES.has(env)) return env as OnnxDtype;
  if (env) logger.warn({ env }, 'Unknown TRACE_MCP_ONNX_DTYPE — falling back to q8');
  return DEFAULT_DTYPE;
}

async function getTransformers(): Promise<Transformers | null> {
  try {
    return await import('@huggingface/transformers');
  } catch {
    return null;
  }
}

async function getPipeline(model: string, dtype: OnnxDtype): Promise<FeatureExtractionPipeline> {
  const key = `${model}::${dtype}`;
  if (pipelineInstance && pipelineKey === key) return pipelineInstance;

  const transformers = await getTransformers();
  if (!transformers) throw new Error('@huggingface/transformers is not installed');

  logger.info({ model, dtype }, 'Loading ONNX embedding model (first run downloads ~23 MB)…');
  pipelineInstance = (await transformers.pipeline('feature-extraction', model, {
    dtype,
  })) as unknown as FeatureExtractionPipeline;
  pipelineKey = key;
  logger.info({ model, dtype }, 'ONNX embedding model loaded');
  return pipelineInstance;
}

/**
 * Split a pipeline result into one row per input text. Handles the real
 * Tensor shape (`dims: [N, D]`, row-major data), an array of per-text outputs,
 * and a bare `{ data }` for the single-text case.
 * Returns null when the shape doesn't match — caller falls back to per-text calls.
 */
function splitPipeOutput(output: PipeOutput | PipeOutput[], count: number): number[][] | null {
  if (Array.isArray(output)) {
    if (output.length !== count) return null;
    return output.map((r) => Array.from(r.data));
  }
  const flat = Array.from(output.data);
  const dims = output.dims;
  if (dims && dims.length === 2 && dims[0] === count) {
    const width = dims[1]!;
    if (flat.length !== count * width) return null;
    const out: number[][] = [];
    for (let i = 0; i < count; i++) out.push(flat.slice(i * width, (i + 1) * width));
    return out;
  }
  if (count === 1) return [flat];
  return null;
}

class OnnxEmbeddingService implements EmbeddingService {
  constructor(
    private readonly model: string,
    private readonly dims: number,
    private readonly dtype: OnnxDtype,
  ) {}

  async embed(text: string, _task?: EmbeddingTask, signal?: AbortSignal): Promise<number[]> {
    const results = await this.embedBatch([text], undefined, signal);
    return results[0] ?? [];
  }

  // AbortSignal not propagated into the underlying transformers.js pipeline
  // (no public signal hook). Cooperative cancellation between the batched call
  // and the per-text fallback is the best we can do for the local ONNX path.
  async embedBatch(
    texts: string[],
    _task?: EmbeddingTask,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length === 0 || signal?.aborted) return [];
    const pipe = await getPipeline(this.model, this.dtype);

    // One tokenizer+model pass for the whole batch (padding is internal):
    // ~N model invocations collapse into one. Falls back to per-text calls
    // below if a backend can't do batches.
    try {
      const output = await pipe(texts, { pooling: 'mean', normalize: true });
      const rows = splitPipeOutput(output, texts.length);
      if (rows) return rows.map((r) => r.slice(0, this.dims));
      logger.warn('ONNX pipeline returned an unexpected shape — retrying per-text');
    } catch (err) {
      logger.warn({ err }, 'ONNX batched embed failed — retrying per-text');
    }

    const results: number[][] = [];
    for (const text of texts) {
      if (signal?.aborted) break;
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      const rows = splitPipeOutput(output, 1);
      results.push((rows?.[0] ?? []).slice(0, this.dims));
    }

    return results;
  }

  dimensions(): number {
    return this.dims;
  }

  modelName(): string {
    return this.model;
  }

  providerName(): string {
    return 'onnx';
  }
}

/**
 * ONNX provider — embedding-only (inference falls back to no-op).
 * For full inference + embedding, combine with ollama/openai provider.
 */
export class OnnxProvider implements AIProvider {
  private readonly model: string;
  private readonly dims: number;
  private readonly dtype: OnnxDtype;

  constructor(config?: { model?: string; dimensions?: number; dtype?: string }) {
    this.model = config?.model ?? DEFAULT_MODEL;
    this.dims = config?.dimensions ?? DEFAULT_DIMENSIONS;
    this.dtype = resolveOnnxDtype(config?.dtype);
  }

  async isAvailable(): Promise<boolean> {
    const transformers = await getTransformers();
    return transformers !== null;
  }

  embedding(): EmbeddingService {
    return new OnnxEmbeddingService(this.model, this.dims, this.dtype);
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
