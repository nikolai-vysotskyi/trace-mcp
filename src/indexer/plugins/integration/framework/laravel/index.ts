/**
 * LaravelPlugin — Framework plugin for Laravel applications.
 * Orchestrates route, Eloquent, migration, FormRequest, event, and middleware extraction.
 *
 * Supports Laravel 6–13:
 * - L6-8: string controller syntax, Route::namespace(), Kernel.php middleware
 * - L8+: class array syntax, invokable controllers
 * - L9+: Route::controller() groups
 * - L11+: bootstrap/app.php (withRouting, withMiddleware)
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
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';
import { extractRoutes } from './routes.js';
import { extractEloquentModel } from './eloquent.js';
import { extractMigrations } from './migrations.js';
import { extractFormRequest, detectFormRequestUsage } from './requests.js';
import { extractEventListeners, detectEventDispatches } from './events.js';
import {
  extractLivewireComponent,
  extractLivewireBladeUsages,
  extractWireDirectives,
  resolveComponentName,
  type LivewireComponentInfo,
} from './livewire.js';
import {
  extractFilamentResource,
  extractFilamentRelationManager,
  extractFilamentPanel,
  extractFilamentWidget,
} from './filament.js';
import { extractNovaResource, extractNovaMetric } from './nova.js';
import {
  extractBroadcastingEvent,
  extractChannelAuthorizations,
} from './broadcasting.js';
import { extractDataClass, buildDataClassEdges, extractInertiaDataProps } from './laravel-data.js';
import {
  extractFeatureDefinitions,
  extractFeatureUsages,
  extractFeatureBladeUsages,
  extractFeatureMiddlewareUsages,
} from './pennant.js';
import {
  parseKernelMiddleware,
  parseBootstrapMiddleware,
  parseRouteServiceProviderNamespace,
  parseBootstrapRouting,
  type MiddlewareConfig,
} from './middleware.js';

export class LaravelPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'laravel',
    version: '1.0.0',
    priority: 0,
    category: 'framework',
    dependencies: [],
  };

  /** Cached middleware configuration (populated during extractNodes). */
  private middlewareConfig: MiddlewareConfig | null = null;

  /** Controller namespace from RouteServiceProvider (Laravel 6-8). */
  private controllerNamespace: string | null = null;

  /** Route file paths from bootstrap/app.php (Laravel 11+). */
  private bootstrapRouting: Record<string, string> | null = null;

  /** Whether livewire/livewire is detected as a dependency. */
  private hasLivewire = false;

  /** Detected Livewire version (2 or 3), null if not detected. */
  private livewireVersion: 2 | 3 | null = null;

  /** Whether filament/filament or filament/support is detected. */
  private hasFilament = false;

  /** Whether laravel/nova is detected. */
  private hasNova = false;

  /** Whether spatie/laravel-data is detected. */
  private hasLaravelData = false;

  /** Whether laravel/reverb or pusher/pusher-php-server is detected. */
  private hasBroadcasting = false;

  /** Whether laravel/pennant is detected. */
  private hasPennant = false;

  detect(ctx: ProjectContext): boolean {
    // Check if composer.json has laravel/framework in require
    let deps: Record<string, string> | undefined;

    if (ctx.composerJson) {
      deps = ctx.composerJson.require as Record<string, string> | undefined;
    } else {
      // Fallback: read composer.json from disk
      try {
        const composerPath = path.join(ctx.rootPath, 'composer.json');
        const content = fs.readFileSync(composerPath, 'utf-8');
        const json = JSON.parse(content);
        deps = json.require as Record<string, string> | undefined;
      } catch {
        return false;
      }
    }

    if (!deps?.['laravel/framework']) return false;

    // Detect Nova
    if (deps['laravel/nova']) {
      this.hasNova = true;
    }

    // Detect Filament
    if (deps['filament/filament'] || deps['filament/support']) {
      this.hasFilament = true;
    }

    // Detect Livewire
    if (deps['livewire/livewire']) {
      this.hasLivewire = true;
      // Detect v2 vs v3 from version constraint
      const lwVersion = deps['livewire/livewire'];
      this.livewireVersion = /^\^?3|^3/.test(lwVersion) ? 3 : 2;
    }

    // Detect laravel-data
    if (deps['spatie/laravel-data']) {
      this.hasLaravelData = true;
    }

    // Detect Broadcasting (Reverb or Pusher)
    if (deps['laravel/reverb'] || deps['pusher/pusher-php-server']) {
      this.hasBroadcasting = true;
    }

    // Detect Pennant
    if (deps['laravel/pennant']) {
      this.hasPennant = true;
    }

    return true;
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
        // Nova edges
        { name: 'nova_resource_for', category: 'nova', description: 'Nova Resource → Eloquent Model' },
        { name: 'nova_field_relationship', category: 'nova', description: 'Nova Resource → related Nova Resource via field' },
        { name: 'nova_action_on', category: 'nova', description: 'Action → Resource' },
        { name: 'nova_filter_on', category: 'nova', description: 'Filter → Resource' },
        { name: 'nova_lens_on', category: 'nova', description: 'Lens → Resource' },
        { name: 'nova_metric_queries', category: 'nova', description: 'Metric → Eloquent Model' },
        // Filament edges
        { name: 'filament_resource_for', category: 'filament', description: 'Resource → Eloquent Model' },
        { name: 'filament_relation_manager', category: 'filament', description: 'Resource → RelationManager' },
        { name: 'filament_form_relationship', category: 'filament', description: 'Form field →relationship() → Model' },
        { name: 'filament_page_for', category: 'filament', description: 'Page registered on Resource' },
        { name: 'filament_panel_registers', category: 'filament', description: 'PanelProvider → Resource/Page/Widget' },
        { name: 'filament_widget_queries', category: 'filament', description: 'Widget → Eloquent Model' },
        // Livewire edges
        { name: 'livewire_renders', category: 'livewire', description: 'Component class → Blade view' },
        { name: 'livewire_dispatches', category: 'livewire', description: 'Component dispatches event' },
        { name: 'livewire_listens', category: 'livewire', description: 'Component listens for event' },
        { name: 'livewire_child_of', category: 'livewire', description: 'Blade <livewire:child/> → Component' },
        { name: 'livewire_uses_model', category: 'livewire', description: 'Component → Eloquent Model' },
        { name: 'livewire_form', category: 'livewire', description: 'Component → Form class (v3)' },
        { name: 'livewire_action', category: 'livewire', description: 'wire:click → Component method' },
        // Pennant edges
        { name: 'feature_defined_in', category: 'pennant', description: 'Feature flag defined via Feature::define()' },
        { name: 'feature_checked_by', category: 'pennant', description: 'Feature flag checked in PHP/Blade' },
        { name: 'feature_gates_route', category: 'pennant', description: 'Route protected by features middleware' },
        // Broadcasting edges
        { name: 'broadcasts_on', category: 'broadcasting', description: 'Event broadcasts on a channel' },
        { name: 'channel_authorized_by', category: 'broadcasting', description: 'Channel authorization callback or class' },
        { name: 'broadcast_as', category: 'broadcasting', description: 'Event broadcast name override' },
        // laravel-data edges
        { name: 'data_wraps', category: 'laravel-data', description: 'Data class wraps an Eloquent model' },
        { name: 'data_property_type', category: 'laravel-data', description: 'Data class property references another Data class' },
        { name: 'data_collection', category: 'laravel-data', description: 'DataCollection<T> references a Data class' },
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

    // Kernel.php — middleware config (Laravel 6-10)
    if (this.isKernelFile(filePath)) {
      this.middlewareConfig = parseKernelMiddleware(source);
      result.frameworkRole = 'middleware_config';
    }

    // bootstrap/app.php — middleware + routing config (Laravel 11+)
    if (this.isBootstrapAppFile(filePath)) {
      this.middlewareConfig = parseBootstrapMiddleware(source);
      this.bootstrapRouting = parseBootstrapRouting(source);
      result.frameworkRole = 'bootstrap_config';
    }

    // RouteServiceProvider — controller namespace (Laravel 6-8)
    if (this.isRouteServiceProvider(filePath)) {
      this.controllerNamespace = parseRouteServiceProviderNamespace(source);
      result.frameworkRole = 'route_provider';
    }

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

    // Nova files
    if (this.hasNova) {
      this.processNovaNode(source, filePath, result);
    }

    // Filament files
    if (this.hasFilament) {
      this.processFilamentNode(source, filePath, result);
    }

    // Livewire component files
    if (this.hasLivewire && this.isLivewireFile(filePath)) {
      const componentInfo = extractLivewireComponent(source, filePath);
      if (componentInfo) {
        result.frameworkRole = 'livewire_component';
        result.edges = result.edges ?? [];
        // Attach component metadata for pass 2 via edges with FQN metadata
        result.edges.push({
          edgeType: 'livewire_renders',
          metadata: {
            sourceFqn: componentInfo.fqn,
            targetViewPath: componentInfo.viewName
              ? `resources/views/${componentInfo.viewName.replace(/\./g, '/')}.blade.php`
              : componentInfo.conventionViewPath,
            viewName: componentInfo.viewName,
            convention: !componentInfo.viewName,
          },
        });
        for (const dispatch of componentInfo.dispatches) {
          result.edges.push({
            edgeType: 'livewire_dispatches',
            metadata: {
              sourceFqn: componentInfo.fqn,
              eventName: dispatch.eventName,
              method: dispatch.method,
            },
          });
        }
        for (const listener of componentInfo.listeners) {
          result.edges.push({
            edgeType: 'livewire_listens',
            metadata: {
              sourceFqn: componentInfo.fqn,
              eventName: listener.eventName,
              handlerMethod: listener.handlerMethod,
            },
          });
        }
        if (componentInfo.formProperty) {
          result.edges.push({
            edgeType: 'livewire_form',
            metadata: {
              sourceFqn: componentInfo.fqn,
              targetFqn: componentInfo.formProperty.formClass,
              propertyName: componentInfo.formProperty.propertyName,
            },
          });
        }
        for (const prop of componentInfo.properties) {
          if (prop.type && /\\Models\\/.test(prop.type)) {
            result.edges.push({
              edgeType: 'livewire_uses_model',
              metadata: {
                sourceFqn: componentInfo.fqn,
                targetFqn: prop.type,
                propertyName: prop.name,
              },
            });
          }
        }
      }
    }

    // Broadcasting events
    if (this.hasBroadcasting) {
      const eventInfo = extractBroadcastingEvent(source, filePath);
      if (eventInfo) {
        result.frameworkRole = 'broadcasting_event';
        result.edges = result.edges ?? [];
        for (const ch of eventInfo.channels) {
          result.edges.push({
            edgeType: 'broadcasts_on',
            metadata: { sourceFqn: eventInfo.fqn, channelName: ch.name, channelType: ch.type },
          });
        }
        if (eventInfo.broadcastAs) {
          result.edges.push({
            edgeType: 'broadcast_as',
            metadata: { sourceFqn: eventInfo.fqn, broadcastAs: eventInfo.broadcastAs },
          });
        }
      }
      // Channel authorization in channels.php
      if (filePath.endsWith('channels.php')) {
        const mappings = extractChannelAuthorizations(source);
        result.edges = result.edges ?? [];
        for (const m of mappings) {
          result.edges.push({
            edgeType: 'channel_authorized_by',
            metadata: { pattern: m.pattern, authClass: m.authClass },
          });
        }
      }
    }

    // Pennant feature flags
    if (this.hasPennant) {
      result.edges = result.edges ?? [];
      const defs = extractFeatureDefinitions(source, filePath);
      for (const def of defs) {
        result.edges.push({
          edgeType: 'feature_defined_in',
          metadata: { featureName: def.name, filePath: def.location, line: def.line },
        });
      }
      const usages = extractFeatureUsages(source);
      for (const u of usages) {
        result.edges.push({
          edgeType: 'feature_checked_by',
          metadata: { featureName: u.name, filePath, line: u.line, usageType: u.usageType },
        });
      }
      const middlewareUsages = extractFeatureMiddlewareUsages(source);
      for (const u of middlewareUsages) {
        result.edges.push({
          edgeType: 'feature_gates_route',
          metadata: { featureName: u.name, filePath, line: u.line },
        });
      }
    }

    // laravel-data classes
    if (this.hasLaravelData) {
      const dataInfo = extractDataClass(source, filePath);
      if (dataInfo) {
        result.frameworkRole = 'data_class';
        result.edges = result.edges ?? [];
        result.edges.push(...buildDataClassEdges(dataInfo));
      }
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

    // Build a file-path → file map for Livewire view resolution
    const fileMap = new Map<string, { id: number; path: string }>();
    for (const f of files) {
      fileMap.set(f.path, f);
    }

    for (const file of files) {
      const source = ctx.readFile(file.path);
      if (!source) continue;

      if (file.language === 'php') {
        // Resolve Eloquent relationships
        this.resolveEloquentEdges(source, file, ctx, edges);

        // Resolve FormRequest -> Controller edges
        this.resolveFormRequestEdges(source, file, ctx, edges);

        // Resolve Event listener edges
        this.resolveEventEdges(source, file, ctx, edges);

        // Resolve event dispatch edges
        this.resolveDispatchEdges(source, file, ctx, edges);

        // Resolve Livewire PHP-side edges
        if (this.hasLivewire) {
          this.resolveLivewirePhpEdges(source, file, ctx, edges, fileMap);
        }

        // Resolve Nova edges
        if (this.hasNova) {
          this.resolveNovaEdges(source, file, ctx, edges);
        }

        // Resolve Filament edges
        if (this.hasFilament) {
          this.resolveFilamentEdges(source, file, ctx, edges);
        }
      }

      // Resolve Livewire Blade-side edges (<livewire:name/>, wire:click)
      if (this.hasLivewire && file.path.endsWith('.blade.php')) {
        this.resolveLivewireBladeEdges(source, file, ctx, edges);
      }

      // Pennant @feature directives in Blade
      if (this.hasPennant && file.path.endsWith('.blade.php')) {
        const bladeUsages = extractFeatureBladeUsages(source);
        for (const usage of bladeUsages) {
          edges.push({
            edgeType: 'feature_checked_by',
            metadata: { featureName: usage.name, filePath: file.path, line: usage.line, usageType: 'blade' },
          });
        }
      }
    }

    return ok(edges);
  }

  /** Get the parsed middleware config (for use by tools like get_request_flow). */
  getMiddlewareConfig(): MiddlewareConfig | null {
    return this.middlewareConfig;
  }

  /** Get the controller namespace from RouteServiceProvider (Laravel 6-8). */
  getControllerNamespace(): string | null {
    return this.controllerNamespace;
  }

  /** Get bootstrap routing config (Laravel 11+). */
  getBootstrapRouting(): Record<string, string> | null {
    return this.bootstrapRouting;
  }

  /**
   * Resolve a middleware alias to its class FQN.
   * Returns the alias itself if no resolution found.
   */
  resolveMiddlewareAlias(alias: string): string {
    if (!this.middlewareConfig) return alias;
    return this.middlewareConfig.aliases[alias] ?? alias;
  }

  /**
   * Get the full middleware chain for a route, resolving aliases.
   * Combines route-level middleware with group middleware.
   */
  getMiddlewareChain(routeMiddleware?: string[]): string[] {
    if (!routeMiddleware || routeMiddleware.length === 0) return [];
    return routeMiddleware.map((m) => {
      const baseName = m.split(':')[0]; // 'auth:sanctum' -> 'auth'
      const resolved = this.resolveMiddlewareAlias(baseName);
      return resolved !== baseName ? `${resolved}${m.includes(':') ? ':' + m.split(':').slice(1).join(':') : ''}` : m;
    });
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

  private isKernelFile(filePath: string): boolean {
    return /app\/Http\/Kernel\.php$/.test(filePath);
  }

  private isBootstrapAppFile(filePath: string): boolean {
    return /bootstrap\/app\.php$/.test(filePath);
  }

  private isRouteServiceProvider(filePath: string): boolean {
    return /Providers\/RouteServiceProvider\.php$/.test(filePath);
  }

  private processNovaNode(
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    result.edges = result.edges ?? [];

    const resource = extractNovaResource(source, filePath);
    if (resource) {
      result.frameworkRole = 'nova_resource';
      if (resource.modelFqn) {
        result.edges.push({ edgeType: 'nova_resource_for', metadata: { sourceFqn: resource.fqn, targetFqn: resource.modelFqn } });
      }
      for (const rel of resource.fieldRelationships) {
        result.edges.push({ edgeType: 'nova_field_relationship', metadata: { sourceFqn: resource.fqn, targetFqn: rel.targetResourceFqn, fieldType: rel.fieldType } });
      }
      for (const a of resource.actions) {
        result.edges.push({ edgeType: 'nova_action_on', metadata: { sourceFqn: a, targetFqn: resource.fqn } });
      }
      for (const f of resource.filters) {
        result.edges.push({ edgeType: 'nova_filter_on', metadata: { sourceFqn: f, targetFqn: resource.fqn } });
      }
      for (const l of resource.lenses) {
        result.edges.push({ edgeType: 'nova_lens_on', metadata: { sourceFqn: l, targetFqn: resource.fqn } });
      }
      return;
    }

    const metric = extractNovaMetric(source, filePath);
    if (metric) {
      result.frameworkRole = 'nova_metric';
      for (const m of metric.queriedModels) {
        result.edges.push({ edgeType: 'nova_metric_queries', metadata: { sourceFqn: metric.fqn, targetFqn: m } });
      }
    }
  }

  private resolveNovaEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    const resource = extractNovaResource(source, file.path);
    if (resource) {
      const sourceSymbol = ctx.getSymbolByFqn(resource.fqn);
      if (!sourceSymbol) return;

      if (resource.modelFqn) {
        const modelSymbol = ctx.getSymbolByFqn(resource.modelFqn);
        if (modelSymbol) {
          edges.push({ sourceNodeType: 'symbol', sourceRefId: sourceSymbol.id, targetNodeType: 'symbol', targetRefId: modelSymbol.id, edgeType: 'nova_resource_for' });
        }
      }
      for (const rel of resource.fieldRelationships) {
        const targetSymbol = ctx.getSymbolByFqn(rel.targetResourceFqn);
        if (targetSymbol) {
          edges.push({ sourceNodeType: 'symbol', sourceRefId: sourceSymbol.id, targetNodeType: 'symbol', targetRefId: targetSymbol.id, edgeType: 'nova_field_relationship', metadata: { fieldType: rel.fieldType } });
        }
      }
      return;
    }

    const metric = extractNovaMetric(source, file.path);
    if (metric) {
      const metricSymbol = ctx.getSymbolByFqn(metric.fqn);
      if (!metricSymbol) return;
      for (const modelFqn of metric.queriedModels) {
        const modelSymbol = ctx.getSymbolByFqn(modelFqn);
        if (modelSymbol) {
          edges.push({ sourceNodeType: 'symbol', sourceRefId: metricSymbol.id, targetNodeType: 'symbol', targetRefId: modelSymbol.id, edgeType: 'nova_metric_queries' });
        }
      }
    }
  }

  private processFilamentNode(
    source: string,
    filePath: string,
    result: FileParseResult,
  ): void {
    result.edges = result.edges ?? [];

    const resource = extractFilamentResource(source, filePath);
    if (resource) {
      result.frameworkRole = 'filament_resource';
      if (resource.modelFqn) {
        result.edges.push({ edgeType: 'filament_resource_for', metadata: { sourceFqn: resource.fqn, targetFqn: resource.modelFqn } });
      }
      for (const rm of resource.relationManagers) {
        result.edges.push({ edgeType: 'filament_relation_manager', metadata: { sourceFqn: resource.fqn, targetFqn: rm } });
      }
      for (const rel of resource.formRelationships) {
        result.edges.push({ edgeType: 'filament_form_relationship', metadata: { sourceFqn: resource.fqn, relationName: rel.relationName } });
      }
      return;
    }

    const rm = extractFilamentRelationManager(source, filePath);
    if (rm) {
      result.frameworkRole = 'filament_relation_manager';
      return;
    }

    const panel = extractFilamentPanel(source, filePath);
    if (panel) {
      result.frameworkRole = 'filament_panel';
      for (const fqn of [...panel.resources, ...panel.pages, ...panel.widgets]) {
        result.edges.push({ edgeType: 'filament_panel_registers', metadata: { sourceFqn: panel.fqn, targetFqn: fqn, panelId: panel.panelId } });
      }
      return;
    }

    const widget = extractFilamentWidget(source, filePath);
    if (widget) {
      result.frameworkRole = 'filament_widget';
      const targets = [...(widget.modelFqn ? [widget.modelFqn] : []), ...widget.queriedModels];
      for (const modelFqn of [...new Set(targets)]) {
        result.edges.push({ edgeType: 'filament_widget_queries', metadata: { sourceFqn: widget.fqn, targetFqn: modelFqn } });
      }
    }
  }

  private resolveFilamentEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    // Resource → Model
    const resource = extractFilamentResource(source, file.path);
    if (resource) {
      if (resource.modelFqn) {
        const sourceSymbol = ctx.getSymbolByFqn(resource.fqn);
        const targetSymbol = ctx.getSymbolByFqn(resource.modelFqn);
        if (sourceSymbol && targetSymbol) {
          edges.push({
            sourceNodeType: 'symbol', sourceRefId: sourceSymbol.id,
            targetNodeType: 'symbol', targetRefId: targetSymbol.id,
            edgeType: 'filament_resource_for',
          });
        }
      }
      // Resource → RelationManagers
      const resourceSymbol = ctx.getSymbolByFqn(resource.fqn);
      if (resourceSymbol) {
        for (const rmFqn of resource.relationManagers) {
          const rmSymbol = ctx.getSymbolByFqn(rmFqn);
          if (rmSymbol) {
            edges.push({
              sourceNodeType: 'symbol', sourceRefId: resourceSymbol.id,
              targetNodeType: 'symbol', targetRefId: rmSymbol.id,
              edgeType: 'filament_relation_manager',
            });
          }
        }
      }
      return;
    }

    // Widget → Model
    const widget = extractFilamentWidget(source, file.path);
    if (widget) {
      const widgetSymbol = ctx.getSymbolByFqn(widget.fqn);
      if (!widgetSymbol) return;
      const targets = [...(widget.modelFqn ? [widget.modelFqn] : []), ...widget.queriedModels];
      for (const modelFqn of [...new Set(targets)]) {
        const modelSymbol = ctx.getSymbolByFqn(modelFqn);
        if (!modelSymbol) continue;
        edges.push({
          sourceNodeType: 'symbol', sourceRefId: widgetSymbol.id,
          targetNodeType: 'symbol', targetRefId: modelSymbol.id,
          edgeType: 'filament_widget_queries',
        });
      }
    }
  }

  private isLivewireFile(filePath: string): boolean {
    // v3: app/Livewire/**/*.php
    // v2: app/Http/Livewire/**/*.php
    return /app\/(?:Http\/)?Livewire\//.test(filePath);
  }

  private resolveLivewirePhpEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
    fileMap: Map<string, { id: number; path: string }>,
  ): void {
    const componentInfo = extractLivewireComponent(source, file.path);
    if (!componentInfo) return;

    const sourceSymbol = ctx.getSymbolByFqn(componentInfo.fqn);
    if (!sourceSymbol) return;

    // livewire_renders: Component → Blade view file
    const viewPath = componentInfo.viewName
      ? `resources/views/${componentInfo.viewName.replace(/\./g, '/')}.blade.php`
      : componentInfo.conventionViewPath;
    const viewFile = fileMap.get(viewPath);
    if (viewFile) {
      edges.push({
        sourceNodeType: 'symbol',
        sourceRefId: sourceSymbol.id,
        targetNodeType: 'file',
        targetRefId: viewFile.id,
        edgeType: 'livewire_renders',
        metadata: { viewPath, convention: !componentInfo.viewName },
      });
    }

    // livewire_dispatches
    for (const dispatch of componentInfo.dispatches) {
      edges.push({
        sourceNodeType: 'symbol',
        sourceRefId: sourceSymbol.id,
        edgeType: 'livewire_dispatches',
        metadata: { eventName: dispatch.eventName, method: dispatch.method },
      });
    }

    // livewire_listens
    for (const listener of componentInfo.listeners) {
      edges.push({
        sourceNodeType: 'symbol',
        sourceRefId: sourceSymbol.id,
        edgeType: 'livewire_listens',
        metadata: { eventName: listener.eventName, handlerMethod: listener.handlerMethod },
      });
    }

    // livewire_form: Component → Form class
    if (componentInfo.formProperty) {
      const formSymbol = ctx.getSymbolByFqn(componentInfo.formProperty.formClass);
      if (formSymbol) {
        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: sourceSymbol.id,
          targetNodeType: 'symbol',
          targetRefId: formSymbol.id,
          edgeType: 'livewire_form',
          metadata: { propertyName: componentInfo.formProperty.propertyName },
        });
      }
    }

    // livewire_uses_model: Component → Eloquent Model
    for (const prop of componentInfo.properties) {
      if (!prop.type || !/\\Models\\/.test(prop.type)) continue;
      const modelSymbol = ctx.getSymbolByFqn(prop.type);
      if (!modelSymbol) continue;
      edges.push({
        sourceNodeType: 'symbol',
        sourceRefId: sourceSymbol.id,
        targetNodeType: 'symbol',
        targetRefId: modelSymbol.id,
        edgeType: 'livewire_uses_model',
        metadata: { propertyName: prop.name },
      });
    }
  }

  private resolveLivewireBladeEdges(
    source: string,
    file: { id: number; path: string },
    ctx: ResolveContext,
    edges: RawEdge[],
  ): void {
    const version = this.livewireVersion ?? 3;

    // <livewire:component-name /> and @livewire('component-name')
    const usages = extractLivewireBladeUsages(source);
    for (const usage of usages) {
      const componentFqn = resolveComponentName(usage.componentName, version);
      const componentSymbol = ctx.getSymbolByFqn(componentFqn);
      if (!componentSymbol) continue;

      edges.push({
        sourceNodeType: 'file',
        sourceRefId: file.id,
        targetNodeType: 'symbol',
        targetRefId: componentSymbol.id,
        edgeType: 'livewire_child_of',
        metadata: { componentName: usage.componentName, line: usage.line, syntax: usage.syntax },
      });
    }

    // wire:click="method" → livewire_action
    const wireDirectives = extractWireDirectives(source);
    for (const directive of wireDirectives) {
      if (directive.directive === 'model') continue; // model is informational
      edges.push({
        sourceNodeType: 'file',
        sourceRefId: file.id,
        edgeType: 'livewire_action',
        metadata: { directive: directive.directive, method: directive.value, line: directive.line },
      });
    }
  }
}
