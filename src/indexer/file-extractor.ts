/**
 * FileExtractor: handles the extract phase of the indexing pipeline.
 * Reads a file from disk, validates it, parses it with language/framework plugins,
 * and computes complexity metrics. Pure computation — no DB writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { ProjectContext, FileParseResult, RawEdge } from '../plugin-api/types.js';
import { ok } from '../errors.js';
import { executeLanguagePlugin, executeFrameworkExtractNodes } from '../plugin-api/executor.js';
import { buildProjectContext } from './project-context.js';
import { hashContent } from '../utils/hasher.js';
import { validatePath, validateFileSize, isSensitiveFile, isBinaryBuffer } from '../utils/security.js';
import { logger } from '../logger.js';
import { computeComplexity } from '../tools/analysis/complexity.js';
import type { GitignoreMatcher } from '../utils/gitignore.js';
import type { WorkspaceInfo } from './monorepo.js';
import type { FileExtraction } from './pipeline-state.js';

interface ExtractorContext {
  store: Store;
  registry: PluginRegistry;
  rootPath: string;
  workspaces: WorkspaceInfo[];
  gitignore: GitignoreMatcher | undefined;
  fileContentCache: Map<string, string>;
  buildProjectContext: () => ProjectContext;
}

export class FileExtractor {
  constructor(private ctx: ExtractorContext) {}

  async extract(relPath: string, force: boolean): Promise<FileExtraction | 'skipped' | 'error'> {
    const { store, registry, rootPath } = this.ctx;
    const absPath = path.resolve(rootPath, relPath);

    // Defence-in-depth: reject paths that escape the project root
    const pathCheck = validatePath(relPath, rootPath);
    if (pathCheck.isErr()) {
      logger.warn({ file: relPath }, 'Path traversal blocked');
      return 'error';
    }

    // Reject symlinks to prevent escaping the project root
    let fileMtimeMs: number | null = null;
    try {
      const stat = fs.lstatSync(absPath);
      if (stat.isSymbolicLink()) {
        logger.warn({ file: relPath }, 'Symlink skipped');
        return 'error';
      }
      fileMtimeMs = stat.mtimeMs;
    } catch {
      // lstat failed — file may not exist; readFileSync below will catch it
    }

    // Block sensitive files (credentials, keys, secrets) from indexing
    if (isSensitiveFile(relPath)) {
      logger.warn({ file: relPath }, 'Sensitive file blocked from indexing');
      return 'skipped';
    }

    // Single DB lookup — reused for both mtime fast-path and hash-change check
    const existing = store.getFile(relPath);

    // mtime fast-path: if mtime hasn't changed, the file content is identical —
    // skip the expensive read + hash computation entirely.
    if (!force && fileMtimeMs != null && existing
        && existing.mtime_ms != null && existing.mtime_ms === Math.floor(fileMtimeMs)) {
      return 'skipped';
    }

    let content: Buffer;
    try {
      content = fs.readFileSync(absPath);
    } catch {
      logger.warn({ file: relPath }, 'Cannot read file');
      return 'error';
    }

    // Reject binary files (null-byte in first 8 KB)
    if (isBinaryBuffer(content)) {
      logger.warn({ file: relPath }, 'Binary file detected, skipping');
      return 'skipped';
    }

    // Reject oversized files (default 1 MB) to prevent OOM
    const sizeCheck = validateFileSize(content.length);
    if (sizeCheck.isErr()) {
      logger.warn({ file: relPath, size: content.length }, 'File too large, skipping');
      return 'error';
    }

    // Cache content for Pass 2 (resolveEdges reads files again)
    const contentStr = content.toString('utf-8');
    this.ctx.fileContentCache.set(relPath, contentStr);

    const hash = hashContent(content);

    // Skip if unchanged
    if (!force && existing && existing.content_hash === hash) {
      return 'skipped';
    }

    // Find matching language plugin
    const plugin = registry.getLanguagePluginForFile(relPath);
    if (!plugin) {
      return 'skipped';
    }

    // Execute language plugin
    const parseResult = await executeLanguagePlugin(plugin, relPath, content);
    if (parseResult.isErr()) {
      logger.error({ file: relPath, error: parseResult.error }, 'Language plugin failed');
      return 'error';
    }

    const parsed = parseResult.value;
    const language = parsed.language ?? this.detectLanguage(relPath);
    const workspace = this.resolveWorkspace(relPath);

    // Compute complexity metrics and attach to symbol metadata.
    this.computeSymbolMetrics(parsed.symbols, contentStr, language);

    // Separate import edges from other edges
    const otherEdges: RawEdge[] = [];
    const importEdges: { from: string; specifiers: string[]; relPath: string }[] = [];
    if (parsed.edges?.length) {
      for (const edge of parsed.edges) {
        if (edge.edgeType === 'imports' && !edge.sourceNodeType && !edge.sourceSymbolId) {
          importEdges.push({
            from: (edge.metadata as Record<string, unknown>)?.['from'] as string ?? '',
            specifiers: ((edge.metadata as Record<string, unknown>)?.['specifiers'] as string[]) ?? [],
            relPath,
          });
        } else {
          otherEdges.push(edge);
        }
      }
    }

    // Collect framework extract results (no DB writes)
    const frameworkExtracts = await this.collectFrameworkExtracts(relPath, content, language);

    return {
      relPath,
      existingId: existing?.id ?? null,
      hash,
      contentSize: content.length,
      language,
      workspace,
      gitignored: this.ctx.gitignore?.isIgnored(relPath) ?? false,
      status: parsed.status,
      frameworkRole: parsed.frameworkRole,
      mtimeMs: fileMtimeMs != null ? Math.floor(fileMtimeMs) : null,
      symbols: parsed.symbols,
      otherEdges,
      importEdges,
      routes: parsed.routes ?? [],
      components: parsed.components ?? [],
      migrations: parsed.migrations ?? [],
      ormModels: parsed.ormModels ?? [],
      ormAssociations: parsed.ormAssociations ?? [],
      rnScreens: parsed.rnScreens ?? [],
      frameworkExtracts,
    };
  }

  private computeSymbolMetrics(
    symbols: FileExtraction['symbols'],
    contentStr: string,
    language: string,
  ): void {
    for (const sym of symbols) {
      if (sym.kind === 'function' || sym.kind === 'method' || sym.kind === 'class') {
        const lines = (sym.lineEnd ?? sym.lineStart ?? 0) - (sym.lineStart ?? 0);
        if (lines <= 2) {
          sym.metadata = {
            ...(sym.metadata ?? {}),
            cyclomatic: 1,
            max_nesting: 0,
            param_count: sym.signature ? computeComplexity('', sym.signature, language).param_count : 0,
          };
          continue;
        }
        const source = contentStr.slice(sym.byteStart, sym.byteEnd);
        const metrics = computeComplexity(source, sym.signature, language);
        sym.metadata = {
          ...(sym.metadata ?? {}),
          cyclomatic: metrics.cyclomatic,
          max_nesting: metrics.max_nesting,
          param_count: metrics.param_count,
        };
      }
    }
  }

  private async collectFrameworkExtracts(
    relPath: string,
    content: Buffer,
    language: string,
  ): Promise<FileParseResult[]> {
    // Use per-workspace ProjectContext when the file belongs to a workspace.
    // This allows framework detection (e.g. LaravelPlugin) to find the correct
    // composer.json/package.json in the workspace root, not just the top-level root.
    let ctx = this.ctx.buildProjectContext();
    let activeResult = this.ctx.registry.getActiveFrameworkPlugins(ctx);

    if (activeResult.isOk() && activeResult.value.length === 0 && this.ctx.workspaces.length > 0) {
      const ws = this.resolveWorkspace(relPath);
      if (ws) {
        const wsRoot = path.join(this.ctx.rootPath, ws);
        const wsCtx = buildProjectContext(wsRoot);
        // Don't use the cache — get fresh plugins for this workspace context
        const wsPlugins = this.ctx.registry.getAllFrameworkPlugins().filter((p) => p.detect(wsCtx));
        if (wsPlugins.length > 0) {
          activeResult = ok(wsPlugins);
        }
      }
    }

    if (activeResult.isErr()) return [];

    const results: FileParseResult[] = [];
    for (const plugin of activeResult.value) {
      if (!plugin.extractNodes) continue;
      const result = await executeFrameworkExtractNodes(plugin, relPath, content, language);
      if (result.isErr() || !result.value) continue;
      results.push(result.value);
    }
    return results;
  }

  private resolveWorkspace(relPath: string): string | null {
    for (const ws of this.ctx.workspaces) {
      if (relPath.startsWith(ws.path + '/') || relPath === ws.path) {
        return ws.name;
      }
    }
    return null;
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).slice(1);
    const map: Record<string, string> = {
      php: 'php', ts: 'typescript', tsx: 'typescript',
      js: 'javascript', jsx: 'javascript', mjs: 'javascript', mts: 'typescript',
      vue: 'vue',
    };
    return map[ext] ?? ext;
  }
}
