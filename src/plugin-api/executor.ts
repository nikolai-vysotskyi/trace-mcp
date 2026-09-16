import { ok, type TraceMcpResult } from '../errors.js';
import { logger } from '../logger.js';
import type {
  ExtractSymbolsOptions,
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
  opts?: ExtractSymbolsOptions,
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
      () => plugin.extractSymbols(filePath, content, opts),
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
 * Awaits the plugin if it returned a Promise, otherwise returns the sync
 * `TraceMcpResult` directly. Most framework plugins are sync (regex only) —
 * the few that need async parser init (e.g. tree-sitter via getParser) hit
 * the await branch. The outer extract() is already async so adding this
 * here costs nothing for sync plugins.
 *
 * `content` is forwarded as-is: `FileExtractor` (TRA-1537) decodes once per
 * file and passes the shared `string`, so per-plugin `content.toString()`
 * re-decodes drop to zero. Plugins still declaring `content: Buffer` keep
 * working — `String.prototype.toString()` returns the same string.
 *
 * Lightweight per-plugin timing (§3 of TRA-1537): accumulates calls/totalMs/
 * emptyHits keyed by manifest name. Overhead is one `performance.now()` pair
 * per call; read via `getFrameworkExtractStats()` or dump with
 * `TRACE_MCP_PROFILE_PLUGINS=1` at the end of indexing.
 *
 * Scope note (review TRA-1537): the map is per-process. Worker threads run
 * their own `FileExtractor` and accumulate their own copy — the end-of-run
 * dump in `extract-and-persist.ts` reports main-thread (in-process) extracts
 * only. With an active worker pool the dump is partial by design; use it for
 * weak-machine triage of the in-process path, not as a global census.
 */
export interface FrameworkExtractStat {
  calls: number;
  totalMs: number;
  emptyHits: number;
}

const frameworkExtractStats = new Map<string, FrameworkExtractStat>();

export function getFrameworkExtractStats(): ReadonlyMap<string, FrameworkExtractStat> {
  return frameworkExtractStats;
}

export function resetFrameworkExtractStats(): void {
  frameworkExtractStats.clear();
}

export function logFrameworkExtractStats(): void {
  if (frameworkExtractStats.size === 0) return;
  const rows = [...frameworkExtractStats.entries()]
    .map(([name, s]) => ({ name, ...s, avgMs: s.calls > 0 ? s.totalMs / s.calls : 0 }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const lines = rows.map(
    (r) =>
      `  ${r.name}: calls=${r.calls} totalMs=${r.totalMs.toFixed(1)} avgMs=${r.avgMs.toFixed(3)} empty=${r.emptyHits}`,
  );
  logger.info({ count: rows.length }, `Framework extract profile:\n${lines.join('\n')}`);
}

export async function executeFrameworkExtractNodes(
  plugin: FrameworkPlugin,
  filePath: string,
  content: Buffer | string,
  language: string,
): Promise<TraceMcpResult<FileParseResult | null>> {
  if (!plugin.extractNodes) return ok(null);

  const name = plugin.manifest.name;
  const start = performance.now();
  try {
    // Plugins declare `content: Buffer`; the shared-string fast path passes a
    // real `string` cast to Buffer. Runtime-identical (`toString()` is a
    // no-op on strings), zero re-decodes, zero per-plugin edits.
    const maybe = plugin.extractNodes(filePath, content as Buffer, language);
    const result = maybe instanceof Promise ? await maybe : maybe;
    const mapped = result.map((r) => r as FileParseResult | null);
    const elapsed = performance.now() - start;
    let stat = frameworkExtractStats.get(name);
    if (!stat) {
      stat = { calls: 0, totalMs: 0, emptyHits: 0 };
      frameworkExtractStats.set(name, stat);
    }
    stat.calls++;
    stat.totalMs += elapsed;
    if (mapped.isOk() && !mapped.value) stat.emptyHits++;
    return mapped;
  } catch (e) {
    const elapsed = performance.now() - start;
    let stat = frameworkExtractStats.get(name);
    if (!stat) {
      stat = { calls: 0, totalMs: 0, emptyHits: 0 };
      frameworkExtractStats.set(name, stat);
    }
    stat.calls++;
    stat.totalMs += elapsed;
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
