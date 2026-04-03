import type { LanguagePlugin, FrameworkPlugin, FileParseResult, RawEdge, ResolveContext } from './types.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { pluginError, parseError } from '../errors.js';
import { logger } from '../logger.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export async function executeLanguagePlugin(
  plugin: LanguagePlugin,
  filePath: string,
  content: Buffer,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TraceMcpResult<FileParseResult>> {
  try {
    const result = await withTimeout(
      () => plugin.extractSymbols(filePath, content),
      timeoutMs,
      `${plugin.manifest.name}.extractSymbols`,
    );
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ plugin: plugin.manifest.name, file: filePath, error: msg }, 'Language plugin error');
    return ok({
      language: undefined,
      status: 'error',
      symbols: [],
      warnings: [`Plugin ${plugin.manifest.name} failed: ${msg}`],
    });
  }
}

export async function executeFrameworkExtractNodes(
  plugin: FrameworkPlugin,
  filePath: string,
  content: Buffer,
  language: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TraceMcpResult<FileParseResult | null>> {
  if (!plugin.extractNodes) return ok(null);

  try {
    const result = await withTimeout(
      () => plugin.extractNodes!(filePath, content, language),
      timeoutMs,
      `${plugin.manifest.name}.extractNodes`,
    );
    return result.map((r) => r as FileParseResult | null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ plugin: plugin.manifest.name, file: filePath, error: msg }, 'Framework extractNodes error');
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
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ plugin: plugin.manifest.name, error: msg }, 'Framework resolveEdges error');
    return ok([]);
  }
}

async function withTimeout<T>(
  fn: () => T,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  // For synchronous functions, just call directly
  const result = fn();

  if (result instanceof Promise) {
    return Promise.race([
      result,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timeout: ${operationName} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  return result;
}
