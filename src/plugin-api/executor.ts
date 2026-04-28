import { ok, type TraceMcpResult } from '../errors.js';
import { logger } from '../logger.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  LanguagePlugin,
  RawEdge,
  ResolveContext,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Maximum symbols a single file extraction can return. */
const MAX_SYMBOLS_PER_FILE = 10_000;
/** Maximum edges a single framework resolution can return. */
const MAX_EDGES_PER_RESOLUTION = 50_000;
/** Maximum input file size for plugin processing (5 MB). */
const MAX_PLUGIN_INPUT_BYTES = 5 * 1024 * 1024;

export async function executeLanguagePlugin(
  plugin: LanguagePlugin,
  filePath: string,
  content: Buffer,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TraceMcpResult<FileParseResult>> {
  // Guard: reject oversized input before handing to plugin
  if (content.length > MAX_PLUGIN_INPUT_BYTES) {
    logger.warn(
      { plugin: plugin.manifest.name, file: filePath, bytes: content.length },
      'File exceeds plugin input size limit, skipping',
    );
    return ok({
      language: undefined,
      status: 'error',
      symbols: [],
      warnings: [
        `File too large for plugin (${content.length} bytes > ${MAX_PLUGIN_INPUT_BYTES} limit)`,
      ],
    });
  }

  try {
    const result = await withTimeout(
      () => plugin.extractSymbols(filePath, content),
      timeoutMs,
      `${plugin.manifest.name}.extractSymbols`,
    );

    // Guard: cap output size to prevent runaway plugins
    if (result.isOk() && result.value.symbols.length > MAX_SYMBOLS_PER_FILE) {
      logger.warn(
        {
          plugin: plugin.manifest.name,
          file: filePath,
          count: result.value.symbols.length,
          limit: MAX_SYMBOLS_PER_FILE,
        },
        'Plugin returned too many symbols, truncating',
      );
      result.value.symbols = result.value.symbols.slice(0, MAX_SYMBOLS_PER_FILE);
      result.value.warnings = [
        ...(result.value.warnings ?? []),
        `Output truncated: ${MAX_SYMBOLS_PER_FILE} symbol limit reached`,
      ];
    }

    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(
      { plugin: plugin.manifest.name, file: filePath, error: msg },
      'Language plugin error',
    );
    return ok({
      language: undefined,
      status: 'error',
      symbols: [],
      warnings: [`Plugin ${plugin.manifest.name} failed: ${msg}`],
    });
  }
}

/**
 * Synchronous fast path. `FrameworkPlugin.extractNodes` is typed as a sync
 * `TraceMcpResult` (no Promise), so awaiting it on every (file × plugin)
 * pair was buying 10k+ microtask hops per indexing run for nothing.
 * The outer extract() still sits inside an async function with its own
 * timeout/error budget, so dropping the wrapper here is safe.
 */
export function executeFrameworkExtractNodes(
  plugin: FrameworkPlugin,
  filePath: string,
  content: Buffer,
  language: string,
): TraceMcpResult<FileParseResult | null> {
  if (!plugin.extractNodes) return ok(null);

  try {
    const result = plugin.extractNodes(filePath, content, language);
    return result.map((r) => r as FileParseResult | null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(
      { plugin: plugin.manifest.name, file: filePath, error: msg },
      'Framework extractNodes error',
    );
    return ok(null);
  }
}

export async function executeFrameworkResolveEdges(
  plugin: FrameworkPlugin,
  ctx: ResolveContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TraceMcpResult<RawEdge[]>> {
  if (!plugin.resolveEdges) return ok([]);

  try {
    const result = await withTimeout(
      () => plugin.resolveEdges!(ctx),
      timeoutMs,
      `${plugin.manifest.name}.resolveEdges`,
    );

    // Guard: cap edge output to prevent runaway framework plugins
    if (result.isOk() && result.value.length > MAX_EDGES_PER_RESOLUTION) {
      logger.warn(
        {
          plugin: plugin.manifest.name,
          count: result.value.length,
          limit: MAX_EDGES_PER_RESOLUTION,
        },
        'Framework plugin returned too many edges, truncating',
      );
      return ok(result.value.slice(0, MAX_EDGES_PER_RESOLUTION));
    }

    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ plugin: plugin.manifest.name, error: msg }, 'Framework resolveEdges error');
    return ok([]);
  }
}

async function withTimeout<T>(fn: () => T, timeoutMs: number, operationName: string): Promise<T> {
  // For synchronous functions, just call directly
  const result = fn();

  if (result instanceof Promise) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timeout: ${operationName} exceeded ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return result;
}
