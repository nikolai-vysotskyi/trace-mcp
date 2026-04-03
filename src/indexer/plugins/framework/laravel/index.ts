/**
 * LaravelPlugin — Framework plugin for Laravel applications.
 * Orchestrates route, Eloquent, migration, FormRequest, and event extraction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';
import { extractRoutes } from './routes.js';
import { extractEloquentModel } from './eloquent.js';
import { extractMigrations } from './migrations.js';
import { extractFormRequest, detectFormRequestUsage } from './requests.js';
import { extractEventListeners, detectEventDispatches } from './events.js';

export class LaravelPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'laravel',
    version: '1.0.0',
    priority: 0,
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    // Check if composer.json has laravel/framework in require
    if (ctx.composerJson) {
      const require = ctx.composerJson.require as Record<string, string> | undefined;
      if (require?.['laravel/framework']) return true;
    }

    // Fallback: read composer.json from disk
    try {
      const composerPath = path.join(ctx.rootPath, 'composer.json');
      const content = fs.readFileSync(composerPath, 'utf-8');
      const json = JSON.parse(content);
      const require = json.require as Record<string, string> | undefined;
      return !!require?.['laravel/framework'];
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'routes_to', category: 'laravel', description: 'Route -> Controller' },
        { name: 'has_many', category: 'laravel', description: 'Eloquent hasMany' },
        { name: 'belongs_to', category: 'laravel', description: 'Eloquent belongsTo' },
        { name: 'belongs_to_many', category: 'laravel', description: 'Eloquent belongsToMany' },
        { name: 'has_one', category: 'laravel', description: 'Eloquent hasOne' },
        { name: 'morphs_to', category: 'laravel', description: 'Eloquent morphTo' },
        { name: 'validates_with', category: 'laravel', description: 'Controller -> FormRequest' },
        { name: 'dispatches', category: 'laravel', description: 'Dispatches event/job' },
        { name: 'listens_to', category: 'laravel', description: 'Listener -> Event' },
        { name: 'middleware_guards', category: 'laravel', description: 'Route -> Middleware' },
        { name: 'migrates', category: 'laravel', description: 'Migration -> table' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'php') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
      routes: [],
      migrations: [],
      warnings: [],
    };

    // Route files
    if (this.isRouteFile(filePath)) {
      const routeResult = extractRoutes(source, filePath);
      result.routes = routeResult.routes;
      result.frameworkRole = 'route';
      if (routeResult.warnings.length > 0) {
        result.warnings = routeResult.warnings;
      }
    }

    // Migration files
    if (this.isMigrationFile(filePath)) {
      const migResult = extractMigrations(source, filePath);
      result.migrations = migResult.migrations;
      result.frameworkRole = 'migration';
    }

    // Model files — store metadata for pass 2
    const modelInfo = extractEloquentModel(source, filePath);
    if (modelInfo) {
      result.frameworkRole = 'model';
    }

    // FormRequest files
    const requestInfo = extractFormRequest(source);
    if (requestInfo) {
      result.frameworkRole = 'form_request';
    }

    // EventServiceProvider
    if (filePath.includes('EventServiceProvider')) {
      result.frameworkRole = 'event_provider';
    }

    // Detect event dispatches in any file
    const dispatches = detectEventDispatches(source);
    if (dispatches.length > 0) {
      // Store for pass 2
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const files = ctx.getAllFiles();

    for (const file of files) {
      if (file.language !== 'php') continue;

      let source: string;
      try {
        source = fs.readFileSync(
          path.resolve(ctx.rootPath, file.path),
          'utf-8',
        );
      } catch {
        continue;
      }

      // Resolve Eloquent relationships
      this.resolveEloquentEdges(source, file, ctx, edges);

      // Resolve FormRequest -> Controller edges
      this.resolveFormRequestEdges(source, file, ctx, edges);

      // Resolve Event listener edges
      this.resolveEventEdges(source, file, ctx, edges);

      // Resolve event dispatch edges
      this.resolveDispatchEdges(source, file, ctx, edges);
    }

    return ok(edges);
  }

  private resolveEloquentEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    const modelInfo = extractEloquentModel(source, file.path);
    if (!modelInfo) return;

    const sourceSymbol = ctx.getSymbolByFqn(modelInfo.fqn);
    if (!sourceSymbol) return;

    for (const rel of modelInfo.relationships) {
      const targetSymbol = ctx.getSymbolByFqn(rel.relatedClass);
      if (!targetSymbol) continue;

      const sourceNodeId = ctx.createNodeIfNeeded('symbol', sourceSymbol.id);
      const targetNodeId = ctx.createNodeIfNeeded('symbol', targetSymbol.id);

      edges.push({
        sourceNodeType: 'symbol',
        sourceRefId: sourceSymbol.id,
        targetNodeType: 'symbol',
        targetRefId: targetSymbol.id,
        edgeType: rel.edgeType,
        metadata: {
          method: rel.methodName,
          relationType: rel.type,
        },
      });
    }
  }

  private resolveFormRequestEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    const usages = detectFormRequestUsage(source);
    if (usages.length === 0) return;

    // Find the class in this file
    const symbols = ctx.getSymbolsByFile(file.id);
    const controllerClass = symbols.find((s) => s.kind === 'class');
    if (!controllerClass) return;

    for (const usage of usages) {
      const methodSymbol = symbols.find(
        (s) => s.kind === 'method' && s.name === usage.methodName,
      );
      if (!methodSymbol) continue;

      const requestSymbol = ctx.getSymbolByFqn(usage.requestClass);
      if (!requestSymbol) continue;

      edges.push({
        sourceNodeType: 'symbol',
        sourceRefId: methodSymbol.id,
        targetNodeType: 'symbol',
        targetRefId: requestSymbol.id,
        edgeType: 'validates_with',
        metadata: { method: usage.methodName },
      });
    }
  }

  private resolveEventEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    const mappings = extractEventListeners(source);
    if (mappings.length === 0) return;

    for (const mapping of mappings) {
      const eventSymbol = ctx.getSymbolByFqn(mapping.eventClass);
      if (!eventSymbol) continue;

      for (const listenerFqn of mapping.listenerClasses) {
        const listenerSymbol = ctx.getSymbolByFqn(listenerFqn);
        if (!listenerSymbol) continue;

        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: listenerSymbol.id,
          targetNodeType: 'symbol',
          targetRefId: eventSymbol.id,
          edgeType: 'listens_to',
        });
      }
    }
  }

  private resolveDispatchEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    const dispatches = detectEventDispatches(source);
    if (dispatches.length === 0) return;

    // Find the class in this file
    const symbols = ctx.getSymbolsByFile(file.id);
    const cls = symbols.find((s) => s.kind === 'class');
    if (!cls) return;

    for (const eventFqn of dispatches) {
      const eventSymbol = ctx.getSymbolByFqn(eventFqn);
      if (!eventSymbol) continue;

      edges.push({
        sourceNodeType: 'symbol',
        sourceRefId: cls.id,
        targetNodeType: 'symbol',
        targetRefId: eventSymbol.id,
        edgeType: 'dispatches',
      });
    }
  }

  private isRouteFile(filePath: string): boolean {
    return /routes\/[\w-]+\.php$/.test(filePath);
  }

  private isMigrationFile(filePath: string): boolean {
    return filePath.includes('database/migrations/');
  }
}
