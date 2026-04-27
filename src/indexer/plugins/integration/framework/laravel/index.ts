/**
 * LaravelPlugin — Framework plugin for Laravel applications.
 * Thin orchestrator that delegates to domain-specific sub-modules.
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
import { extractFormRequest } from './requests.js';
import { detectEventDispatches } from './events.js';
import {
  isLivewireFile,
  processLivewireNode,
  resolveLivewirePhpEdges,
  resolveLivewireBladeEdges,
} from './livewire.js';
import { processFilamentNode, resolveFilamentEdges } from './filament.js';
import { processNovaNode, resolveNovaEdges } from './nova.js';
import { extractBroadcastingEvent, extractChannelAuthorizations } from './broadcasting.js';
import { extractDataClass, buildDataClassEdges } from './laravel-data.js';
import {
  extractHorizonConfig,
  extractHorizonJob,
  buildHorizonJobEdges,
  buildHorizonConfigEdges,
  buildHorizonConfigSymbols,
} from './horizon.js';
import { extractBillableModel, extractCashierWebhook, buildBillableModelEdges } from './cashier.js';
import {
  extractSearchableModel,
  buildSearchableModelEdges,
  buildSearchableModelSymbols,
} from './scout.js';
import { extractSocialiteUsage, buildSocialiteEdges } from './socialite.js';
import {
  extractMediaLibraryModel,
  buildMediaLibraryModelEdges,
  buildMediaLibraryModelSymbols,
} from './medialibrary.js';
import {
  extractEloquentSortableModel,
  buildEloquentSortableModelSymbols,
} from './eloquent-sortable.js';
import {
  extractLaravelFavoriteModel,
  buildLaravelFavoriteEdges,
  buildLaravelFavoriteSymbols,
} from './laravel-favorite.js';
import {
  extractLaravelFilemanagerConfig,
  extractLaravelFilemanagerMacro,
  buildLaravelFilemanagerRoutes,
} from './laravel-filemanager.js';
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
import {
  resolveEloquentEdges,
  resolveFormRequestEdges,
  resolveEventEdges,
  resolveDispatchEdges,
  resolveComposerLaravelProviders,
} from './edges.js';

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

  /** Whether laravel/horizon is detected. */
  private hasHorizon = false;

  /** Whether laravel/cashier is detected. */
  private hasCashier = false;

  /** Whether laravel/scout is detected. */
  private hasScout = false;

  /** Whether laravel/socialite is detected. */
  private hasSocialite = false;

  /** Whether laravel/reverb or pusher/pusher-php-server is detected. */
  private hasBroadcasting = false;

  /** Whether laravel/pennant is detected. */
  private hasPennant = false;

  /** Whether spatie/laravel-medialibrary is detected. */
  private hasMediaLibrary = false;

  /** Whether spatie/eloquent-sortable is detected. */
  private hasEloquentSortable = false;

  /** Whether overtrue/laravel-favorite is detected as a dependency. */
  private hasLaravelFavorite = false;

  /** Whether unisharp/laravel-filemanager is detected as a dependency. */
  private hasLaravelFilemanager = false;

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

    // Detect ecosystem packages
    if (deps['laravel/nova']) this.hasNova = true;
    if (deps['filament/filament'] || deps['filament/support']) this.hasFilament = true;
    if (deps['livewire/livewire']) {
      this.hasLivewire = true;
      const lwVersion = deps['livewire/livewire'];
      this.livewireVersion = /^\^?3|^3/.test(lwVersion) ? 3 : 2;
    }
    if (deps['spatie/laravel-data']) this.hasLaravelData = true;
    if (deps['laravel/horizon']) this.hasHorizon = true;
    if (deps['laravel/cashier'] || deps['laravel/cashier-stripe']) this.hasCashier = true;
    if (deps['laravel/scout']) this.hasScout = true;
    if (deps['laravel/socialite']) this.hasSocialite = true;
    if (deps['laravel/reverb'] || deps['pusher/pusher-php-server']) this.hasBroadcasting = true;
    if (deps['laravel/pennant']) this.hasPennant = true;
    if (deps['spatie/laravel-medialibrary']) this.hasMediaLibrary = true;
    if (deps['spatie/eloquent-sortable']) this.hasEloquentSortable = true;
    if (deps['overtrue/laravel-favorite']) this.hasLaravelFavorite = true;
    if (deps['unisharp/laravel-filemanager']) this.hasLaravelFilemanager = true;

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
        {
          name: 'nova_resource_for',
          category: 'nova',
          description: 'Nova Resource → Eloquent Model',
        },
        {
          name: 'nova_field_relationship',
          category: 'nova',
          description: 'Nova Resource → related Nova Resource via field',
        },
        { name: 'nova_action_on', category: 'nova', description: 'Action → Resource' },
        { name: 'nova_filter_on', category: 'nova', description: 'Filter → Resource' },
        { name: 'nova_lens_on', category: 'nova', description: 'Lens → Resource' },
        { name: 'nova_metric_queries', category: 'nova', description: 'Metric → Eloquent Model' },
        // Filament edges
        {
          name: 'filament_resource_for',
          category: 'filament',
          description: 'Resource → Eloquent Model',
        },
        {
          name: 'filament_relation_manager',
          category: 'filament',
          description: 'Resource → RelationManager',
        },
        {
          name: 'filament_form_relationship',
          category: 'filament',
          description: 'Form field →relationship() → Model',
        },
        {
          name: 'filament_page_for',
          category: 'filament',
          description: 'Page registered on Resource',
        },
        {
          name: 'filament_panel_registers',
          category: 'filament',
          description: 'PanelProvider → Resource/Page/Widget',
        },
        {
          name: 'filament_widget_queries',
          category: 'filament',
          description: 'Widget → Eloquent Model',
        },
        // Livewire edges
        {
          name: 'livewire_renders',
          category: 'livewire',
          description: 'Component class → Blade view',
        },
        {
          name: 'livewire_dispatches',
          category: 'livewire',
          description: 'Component dispatches event',
        },
        {
          name: 'livewire_listens',
          category: 'livewire',
          description: 'Component listens for event',
        },
        {
          name: 'livewire_child_of',
          category: 'livewire',
          description: 'Blade <livewire:child/> → Component',
        },
        {
          name: 'livewire_uses_model',
          category: 'livewire',
          description: 'Component → Eloquent Model',
        },
        { name: 'livewire_form', category: 'livewire', description: 'Component → Form class (v3)' },
        {
          name: 'livewire_action',
          category: 'livewire',
          description: 'wire:click → Component method',
        },
        // Pennant edges
        {
          name: 'feature_defined_in',
          category: 'pennant',
          description: 'Feature flag defined via Feature::define()',
        },
        {
          name: 'feature_checked_by',
          category: 'pennant',
          description: 'Feature flag checked in PHP/Blade',
        },
        {
          name: 'feature_gates_route',
          category: 'pennant',
          description: 'Route protected by features middleware',
        },
        // Broadcasting edges
        {
          name: 'broadcasts_on',
          category: 'broadcasting',
          description: 'Event broadcasts on a channel',
        },
        {
          name: 'channel_authorized_by',
          category: 'broadcasting',
          description: 'Channel authorization callback or class',
        },
        {
          name: 'broadcast_as',
          category: 'broadcasting',
          description: 'Event broadcast name override',
        },
        // laravel-data edges
        {
          name: 'data_nests',
          category: 'laravel-data',
          description: 'Data class property references another Data class',
        },
        {
          name: 'data_collects',
          category: 'laravel-data',
          description: 'DataCollection<T> references a Data class',
        },
        {
          name: 'data_maps_from',
          category: 'laravel-data',
          description: 'Data class maps from an Eloquent model',
        },
        // Horizon edges
        {
          name: 'horizon_job_on_queue',
          category: 'horizon',
          description: 'Job dispatched to a specific queue',
        },
        {
          name: 'horizon_job_connection',
          category: 'horizon',
          description: 'Job uses a specific queue connection',
        },
        {
          name: 'horizon_supervises_queue',
          category: 'horizon',
          description: 'Horizon supervisor manages a queue',
        },
        // Cashier edges
        {
          name: 'cashier_billable',
          category: 'cashier',
          description: 'Model uses Billable trait (Stripe integration)',
        },
        {
          name: 'cashier_subscription',
          category: 'cashier',
          description: 'Model uses subscription method',
        },
        {
          name: 'cashier_webhook',
          category: 'cashier',
          description: 'Route handles Cashier/Stripe webhook',
        },
        // Scout edges
        {
          name: 'scout_searchable',
          category: 'scout',
          description: 'Model uses Searchable trait (full-text search index)',
        },
        // Socialite edges
        {
          name: 'socialite_uses_provider',
          category: 'socialite',
          description: 'Controller uses Socialite OAuth provider',
        },
        {
          name: 'socialite_custom_provider',
          category: 'socialite',
          description: 'Custom Socialite OAuth provider class',
        },
        // Media library edges
        {
          name: 'medialibrary_collection',
          category: 'medialibrary',
          description: 'Model declares a spatie media collection',
        },
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

    // ── Config files ──────────────────────────────────────────
    if (this.isKernelFile(filePath)) {
      this.middlewareConfig = parseKernelMiddleware(source);
      result.frameworkRole = 'middleware_config';
    }
    if (this.isBootstrapAppFile(filePath)) {
      this.middlewareConfig = parseBootstrapMiddleware(source);
      this.bootstrapRouting = parseBootstrapRouting(source);
      result.frameworkRole = 'bootstrap_config';
    }
    if (this.isRouteServiceProvider(filePath)) {
      this.controllerNamespace = parseRouteServiceProviderNamespace(source);
      result.frameworkRole = 'route_provider';
    }

    // ── Core Laravel ──────────────────────────────────────────
    if (this.isRouteFile(filePath)) {
      const routeResult = extractRoutes(source, filePath);
      result.routes = routeResult.routes;
      result.frameworkRole = 'route';
      if (routeResult.warnings.length > 0) {
        result.warnings = routeResult.warnings;
      }
    }
    if (this.isMigrationFile(filePath)) {
      const migResult = extractMigrations(source, filePath);
      result.migrations = migResult.migrations;
      result.frameworkRole = 'migration';
    }
    if (extractEloquentModel(source, filePath)) {
      result.frameworkRole = 'model';
    }
    if (extractFormRequest(source)) {
      result.frameworkRole = 'form_request';
    }
    if (filePath.includes('EventServiceProvider')) {
      result.frameworkRole = 'event_provider';
    }

    // ── Ecosystem packages (delegated) ────────────────────────
    if (this.hasNova) processNovaNode(source, filePath, result);
    if (this.hasFilament) processFilamentNode(source, filePath, result);
    if (this.hasLivewire && isLivewireFile(filePath)) processLivewireNode(source, filePath, result);

    // ── Broadcasting ──────────────────────────────────────────
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

    // ── Pennant feature flags ─────────────────────────────────
    if (this.hasPennant) {
      result.edges = result.edges ?? [];
      for (const def of extractFeatureDefinitions(source, filePath)) {
        result.edges.push({
          edgeType: 'feature_defined_in',
          metadata: { featureName: def.name, filePath: def.location, line: def.line },
        });
      }
      for (const u of extractFeatureUsages(source)) {
        result.edges.push({
          edgeType: 'feature_checked_by',
          metadata: { featureName: u.name, filePath, line: u.line, usageType: u.usageType },
        });
      }
      for (const u of extractFeatureMiddlewareUsages(source)) {
        result.edges.push({
          edgeType: 'feature_gates_route',
          metadata: { featureName: u.name, filePath, line: u.line },
        });
      }
    }

    // ── laravel-data ──────────────────────────────────────────
    if (this.hasLaravelData) {
      const dataInfo = extractDataClass(source, filePath);
      if (dataInfo) {
        result.frameworkRole = 'data_class';
        result.edges = result.edges ?? [];
        result.edges.push(...buildDataClassEdges(dataInfo));
      }
    }

    // ── Horizon ──────────────────────────────────────────────
    if (this.hasHorizon) {
      if (filePath.includes('config/horizon.php')) {
        const config = extractHorizonConfig(source);
        if (config) {
          result.frameworkRole = 'horizon_config';
          result.edges = result.edges ?? [];
          result.edges.push(...buildHorizonConfigEdges(config));
          result.symbols.push(...buildHorizonConfigSymbols(config));
        }
      }
      const jobInfo = extractHorizonJob(source, filePath);
      if (jobInfo) {
        result.edges = result.edges ?? [];
        result.edges.push(...buildHorizonJobEdges(jobInfo));
      }
    }

    // ── Cashier ──────────────────────────────────────────────
    if (this.hasCashier) {
      const billableInfo = extractBillableModel(source, filePath);
      if (billableInfo) {
        result.edges = result.edges ?? [];
        result.edges.push(...buildBillableModelEdges(billableInfo));
      }
      const webhookType = extractCashierWebhook(source);
      if (webhookType) {
        result.edges = result.edges ?? [];
        result.edges.push({
          edgeType: 'cashier_webhook',
          metadata: { filePath, type: webhookType },
        });
      }
    }

    // ── Scout ────────────────────────────────────────────────
    if (this.hasScout) {
      const searchableInfo = extractSearchableModel(source, filePath);
      if (searchableInfo) {
        result.edges = result.edges ?? [];
        result.edges.push(...buildSearchableModelEdges(searchableInfo));
        result.symbols.push(...buildSearchableModelSymbols(searchableInfo));
      }
    }

    // ── Socialite ────────────────────────────────────────────
    if (this.hasSocialite) {
      const socialiteInfo = extractSocialiteUsage(source, filePath);
      if (socialiteInfo) {
        result.edges = result.edges ?? [];
        result.edges.push(...buildSocialiteEdges(socialiteInfo, filePath));
      }
    }

    // ── Media library ────────────────────────────────────────
    if (this.hasMediaLibrary) {
      const mediaInfo = extractMediaLibraryModel(source, filePath);
      if (mediaInfo) {
        result.edges = result.edges ?? [];
        result.edges.push(...buildMediaLibraryModelEdges(mediaInfo));
        result.symbols.push(...buildMediaLibraryModelSymbols(mediaInfo));
      }
    }

    // ── Eloquent sortable ────────────────────────────────────
    if (this.hasEloquentSortable) {
      const sortableInfo = extractEloquentSortableModel(source, filePath);
      if (sortableInfo) {
        result.symbols.push(...buildEloquentSortableModelSymbols(sortableInfo));
      }
    }

    // ── overtrue/laravel-favorite ────────────────────────────
    if (this.hasLaravelFavorite) {
      const favoriteInfo = extractLaravelFavoriteModel(source, filePath);
      if (favoriteInfo) {
        result.edges = result.edges ?? [];
        result.edges.push(...buildLaravelFavoriteEdges(favoriteInfo));
        result.symbols.push(...buildLaravelFavoriteSymbols(favoriteInfo));
      }
    }

    // ── unisharp/laravel-filemanager ─────────────────────────
    if (this.hasLaravelFilemanager) {
      const lfmConfig = extractLaravelFilemanagerConfig(source, filePath);
      const lfmMacro = lfmConfig ? null : extractLaravelFilemanagerMacro(source, filePath);
      const lfm = lfmConfig ?? lfmMacro;
      if (lfm) {
        result.routes = result.routes ?? [];
        result.routes.push(...buildLaravelFilemanagerRoutes(lfm));
        if (!result.frameworkRole) result.frameworkRole = 'laravel_filemanager_routes';
      }
    }

    // Detect event dispatches (stored for pass 2)
    detectEventDispatches(source);

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
        // Core edge resolvers
        resolveEloquentEdges(source, file, ctx, edges);
        resolveFormRequestEdges(source, file, ctx, edges);
        resolveEventEdges(source, file, ctx, edges);
        resolveDispatchEdges(source, file, ctx, edges);

        // Ecosystem edge resolvers
        if (this.hasLivewire) resolveLivewirePhpEdges(source, file, ctx, edges, fileMap);
        if (this.hasNova) resolveNovaEdges(source, file, ctx, edges);
        if (this.hasFilament) resolveFilamentEdges(source, file, ctx, edges);
      }

      // Blade-side resolvers
      if (this.hasLivewire && file.path.endsWith('.blade.php')) {
        resolveLivewireBladeEdges(source, file, ctx, edges, this.livewireVersion ?? 3);
      }
      if (this.hasPennant && file.path.endsWith('.blade.php')) {
        for (const usage of extractFeatureBladeUsages(source)) {
          edges.push({
            edgeType: 'feature_checked_by',
            metadata: {
              featureName: usage.name,
              filePath: file.path,
              line: usage.line,
              usageType: 'blade',
            },
          });
        }
      }

      // composer.json → Laravel auto-registered providers/aliases/facades.
      // Links `extra.laravel.providers` / `aliases` to the class symbols they reference.
      if (file.path.endsWith('composer.json')) {
        resolveComposerLaravelProviders(source, file, ctx, edges);
      }
    }

    return ok(edges);
  }

  // ── Public getters (used by tools like get_request_flow) ───

  getMiddlewareConfig(): MiddlewareConfig | null {
    return this.middlewareConfig;
  }

  getControllerNamespace(): string | null {
    return this.controllerNamespace;
  }

  getBootstrapRouting(): Record<string, string> | null {
    return this.bootstrapRouting;
  }

  resolveMiddlewareAlias(alias: string): string {
    if (!this.middlewareConfig) return alias;
    return this.middlewareConfig.aliases[alias] ?? alias;
  }

  getMiddlewareChain(routeMiddleware?: string[]): string[] {
    if (!routeMiddleware || routeMiddleware.length === 0) return [];
    return routeMiddleware.map((m) => {
      const baseName = m.split(':')[0];
      const resolved = this.resolveMiddlewareAlias(baseName);
      return resolved !== baseName
        ? `${resolved}${m.includes(':') ? `:${m.split(':').slice(1).join(':')}` : ''}`
        : m;
    });
  }

  // ── Private file-type checks ───────────────────────────────

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
}
