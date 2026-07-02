import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilamentPlugin } from '../../../src/indexer/plugins/integration/framework/filament/index.js';
import type { ProjectContext, RawEdge, ResolveContext } from '../../../src/plugin-api/types.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/filament-v3');

function extract(relativePath: string) {
  const plugin = new FilamentPlugin();
  const content = fs.readFileSync(path.join(FIXTURE, relativePath));
  return plugin.extractNodes(relativePath, content, 'php')._unsafeUnwrap();
}

function edgesOfType(edges: RawEdge[], type: string) {
  return edges.filter((e) => e.edgeType === type);
}

function metaOf(e: RawEdge): Record<string, unknown> {
  return (e.metadata ?? {}) as Record<string, unknown>;
}

/**
 * Class symbol for a fixture file: `path` -> its one top-level class FQN.
 * `resolveEdges` requires a real enclosing class symbol per file (no
 * file-node fallback like the Electron plugin has), so every fixture file
 * exercised here needs an entry.
 */
const FILE_CLASS_FQN: Record<string, string> = {
  'app/Providers/Filament/AdminPanelProvider.php': 'App\\Providers\\Filament\\AdminPanelProvider',
  'app/Filament/Resources/UserResource.php': 'App\\Filament\\Resources\\UserResource',
  'app/Filament/Resources/OrderResource.php': 'App\\Filament\\Resources\\OrderResource',
  'app/Filament/Resources/UserResource/RelationManagers/PostsRelationManager.php':
    'App\\Filament\\Resources\\UserResource\\RelationManagers\\PostsRelationManager',
  'app/Filament/Resources/UserResource/RelationManagers/CommentsRelationManager.php':
    'App\\Filament\\Resources\\UserResource\\RelationManagers\\CommentsRelationManager',
  'app/Filament/Widgets/StatsOverview.php': 'App\\Filament\\Widgets\\StatsOverview',
  'app/Filament/Pages/Dashboard.php': 'App\\Filament\\Pages\\Dashboard',
  'app/Filament/Clusters/Settings.php': 'App\\Filament\\Clusters\\Settings',
  'app/Filament/Imports/ProductImporter.php': 'App\\Filament\\Imports\\ProductImporter',
};

/**
 * Extra class targets referenced by the fixtures that have no backing file
 * in tests/fixtures/filament-v3 (e.g. PostResource, LatestOrders, Eloquent
 * models, resource Page classes). `getSymbolByFqn` is a pure lookup in this
 * harness, so registering an FQN here is enough to resolve `pushClassEdge`
 * targets without needing an actual file/fixture for them.
 */
const EXTRA_FQNS = [
  'App\\Filament\\Resources\\PostResource',
  'App\\Filament\\Widgets\\LatestOrders',
  'App\\Models\\User',
  'App\\Models\\Order',
  'App\\Models\\Product',
  'App\\Filament\\Resources\\UserResource\\Pages\\ListUsers',
  'App\\Filament\\Resources\\UserResource\\Pages\\CreateUser',
  'App\\Filament\\Resources\\UserResource\\Pages\\EditUser',
  // OrderResource has no `use ...\Pages;` import, so `Pages\ListOrders` etc.
  // resolve relative to the file's own namespace (App\Filament\Resources).
  'App\\Filament\\Resources\\Pages\\ListOrders',
  'App\\Filament\\Resources\\Pages\\CreateOrder',
  'App\\Filament\\Resources\\Pages\\ViewOrder',
  'App\\Filament\\Resources\\Pages\\EditOrder',
];

/**
 * Build a minimal ResolveContext from fixture files, with a synthetic class
 * symbol per file (see FILE_CLASS_FQN) plus extra FQNs for targets that
 * don't have their own fixture file. Mirrors the Electron plugin's
 * buildResolveContext helper (tests/frameworks/electron/plugin.test.ts),
 * adapted because Filament's resolveEdges requires a real enclosing class
 * symbol (no file-node fallback).
 */
function buildResolveContext(filePaths: string[]): {
  ctx: ResolveContext;
  idByPath: Map<string, number>;
  idByFqn: Map<string, number>;
} {
  const idByPath = new Map<string, number>();
  const idByFqn = new Map<string, number>();
  let nextId = 1;

  const files = filePaths.map((p) => {
    const id = nextId++;
    idByPath.set(p, id);
    return { id, path: p, language: 'php' as string | null };
  });

  // Every known fixture class FQN is resolvable as a target regardless of
  // which files are being iterated in this particular ctx — cross-file
  // class references (e.g. UserResource -> PostsRelationManager) must
  // resolve even when the test only loads UserResource.php's own file.
  for (const fqn of Object.values(FILE_CLASS_FQN)) {
    if (idByFqn.has(fqn)) continue;
    idByFqn.set(fqn, nextId++);
  }
  for (const fqn of EXTRA_FQNS) {
    if (idByFqn.has(fqn)) continue;
    idByFqn.set(fqn, nextId++);
  }

  const symbolsByFileId = new Map<
    number,
    { id: number; symbolId: string; name: string; kind: string; fqn: string | null }[]
  >();
  for (const p of filePaths) {
    const fqn = FILE_CLASS_FQN[p];
    if (!fqn) continue; // no class declared / not needed as an enclosing source
    const id = idByFqn.get(fqn)!;
    const name = fqn.split('\\').pop()!;
    symbolsByFileId.set(idByPath.get(p)!, [
      { id, symbolId: `${p}::${name}#class`, name, kind: 'class', fqn },
    ]);
  }

  const fileContents = new Map<string, string>();
  for (const p of filePaths) {
    fileContents.set(p, fs.readFileSync(path.join(FIXTURE, p), 'utf-8'));
  }

  const ctx: ResolveContext = {
    rootPath: FIXTURE,
    getAllFiles: () => files,
    getSymbolsByFile: (fileId: number) => symbolsByFileId.get(fileId) ?? [],
    getSymbolByFqn: (fqn: string) => {
      const id = idByFqn.get(fqn);
      if (id == null) return undefined;
      const name = fqn.split('\\').pop()!;
      return { id, symbolId: `${fqn}#class`, name, kind: 'class' };
    },
    getNodeId: () => undefined,
    createNodeIfNeeded: () => 0,
    readFile: (relPath: string) => fileContents.get(relPath),
  };
  return { ctx, idByPath, idByFqn };
}

function resolveAll(filePaths: string[]): {
  edges: RawEdge[];
  idByPath: Map<string, number>;
  idByFqn: Map<string, number>;
} {
  const plugin = new FilamentPlugin();
  const { ctx, idByPath, idByFqn } = buildResolveContext(filePaths);
  const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
  return { edges, idByPath, idByFqn };
}

/** All fixture files, resolved together so cross-file class targets bind. */
function resolveFixture(): {
  edges: RawEdge[];
  idByPath: Map<string, number>;
  idByFqn: Map<string, number>;
} {
  return resolveAll(Object.keys(FILE_CLASS_FQN));
}

/** Per-file edges from resolveEdges when only one file is in the context. */
function resolveSingle(relativePath: string): RawEdge[] {
  return resolveAll([relativePath]).edges;
}

/** Inline source, single synthetic file+class, for patterns without fixtures. */
function resolveInline(source: string, fqn = 'App\\Inline\\X'): RawEdge[] {
  const plugin = new FilamentPlugin();
  const name = fqn.split('\\').pop()!;
  const ctx: ResolveContext = {
    rootPath: FIXTURE,
    getAllFiles: () => [{ id: 1, path: 'inline.php', language: 'php' }],
    getSymbolsByFile: () => [
      { id: 2, symbolId: `inline.php::${name}#class`, name, kind: 'class', fqn },
    ],
    getSymbolByFqn: (q: string) =>
      q === fqn ? { id: 2, symbolId: `${fqn}#class`, name, kind: 'class' } : undefined,
    getNodeId: () => undefined,
    createNodeIfNeeded: () => 0,
    readFile: () => source,
  };
  return plugin.resolveEdges(ctx)._unsafeUnwrap();
}

describe('FilamentPlugin', () => {
  const plugin = new FilamentPlugin();

  // ── detect() ──────────────────────────────────────────────────

  describe('detect()', () => {
    it('returns true via composerJson', () => {
      const ctx = {
        rootPath: FIXTURE,
        composerJson: { require: { 'filament/filament': '^3.0' } },
        configFiles: [],
      } as ProjectContext;
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false without filament dependency', () => {
      const ctx = {
        rootPath: '/nonexistent',
        composerJson: { require: { 'laravel/framework': '^11.0' } },
        configFiles: [],
      } as ProjectContext;
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('detects from disk fallback', () => {
      const ctx = { rootPath: FIXTURE, configFiles: [] } as ProjectContext;
      expect(plugin.detect(ctx)).toBe(true);
    });
  });

  // ── registerSchema() ──────────────────────────────────────────

  describe('registerSchema()', () => {
    it('returns all 21 edge types', () => {
      const names = plugin.registerSchema().edgeTypes!.map((e) => e.name);
      expect(names).toHaveLength(21);
      for (const expected of [
        'filament_panel_resource',
        'filament_panel_widget',
        'filament_panel_page',
        'filament_panel_cluster',
        'filament_panel_plugin',
        'filament_panel_tenant',
        'filament_resource_model',
        'filament_resource_page',
        'filament_resource_relation',
        'filament_resource_action',
        'filament_form_field',
        'filament_form_layout',
        'filament_table_column',
        'filament_table_filter',
        'filament_table_action',
        'filament_infolist_entry',
        'filament_relationship',
        'filament_cluster_member',
        'filament_notification',
        'filament_importer',
        'filament_exporter',
      ]) {
        expect(names).toContain(expected);
      }
    });
  });

  // ── extractNodes() — Pass 1 tags roles + metadata only, no edges ──

  describe('extractNodes() — roles & metadata only (edges belong to resolveEdges)', () => {
    it('does not emit edges in Pass 1', () => {
      const data = extract('app/Filament/Resources/UserResource.php');
      expect(data.edges).toBeUndefined();
    });
  });

  // ── Panel Provider (file-based fixture) ───────────────────────

  describe('panel provider — AdminPanelProvider.php', () => {
    const data = extract('app/Providers/Filament/AdminPanelProvider.php');
    const edges = resolveSingle('app/Providers/Filament/AdminPanelProvider.php');

    it('sets frameworkRole', () => {
      expect(data.frameworkRole).toBe('filament_panel_provider');
    });

    it('extracts panel id and path', () => {
      expect(data.metadata?.panelId).toBe('admin');
      expect(data.metadata?.panelPath).toBe('admin');
    });

    it('extracts registered resources', () => {
      const resourceEdges = edgesOfType(edges, 'filament_panel_resource');
      expect(resourceEdges.length).toBe(2);
      expect(resourceEdges.map((e) => metaOf(e).class)).toEqual(
        expect.arrayContaining(['UserResource', 'PostResource']),
      );
      for (const e of resourceEdges) {
        expect(e.sourceNodeType).toBe('symbol');
        expect(e.targetNodeType).toBe('symbol');
        expect(e.resolution).toBe('ast_resolved');
      }
    });

    it('extracts registered widgets', () => {
      const widgetEdges = edgesOfType(edges, 'filament_panel_widget');
      expect(widgetEdges.length).toBe(2);
      expect(widgetEdges.map((e) => metaOf(e).class)).toContain('StatsOverview');
    });

    it('extracts registered pages', () => {
      const pageEdges = edgesOfType(edges, 'filament_panel_page');
      expect(pageEdges.length).toBe(1);
      expect(metaOf(pageEdges[0]).class).toBe('Dashboard');
    });
  });

  // ── Resource — UserResource.php (basic) ───────────────────────

  describe('resource — UserResource.php', () => {
    const data = extract('app/Filament/Resources/UserResource.php');
    const edges = resolveSingle('app/Filament/Resources/UserResource.php');

    it('sets frameworkRole', () => {
      expect(data.frameworkRole).toBe('filament_resource');
    });

    it('binds to model', () => {
      const modelEdges = edgesOfType(edges, 'filament_resource_model');
      expect(modelEdges).toHaveLength(1);
      expect(metaOf(modelEdges[0]).model).toBe('User');
      expect(modelEdges[0].sourceNodeType).toBe('symbol');
      expect(modelEdges[0].targetNodeType).toBe('symbol');
    });

    it('declares pages with slugs and routes', () => {
      const pageEdges = edgesOfType(edges, 'filament_resource_page');
      expect(pageEdges).toHaveLength(3);
      const slugs = pageEdges.map((e) => metaOf(e).slug);
      expect(slugs).toEqual(expect.arrayContaining(['index', 'create', 'edit']));
    });

    it('references relation managers', () => {
      const relEdges = edgesOfType(edges, 'filament_resource_relation');
      expect(relEdges).toHaveLength(2);
      expect(relEdges.map((e) => metaOf(e).class)).toEqual(
        expect.arrayContaining(['PostsRelationManager', 'CommentsRelationManager']),
      );
    });

    it('extracts form fields (TextInput, Select) as virtual-target edges', () => {
      const fieldEdges = edgesOfType(edges, 'filament_form_field');
      expect(fieldEdges.length).toBeGreaterThanOrEqual(3);
      expect(fieldEdges.map((e) => metaOf(e).field)).toEqual(
        expect.arrayContaining(['name', 'email', 'role_id']),
      );
      for (const e of fieldEdges) {
        expect(e.targetSymbolId).toBe(`filament-field::${metaOf(e).field}`);
        expect(e.resolution).toBe('text_matched');
      }
    });

    it('extracts table columns (TextColumn)', () => {
      const colEdges = edgesOfType(edges, 'filament_table_column');
      expect(colEdges.length).toBeGreaterThanOrEqual(3);
      expect(colEdges.map((e) => metaOf(e).column)).toEqual(
        expect.arrayContaining(['name', 'email', 'role.name']),
      );
    });

    it('extracts table filters (SelectFilter)', () => {
      const filterEdges = edgesOfType(edges, 'filament_table_filter');
      expect(filterEdges).toHaveLength(1);
      expect(metaOf(filterEdges[0]).filter).toBe('role');
    });

    it('extracts relationship calls', () => {
      const relationshipEdges = edgesOfType(edges, 'filament_relationship');
      expect(relationshipEdges.length).toBeGreaterThanOrEqual(1);
      expect(relationshipEdges.map((e) => metaOf(e).relationship)).toContain('role');
    });
  });

  // ── Resource — OrderResource.php (advanced: actions, infolists, columns, filters, cluster, nav) ──

  describe('resource — OrderResource.php (advanced)', () => {
    const data = extract('app/Filament/Resources/OrderResource.php');
    const edges = resolveSingle('app/Filament/Resources/OrderResource.php');

    it('binds to Order model', () => {
      expect(metaOf(edgesOfType(edges, 'filament_resource_model')[0]).model).toBe('Order');
    });

    it('has global search via recordTitleAttribute', () => {
      expect(data.metadata?.recordTitleAttribute).toBe('order_number');
      expect(data.metadata?.globalSearch).toBe(true);
    });

    it('belongs to Settings cluster', () => {
      const clusterEdges = edgesOfType(edges, 'filament_cluster_member');
      expect(clusterEdges).toHaveLength(1);
      expect(metaOf(clusterEdges[0]).cluster).toBe('Settings');
    });

    it('extracts navigation metadata', () => {
      expect(data.metadata?.navigationGroup).toBe('Shop');
      expect(data.metadata?.navigationIcon).toBe('heroicon-o-shopping-cart');
      expect(data.metadata?.navigationSort).toBe(3);
    });

    it('extracts form layout (Section, Tabs)', () => {
      const layoutEdges = edgesOfType(edges, 'filament_form_layout');
      expect(layoutEdges.length).toBeGreaterThanOrEqual(2);
      expect(layoutEdges.map((e) => metaOf(e).label)).toEqual(
        expect.arrayContaining(['Order Details', 'Extra']),
      );
    });

    it('extracts form fields (TextInput, DatePicker, Toggle)', () => {
      const fieldEdges = edgesOfType(edges, 'filament_form_field');
      expect(fieldEdges.length).toBeGreaterThanOrEqual(3);
      const components = fieldEdges.map((e) => metaOf(e).component);
      expect(components).toContain('TextInput');
      expect(components).toContain('DatePicker');
      expect(components).toContain('Toggle');
    });

    it('extracts all column types (TextColumn, IconColumn, ToggleColumn)', () => {
      const colEdges = edgesOfType(edges, 'filament_table_column');
      expect(colEdges.length).toBeGreaterThanOrEqual(4);
      const components = colEdges.map((e) => metaOf(e).component);
      expect(components).toContain('TextColumn');
      expect(components).toContain('IconColumn');
      expect(components).toContain('ToggleColumn');
    });

    it('extracts all filter types (SelectFilter, TernaryFilter, TrashedFilter)', () => {
      const filterEdges = edgesOfType(edges, 'filament_table_filter');
      expect(filterEdges.length).toBeGreaterThanOrEqual(3);
      const components = filterEdges.map((e) => metaOf(e).component);
      expect(components).toContain('SelectFilter');
      expect(components).toContain('TernaryFilter');
      expect(components).toContain('TrashedFilter');
    });

    it('extracts table row actions (View, Edit, Delete)', () => {
      const actionEdges = edgesOfType(edges, 'filament_resource_action');
      expect(actionEdges.length).toBeGreaterThanOrEqual(3);
      const actions = actionEdges.map((e) => metaOf(e).action);
      expect(actions).toContain('view');
      expect(actions).toContain('edit');
      expect(actions).toContain('delete');
    });

    it('extracts table action blocks (row + bulk)', () => {
      const tableActionEdges = edgesOfType(edges, 'filament_table_action');
      // row actions + bulk actions
      expect(tableActionEdges.length).toBeGreaterThanOrEqual(2);
      const scopes = tableActionEdges.map((e) => metaOf(e).scope);
      expect(scopes).toContain('row');
      expect(scopes).toContain('bulk');
    });

    it('extracts infolist entries (TextEntry, IconEntry)', () => {
      const entryEdges = edgesOfType(edges, 'filament_infolist_entry');
      expect(entryEdges).toHaveLength(3);
      expect(entryEdges.map((e) => metaOf(e).entry)).toEqual(
        expect.arrayContaining(['order_number', 'customer.name', 'is_shipped']),
      );
      const components = entryEdges.map((e) => metaOf(e).component);
      expect(components).toContain('TextEntry');
      expect(components).toContain('IconEntry');
    });

    it('has 4 resource pages', () => {
      const pageEdges = edgesOfType(edges, 'filament_resource_page');
      expect(pageEdges).toHaveLength(4);
      expect(pageEdges.map((e) => metaOf(e).slug)).toEqual(
        expect.arrayContaining(['index', 'create', 'view', 'edit']),
      );
    });
  });

  // ── Relation Manager ──────────────────────────────────────────

  describe('relation manager — PostsRelationManager.php', () => {
    const data = extract(
      'app/Filament/Resources/UserResource/RelationManagers/PostsRelationManager.php',
    );

    it('sets frameworkRole and relationship name', () => {
      expect(data.frameworkRole).toBe('filament_relation_manager');
      expect(data.metadata?.relationship).toBe('posts');
    });
  });

  // ── Widget ────────────────────────────────────────────────────

  describe('widget — StatsOverview.php', () => {
    const data = extract('app/Filament/Widgets/StatsOverview.php');

    it('detects StatsOverviewWidget', () => {
      expect(data.frameworkRole).toBe('filament_widget');
    });
  });

  // ── Custom Page ───────────────────────────────────────────────

  describe('page — Dashboard.php', () => {
    const data = extract('app/Filament/Pages/Dashboard.php');

    it('detects as filament_page with navigation metadata', () => {
      expect(data.frameworkRole).toBe('filament_page');
      expect(data.metadata?.navigationIcon).toBe('heroicon-o-home');
      expect(data.metadata?.navigationLabel).toBe('Dashboard');
      expect(data.metadata?.navigationSort).toBe(1);
    });
  });

  // ── Cluster ───────────────────────────────────────────────────

  describe('cluster — Settings.php', () => {
    const data = extract('app/Filament/Clusters/Settings.php');

    it('detects as filament_cluster with navigation metadata', () => {
      expect(data.frameworkRole).toBe('filament_cluster');
      expect(data.metadata?.navigationIcon).toBe('heroicon-o-cog');
      expect(data.metadata?.navigationGroup).toBe('Admin');
      expect(data.metadata?.navigationSort).toBe(5);
    });
  });

  // ── Importer ──────────────────────────────────────────────────

  describe('importer — ProductImporter.php', () => {
    const data = extract('app/Filament/Imports/ProductImporter.php');
    const edges = resolveSingle('app/Filament/Imports/ProductImporter.php');

    it('detects as filament_importer with model and columns', () => {
      expect(data.frameworkRole).toBe('filament_importer');

      const importerEdges = edgesOfType(edges, 'filament_importer');
      expect(importerEdges).toHaveLength(1);
      expect(metaOf(importerEdges[0]).model).toBe('Product');

      expect(data.metadata?.importColumns).toEqual(['name', 'sku', 'price']);
    });
  });

  // ── Cross-file: all fixtures resolved together ─────────────────

  describe('resolveEdges() — full fixture, cross-file class targets', () => {
    const { edges, idByFqn } = resolveFixture();

    it('resolves panel -> resource/page/widget targets to real symbol ids', () => {
      const resourceEdges = edgesOfType(edges, 'filament_panel_resource');
      const userResourceEdge = resourceEdges.find((e) => metaOf(e).class === 'UserResource');
      expect(userResourceEdge?.targetRefId).toBe(
        idByFqn.get('App\\Filament\\Resources\\UserResource'),
      );
    });

    it('resolves resource -> model target to real symbol id', () => {
      const modelEdge = edgesOfType(edges, 'filament_resource_model').find(
        (e) => metaOf(e).model === 'User',
      );
      expect(modelEdge?.targetRefId).toBe(idByFqn.get('App\\Models\\User'));
    });
  });

  // ── Inline tests for patterns without fixtures ────────────────

  describe('tenancy', () => {
    it('extracts tenant model from panel provider', () => {
      const source = `<?php
namespace App\\Providers;
use Filament\\Panel;
use Filament\\PanelProvider;
class TenantPanel extends PanelProvider {
  public function panel(Panel $panel): Panel {
    return $panel->id('tenant')->path('app')->tenant(Team::class)->resources([]);
  }
}`;
      const data = plugin
        .extractNodes('TenantPanel.php', Buffer.from(source), 'php')
        ._unsafeUnwrap();
      expect(data.metadata?.tenantModel).toBe('Team');

      const fqn = 'App\\Providers\\TenantPanel';
      const plugin2 = new FilamentPlugin();
      const ctx: ResolveContext = {
        rootPath: FIXTURE,
        getAllFiles: () => [{ id: 1, path: 'TenantPanel.php', language: 'php' }],
        getSymbolsByFile: () => [
          { id: 2, symbolId: `${fqn}#class`, name: 'TenantPanel', kind: 'class', fqn },
        ],
        getSymbolByFqn: (q: string) =>
          q === 'App\\Providers\\Team'
            ? { id: 3, symbolId: 'App\\Providers\\Team#class', name: 'Team', kind: 'class' }
            : undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => source,
      };
      const edges = plugin2.resolveEdges(ctx)._unsafeUnwrap();
      const tenantEdges = edgesOfType(edges, 'filament_panel_tenant');
      expect(tenantEdges).toHaveLength(1);
      expect(metaOf(tenantEdges[0]).model).toBe('Team');
      expect(tenantEdges[0].targetRefId).toBe(3);
    });
  });

  describe('notifications', () => {
    it('detects flash notification', () => {
      const source = `<?php
namespace App;
use Filament\\Notifications\\Notification;
class X { public function y() { Notification::make()->title('OK')->send(); } }`;
      const data = plugin.extractNodes('X.php', Buffer.from(source), 'php')._unsafeUnwrap();
      expect(data.frameworkRole).toBeUndefined(); // no role match for a bare notification call

      const edges = resolveInline(source, 'App\\X');
      const notifEdges = edgesOfType(edges, 'filament_notification');
      expect(notifEdges).toHaveLength(1);
      expect(metaOf(notifEdges[0]).type).toBe('flash');
      expect(notifEdges[0].targetSymbolId).toBe('filament-notification::flash');
    });

    it('detects database notification', () => {
      const source = `<?php
namespace App;
use Filament\\Notifications\\Notification;
class X { public function y() { Notification::make()->title('OK')->sendToDatabase($user); } }`;
      const edges = resolveInline(source, 'App\\X');
      expect(metaOf(edgesOfType(edges, 'filament_notification')[0]).type).toBe('database');
    });
  });

  describe('exporter (inline)', () => {
    it('extracts exporter model and columns', () => {
      const source = `<?php
namespace App;
use Filament\\Actions\\Exports\\Exporter;
use Filament\\Actions\\Exports\\ExportColumn;
class OrderExporter extends Exporter {
  protected static ?string $model = Order::class;
  public static function getColumns(): array {
    return [ ExportColumn::make('id'), ExportColumn::make('total') ];
  }
}`;
      const data = plugin
        .extractNodes('OrderExporter.php', Buffer.from(source), 'php')
        ._unsafeUnwrap();
      expect(data.frameworkRole).toBe('filament_exporter');
      expect(data.metadata?.exportColumns).toEqual(['id', 'total']);

      const plugin2 = new FilamentPlugin();
      const fqn = 'App\\OrderExporter';
      const ctx: ResolveContext = {
        rootPath: FIXTURE,
        getAllFiles: () => [{ id: 1, path: 'OrderExporter.php', language: 'php' }],
        getSymbolsByFile: () => [
          { id: 2, symbolId: `${fqn}#class`, name: 'OrderExporter', kind: 'class', fqn },
        ],
        getSymbolByFqn: (q: string) =>
          q === 'App\\Order'
            ? { id: 3, symbolId: 'App\\Order#class', name: 'Order', kind: 'class' }
            : undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => source,
      };
      const edges = plugin2.resolveEdges(ctx)._unsafeUnwrap();
      const exporterEdges = edgesOfType(edges, 'filament_exporter');
      expect(exporterEdges).toHaveLength(1);
      expect(metaOf(exporterEdges[0]).model).toBe('Order');
      expect(exporterEdges[0].targetRefId).toBe(3);
    });
  });

  describe('livewire interop (inline)', () => {
    it('detects HasForms + InteractsWithForms traits', () => {
      const source = `<?php
namespace App;
use Filament\\Forms\\Contracts\\HasForms;
use Filament\\Forms\\Concerns\\InteractsWithForms;
use Filament\\Forms\\Components\\TextInput;
class MyComponent extends Component implements HasForms {
  use InteractsWithForms;
  public function form(Form $form) {
    return $form->schema([ TextInput::make('search') ]);
  }
}`;
      const data = plugin
        .extractNodes('MyComponent.php', Buffer.from(source), 'php')
        ._unsafeUnwrap();
      expect(data.metadata?.filamentTraits).toEqual(
        expect.arrayContaining(['InteractsWithForms', 'HasForms']),
      );

      const edges = resolveInline(source, 'App\\MyComponent');
      expect(edgesOfType(edges, 'filament_form_field').map((e) => metaOf(e).field)).toContain(
        'search',
      );
    });
  });

  describe('extends Page guard', () => {
    it('does NOT match extends Page without Filament\\Pages\\Page import', () => {
      const source = `<?php
use Filament\\Forms\\Components\\TextInput;
class MyPage extends Page { }`;
      const data = plugin.extractNodes('MyPage.php', Buffer.from(source), 'php')._unsafeUnwrap();
      expect(data.frameworkRole).not.toBe('filament_page');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────

  it('ignores non-php files', () => {
    const data = plugin.extractNodes('file.ts', Buffer.from(''), 'typescript')._unsafeUnwrap();
    expect(data.symbols).toEqual([]);
  });

  it('ignores php files without filament imports', () => {
    const data = plugin
      .extractNodes('plain.php', Buffer.from('<?php class Foo {}'), 'php')
      ._unsafeUnwrap();
    expect(data.edges).toBeUndefined();
  });

  it('resolveEdges emits nothing for files without filament imports', () => {
    const edges = resolveInline('<?php class Foo {}', 'App\\Foo');
    expect(edges).toEqual([]);
  });
});
