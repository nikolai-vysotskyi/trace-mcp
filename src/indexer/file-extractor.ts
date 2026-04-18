/**
 * FileExtractor: handles the extract phase of the indexing pipeline.
 * Reads a file from disk, validates it, parses it with language/framework plugins,
 * and computes complexity metrics. Pure computation — no DB writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { ProjectContext, FileParseResult, RawEdge, FrameworkPlugin } from '../plugin-api/types.js';
import { executeLanguagePlugin, executeFrameworkExtractNodes } from '../plugin-api/executor.js';
import { buildProjectContext } from './project-context.js';
import { hashContent } from '../utils/hasher.js';
import { validatePath, validateFileSize, isSensitiveFile, isBinaryBuffer } from '../utils/security.js';
import { logger } from '../logger.js';
import { computeComplexity } from '../tools/analysis/complexity.js';
import type { GitignoreMatcher } from '../utils/gitignore.js';
import type { WorkspaceInfo } from './monorepo.js';
import type { FileExtraction } from './pipeline-state.js';
import type { FileRow } from '../db/types.js';


interface ExtractorContext {
  /**
   * Optional store. Only used as a fallback when `existingFiles` does not
   * already contain the row for the file being extracted. Workers run with
   * no store and supply `existing` directly via the per-call `opts`.
   */
  store?: Store;
  registry: PluginRegistry;
  rootPath: string;
  workspaces: WorkspaceInfo[];
  gitignore: GitignoreMatcher | undefined;
  fileContentCache: Map<string, string>;
  buildProjectContext: () => ProjectContext;
  /**
   * Pre-loaded existing file rows for the current pipeline run, indexed by
   * relative path. Lets `extract()` skip the per-file `store.getFile()` lookup
   * (which is the dominant DB hit during incremental reindex of a large set).
   */
  existingFiles?: Map<string, FileRow>;
}

/** Per-call inputs that override the context (used by the worker pool). */
export interface ExtractCallOptions {
  /** Pre-resolved existing FileRow (skips both the map and store lookups). */
  existing?: FileRow | null;
  /** Pre-resolved gitignore status (skips the matcher). */
  gitignored?: boolean;
}

export class FileExtractor {
  constructor(private ctx: ExtractorContext) {}

  async extract(
    relPath: string,
    force: boolean,
    opts: ExtractCallOptions = {},
  ): Promise<FileExtraction | 'skipped' | 'error'> {
    const { registry, rootPath } = this.ctx;
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

    // Existing-row lookup. Resolution order:
    //   1. caller-supplied via opts.existing (worker path)
    //   2. context preload Map (CLI path; one IN-query upfront)
    //   3. store.getFile fallback (single-row SELECT)
    const existing = opts.existing
      ?? this.ctx.existingFiles?.get(relPath)
      ?? this.ctx.store?.getFile(relPath);

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
    const workspace = this.resolveWorkspacePath(relPath);

    // Compute complexity metrics and attach to symbol metadata.
    this.computeSymbolMetrics(parsed.symbols, contentStr, language);

    // Separate import edges from other edges
    const otherEdges: RawEdge[] = [];
    const importEdges: { from: string; specifiers: string[]; relPath: string }[] = [];
    if (parsed.edges?.length) {
      for (const edge of parsed.edges) {
        // Capture both JS/TS imports and Python imports for file-level resolution
        const isImportEdge = (edge.edgeType === 'imports' || edge.edgeType === 'py_imports' || edge.edgeType === 'php_imports')
          && !edge.sourceNodeType && !edge.sourceSymbolId;
        if (isImportEdge) {
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

    // Collect framework extract results (no DB writes; entirely sync)
    const frameworkExtracts = this.collectFrameworkExtracts(relPath, content, language);

    return {
      relPath,
      existingId: existing?.id ?? null,
      hash,
      contentSize: content.length,
      language,
      workspace,
      gitignored: opts.gitignored ?? this.ctx.gitignore?.isIgnored(relPath) ?? false,
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

  /** Cache: workspace path → detected framework plugins */
  private wsPluginCache = new Map<string, FrameworkPlugin[]>();
  /** Cache: root-level active framework plugins (computed once per extractor). */
  private rootPluginCache: FrameworkPlugin[] | undefined;

  private collectFrameworkExtracts(
    relPath: string,
    content: Buffer,
    language: string,
  ): FileParseResult[] {
    // Determine which plugins to run and what path to pass.
    // In a monorepo, each workspace may have its own framework (e.g. fair-front = Nuxt,
    // fair-laravel = Laravel).  We need to:
    // 1. Detect frameworks per-workspace (not just root)
    // 2. Pass workspace-relative paths to extractNodes so path prefixes match

    let plugins: FrameworkPlugin[] = [];
    let extractPath = relPath; // path passed to extractNodes

    // Try workspace-level detection first
    const wsPath = this.resolveWorkspacePath(relPath);
    if (wsPath) {
      let cached = this.wsPluginCache.get(wsPath);
      if (cached === undefined) {
        const wsRoot = path.join(this.ctx.rootPath, wsPath);
        const wsCtx = buildProjectContext(wsRoot);
        cached = this.ctx.registry.getAllFrameworkPlugins().filter((p) => p.detect(wsCtx));
        this.wsPluginCache.set(wsPath, cached);
      }
      if (cached.length > 0) {
        plugins = cached;
        // Strip workspace prefix so NuxtPlugin sees "app/pages/index.vue" not "fair/fair-front/app/pages/index.vue"
        extractPath = relPath.slice(wsPath.length + 1);
      }
    }

    // Fallback to root-level plugins. Cached: project context + active plugin
    // list don't change mid-run, so do this work once instead of per-file.
    if (plugins.length === 0) {
      if (this.rootPluginCache === undefined) {
        const ctx = this.ctx.buildProjectContext();
        const activeResult = this.ctx.registry.getActiveFrameworkPlugins(ctx);
        this.rootPluginCache = activeResult.isOk() ? activeResult.value : [];
      }
      plugins = this.rootPluginCache;
    }

    if (plugins.length === 0) return [];

    const results: FileParseResult[] = [];
    for (const plugin of plugins) {
      if (!plugin.extractNodes) continue;
      // Synchronous — no await. `extractNodes` is typed sync and the outer
      // extract() call already provides timeout/error containment.
      const result = executeFrameworkExtractNodes(plugin, extractPath, content, language);
      if (result.isErr() || !result.value) continue;
      results.push(result.value);
    }
    return results;
  }

  /** Returns the workspace path (relative to root) that contains `relPath`, or null. */
  private resolveWorkspacePath(relPath: string): string | null {
    for (const ws of this.ctx.workspaces) {
      if (relPath.startsWith(ws.path + '/') || relPath === ws.path) {
        return ws.path;
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
