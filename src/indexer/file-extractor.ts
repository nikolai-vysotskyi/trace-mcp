/**
 * FileExtractor: handles the extract phase of the indexing pipeline.
 * Reads a file from disk, validates it, parses it with language/framework plugins,
 * and computes complexity metrics. Pure computation — no DB writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import type { FileRow } from '../db/types.js';
import { logger } from '../logger.js';
import { executeFrameworkExtractNodes, executeLanguagePlugin } from '../plugin-api/executor.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  ProjectContext,
  RawEdge,
} from '../plugin-api/types.js';
import { computeComplexity } from '../tools/analysis/complexity.js';
import type { GitignoreMatcher } from '../utils/gitignore.js';
import { hashContent } from '../utils/hasher.js';
import {
  isBinaryBuffer,
  isSensitiveFile,
  validateFileSize,
  validatePath,
} from '../utils/security.js';
import type { ExtractResponse } from './extract-pool.js';
import type { WorkspaceInfo } from './monorepo.js';
import type { FileExtraction } from './pipeline-state.js';
import { buildProjectContext } from './project-context.js';

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
  /**
   * Project-relative paths declared as `package.json#main`/`module`/`bin`/
   * `exports`. These are the package's public surface and must be indexed
   * even if they exceed the default file-size cap (e.g. lodash.js is 548 KB
   * declared as `main` — silently dropping it makes every published method
   * invisible to dead-code and call-graph queries). Mirrors jcodemunch
   * v1.80.9 force-include behavior.
   */
  forceIncludePaths?: ReadonlySet<string>;
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
  ): Promise<ExtractResponse> {
    const { registry, rootPath } = this.ctx;
    const absPath = path.resolve(rootPath, relPath);

    // Defence-in-depth: reject paths that escape the project root
    const pathCheck = validatePath(relPath, rootPath);
    if (pathCheck.isErr()) {
      logger.warn({ file: relPath }, 'Path traversal blocked');
      return { kind: 'error' };
    }

    // Reject symlinks to prevent escaping the project root
    let fileMtimeMs: number | null = null;
    try {
      const stat = fs.lstatSync(absPath);
      if (stat.isSymbolicLink()) {
        logger.warn({ file: relPath }, 'Symlink skipped');
        return { kind: 'error' };
      }
      fileMtimeMs = stat.mtimeMs;
    } catch {
      // lstat failed — file may not exist; readFileSync below will catch it
    }

    // Block sensitive files (credentials, keys, secrets) from indexing
    if (isSensitiveFile(relPath)) {
      logger.warn({ file: relPath }, 'Sensitive file blocked from indexing');
      return { kind: 'skipped' };
    }

    // Existing-row lookup. Resolution order:
    //   1. caller-supplied via opts.existing (worker path)
    //   2. context preload Map (CLI path; one IN-query upfront)
    //   3. store.getFile fallback (single-row SELECT)
    const existing =
      opts.existing ?? this.ctx.existingFiles?.get(relPath) ?? this.ctx.store?.getFile(relPath);

    // mtime fast-path: if mtime hasn't changed, the file content is identical —
    // skip the expensive read + hash computation entirely.
    if (
      !force &&
      fileMtimeMs != null &&
      existing &&
      existing.mtime_ms != null &&
      existing.mtime_ms === Math.floor(fileMtimeMs)
    ) {
      return { kind: 'skipped' };
    }

    let content: Buffer;
    try {
      content = fs.readFileSync(absPath);
    } catch {
      logger.warn({ file: relPath }, 'Cannot read file');
      return { kind: 'error' };
    }

    // Reject binary files (null-byte in first 8 KB)
    if (isBinaryBuffer(content)) {
      logger.warn({ file: relPath }, 'Binary file detected, skipping');
      return { kind: 'skipped' };
    }

    // Reject oversized files (default 1 MB) to prevent OOM — UNLESS the
    // file is declared as a package entry point (main/module/bin/exports).
    // Public API surface must be indexed regardless of monolithic size,
    // otherwise dead-code/call-graph results are systematically wrong for
    // single-file libraries (lodash-class).
    const isForceIncluded = this.ctx.forceIncludePaths?.has(relPath) ?? false;
    if (!isForceIncluded) {
      const sizeCheck = validateFileSize(content.length);
      if (sizeCheck.isErr()) {
        logger.warn({ file: relPath, size: content.length }, 'File too large, skipping');
        return { kind: 'error' };
      }
    } else if (content.length > 5 * 1024 * 1024) {
      // Above 5MB even a declared entry point is more likely a bundled
      // artifact than real source. Refuse and let the operator opt in
      // via an explicit raise of validateFileSize's max if they know.
      logger.warn(
        { file: relPath, size: content.length },
        'force-included package entry exceeds 5 MB hard ceiling — skipping',
      );
      return { kind: 'error' };
    }

    // mtime drifted but content might be identical (formatter-on-save, git
    // checkout that touches mtime). Compare content_hash first — cheap
    // xxh64 hash beats a full reparse. Persist the new mtime so subsequent
    // runs hit the free mtime fast-path above.
    const hash = hashContent(content);
    if (!force && existing && existing.content_hash === hash) {
      const newMtime = fileMtimeMs != null ? Math.floor(fileMtimeMs) : null;
      if (newMtime != null && existing.mtime_ms !== newMtime) {
        if (this.ctx.store) {
          // In-process path: write directly.
          this.ctx.store.updateFileMtime(existing.id, newMtime);
          return { kind: 'skipped' };
        }
        // WHY: workers receive a fixture context with no DB handle — surface
        // the update so the main thread can persist it. Without this the
        // mtime fast-path never re-arms after a hash-hit in the worker path.
        return { kind: 'mtime_updated', fileId: existing.id, newMtimeMs: newMtime };
      }
      return { kind: 'skipped' };
    }

    // Cache content for Pass 2 (resolveEdges reads files again)
    const contentStr = content.toString('utf-8');
    this.ctx.fileContentCache.set(relPath, contentStr);

    // Find matching language plugin. Pass the file's first bytes so the
    // registry can fall back to a `#!` shebang when the extension match
    // fails — extensionless scripts like bin/deploy or scripts/migrate
    // would otherwise drop out of the index entirely.
    const plugin = registry.getLanguagePluginForFileWithFallback(relPath, content);
    if (!plugin) {
      return { kind: 'skipped' };
    }

    // Execute language plugin
    const parseResult = await executeLanguagePlugin(plugin, relPath, content);
    if (parseResult.isErr()) {
      logger.error({ file: relPath, error: parseResult.error }, 'Language plugin failed');
      return { kind: 'error' };
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
        const isImportEdge =
          (edge.edgeType === 'imports' ||
            edge.edgeType === 'py_imports' ||
            edge.edgeType === 'php_imports') &&
          !edge.sourceNodeType &&
          !edge.sourceSymbolId;
        if (isImportEdge) {
          importEdges.push({
            from: ((edge.metadata as Record<string, unknown>)?.from as string) ?? '',
            specifiers: ((edge.metadata as Record<string, unknown>)?.specifiers as string[]) ?? [],
            relPath,
          });
        } else {
          otherEdges.push(edge);
        }
      }
    }

    // Collect framework extract results (no DB writes). Awaits async
    // plugins (e.g. ReactPlugin uses tree-sitter via async getParser).
    const frameworkExtracts = await this.collectFrameworkExtracts(relPath, content, language);

    const extraction: FileExtraction = {
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
    return { kind: 'ok', extraction };
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
            param_count: sym.signature
              ? computeComplexity('', sym.signature, language).param_count
              : 0,
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

  private async collectFrameworkExtracts(
    relPath: string,
    content: Buffer,
    language: string,
  ): Promise<FileParseResult[]> {
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
      // Most plugins are sync (regex-only); the few that need async parser
      // init (e.g. ReactPlugin via tree-sitter getParser) hit the await
      // branch inside the executor. The outer extract() call already
      // provides timeout/error containment.
      const result = await executeFrameworkExtractNodes(plugin, extractPath, content, language);
      if (result.isErr() || !result.value) continue;
      results.push(result.value);
    }
    return results;
  }

  /** Returns the workspace path (relative to root) that contains `relPath`, or null. */
  private resolveWorkspacePath(relPath: string): string | null {
    for (const ws of this.ctx.workspaces) {
      if (relPath.startsWith(`${ws.path}/`) || relPath === ws.path) {
        return ws.path;
      }
    }
    return null;
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).slice(1);
    const map: Record<string, string> = {
      php: 'php',
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      mjs: 'javascript',
      mts: 'typescript',
      vue: 'vue',
    };
    return map[ext] ?? ext;
  }
}
