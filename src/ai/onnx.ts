/**
 * Local ONNX embedding provider — zero-config, no API keys, offline-capable.
 * Default model is all-MiniLM-L6-v2 quantized to int8 (~23 MB download vs
 * ~90 MB fp32; min cosine(q8, fp32) = 0.995 measured on code docs, 2026-09-15).
 * Falls back gracefully if the package is not installed.
 *
 * E5-family models (e.g. `Xenova/multilingual-e5-small`, the recommended
 * opt-in — see docs/perf/embedding-models.md) were contrastively trained with
 * `query:` / `passage:` prefixes. Without them retrieval quality silently
 * degrades (TRA-1539 measured R@1 0.583 bare vs 0.625 prefixed on a code
 * corpus), so the provider applies them automatically based on the
 * {@link EmbeddingTask}: `query:` for search queries, `passage:` for indexed
 * documents. Non-E5 models are unaffected — the task parameter is ignored.
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

/**
 * ORT session-arena mode (TRA-1608). `tuned` disables the memory-pattern
 * planner (`enableMemPattern: false`), which otherwise reserves a large
 * upfront chunk sized from the first batch shapes — pure overhead for an
 * embedding service whose batch/sequence shapes vary every call. The CPU
 * arena itself stays enabled, so per-op malloc churn does not regress.
 *
 * Deliberately NOT passing `arena_extend_strategy`: it is an OrtArenaCfg /
 * execution-provider option (CUDA/ROCM EPs, `CreateArenaCfg`), not a generic
 * session config entry — the JS `SessionOptions` surface has no field for it
 * and an `extra.session` entry would be silently ignored. Roll back with
 * `TRACE_MCP_ONNX_ARENA=default` (or the constructor `arena` option).
 */
export type OnnxArenaMode = 'tuned' | 'default';
const KNOWN_ARENA_MODES: ReadonlySet<string> = new Set(['tuned', 'default']);

/** Extra ORT session options, passed through as `session_options` by transformers.js. */
export type OnnxSessionOptions = Record<string, unknown>;

/**
 * True for E5-family embedding models, which require `query:` / `passage:`
 * prefixes (matched case-insensitively against the model id so both
 * `intfloat/multilingual-e5-small` and `Xenova/multilingual-e5-small` hit).
 */
export function isE5Model(model: string): boolean {
  return /e5/i.test(model);
}

/**
 * Apply the E5 prefix for an embedding task. Non-E5 models return the text
 * unchanged — callers can route every model through this unconditionally.
 */
export function applyE5Prefix(model: string, text: string, task?: EmbeddingTask): string {
  if (!isE5Model(model)) return text;
  return task === 'query' ? `query: ${text}` : `passage: ${text}`;
}

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

/** Factory seam for tests — production code always uses {@link getPipeline}. */
export type OnnxPipelineFactory = (
  model: string,
  dtype: OnnxDtype,
  sessionOptions?: OnnxSessionOptions,
) => Promise<FeatureExtractionPipeline>;

// Lazy singletons — loaded once per model+dtype+arena on first embed call
let pipelineInstance: FeatureExtractionPipeline | null = null;
let pipelineKey: string | null = null;

export function resolveOnnxArenaMode(explicit?: string): OnnxArenaMode {
  if (explicit && KNOWN_ARENA_MODES.has(explicit)) return explicit as OnnxArenaMode;
  const env = process.env.TRACE_MCP_ONNX_ARENA;
  if (env && KNOWN_ARENA_MODES.has(env)) return env as OnnxArenaMode;
  if (env) logger.warn({ env }, 'Unknown TRACE_MCP_ONNX_ARENA — falling back to tuned');
  return 'tuned';
}

/**
 * Session options for the ORT inference session behind the pipeline.
 * Returns undefined in `default` mode so transformers.js gets stock ORT
 * behaviour (the rollback path). The mode is part of the pipeline cache key
 * in {@link getPipeline}, so flipping the flag reloads the session.
 */
export function resolveOnnxSessionOptions(explicit?: string): OnnxSessionOptions | undefined {
  const mode = resolveOnnxArenaMode(explicit);
  if (mode === 'default') return undefined;
  return { enableMemPattern: false };
}

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

async function getPipeline(
  model: string,
  dtype: OnnxDtype,
  sessionOptions: OnnxSessionOptions | undefined = resolveOnnxSessionOptions(),
): Promise<FeatureExtractionPipeline> {
  const key = `${model}::${dtype}::${sessionOptions ? JSON.stringify(sessionOptions) : 'stock'}`;
  if (pipelineInstance && pipelineKey === key) return pipelineInstance;

  const transformers = await getTransformers();
  if (!transformers) throw new Error('@huggingface/transformers is not installed');

  logger.info({ model, dtype }, 'Loading ONNX embedding model (first run downloads ~23 MB)…');
  pipelineInstance = (await transformers.pipeline('feature-extraction', model, {
    dtype,
    ...(sessionOptions ? { session_options: sessionOptions } : {}),
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
    private readonly pipelineFactory: OnnxPipelineFactory = getPipeline,
    private readonly sessionOptions?: OnnxSessionOptions,
  ) {}

  async embed(text: string, task?: EmbeddingTask, signal?: AbortSignal): Promise<number[]> {
    const results = await this.embedBatch([text], task, signal);
    return results[0] ?? [];
  }

  // AbortSignal not propagated into the underlying transformers.js pipeline
  // (no public signal hook). Cooperative cancellation between the batched call
  // and the per-text fallback is the best we can do for the local ONNX path.
  async embedBatch(
    texts: string[],
    task?: EmbeddingTask,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length === 0 || signal?.aborted) return [];
    const pipe = await this.pipelineFactory(
      this.model,
      this.dtype,
      this.sessionOptions ?? resolveOnnxSessionOptions(),
    );
    // E5-family models need query:/passage: prefixes (see applyE5Prefix);
    // every other model embeds the raw text exactly as before.
    const prefixed = texts.map((t) => applyE5Prefix(this.model, t, task));

    // One tokenizer+model pass for the whole batch (padding is internal):
    // ~N model invocations collapse into one. Falls back to per-text calls
    // below if a backend can't do batches.
    try {
      const output = await pipe(prefixed, { pooling: 'mean', normalize: true });
      const rows = splitPipeOutput(output, prefixed.length);
      if (rows) return rows.map((r) => r.slice(0, this.dims));
      logger.warn('ONNX pipeline returned an unexpected shape — retrying per-text');
    } catch (err) {
      logger.warn({ err }, 'ONNX batched embed failed — retrying per-text');
    }

    const results: number[][] = [];
    for (const text of prefixed) {
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
  private readonly sessionOptions: OnnxSessionOptions | undefined;

  constructor(config?: { model?: string; dimensions?: number; dtype?: string; arena?: string }) {
    this.model = config?.model ?? DEFAULT_MODEL;
    this.dims = config?.dimensions ?? DEFAULT_DIMENSIONS;
    this.dtype = resolveOnnxDtype(config?.dtype);
    this.sessionOptions = resolveOnnxSessionOptions(config?.arena);
  }

  async isAvailable(): Promise<boolean> {
    const transformers = await getTransformers();
    return transformers !== null;
  }

  embedding(): EmbeddingService {
    return new OnnxEmbeddingService(
      this.model,
      this.dims,
      this.dtype,
      getPipeline,
      this.sessionOptions,
    );
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
