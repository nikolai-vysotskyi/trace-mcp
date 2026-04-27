import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FilamentPlugin } from '../../../src/indexer/plugins/integration/framework/filament/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/filament-v3');

function extract(relativePath: string) {
  const plugin = new FilamentPlugin();
  const content = fs.readFileSync(path.join(FIXTURE, relativePath));
  return plugin.extractNodes(relativePath, content, 'php')._unsafeUnwrap();
}

function edgesOfType(data: ReturnType<typeof extract>, type: string) {
  return data.edges!.filter((e) => e.edgeType === type);
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

  // ── Panel Provider (file-based fixture) ───────────────────────

  describe('panel provider — AdminPanelProvider.php', () => {
    const data = extract('app/Providers/Filament/AdminPanelProvider.php');

    it('sets frameworkRole', () => {
      expect(data.frameworkRole).toBe('filament_panel_provider');
    });

    it('extracts panel id and path', () => {
      expect(data.metadata?.panelId).toBe('admin');
      expect(data.metadata?.panelPath).toBe('admin');
    });

    it('extracts registered resources', () => {
      const edges = edgesOfType(data, 'filament_panel_resource');
      expect(edges.length).toBe(2);
      expect(edges.map((e) => e.target)).toEqual(
        expect.arrayContaining(['UserResource', 'PostResource']),
      );
    });

    it('extracts registered widgets', () => {
      const edges = edgesOfType(data, 'filament_panel_widget');
      expect(edges.length).toBe(2);
      expect(edges.map((e) => e.target)).toContain('StatsOverview');
    });

    it('extracts registered pages', () => {
      const edges = edgesOfType(data, 'filament_panel_page');
      expect(edges.length).toBe(1);
      expect(edges[0].target).toBe('Dashboard');
    });
  });

  // ── Resource — UserResource.php (basic) ───────────────────────

  describe('resource — UserResource.php', () => {
    const data = extract('app/Filament/Resources/UserResource.php');

    it('sets frameworkRole', () => {
      expect(data.frameworkRole).toBe('filament_resource');
    });

    it('binds to model', () => {
      const edges = edgesOfType(data, 'filament_resource_model');
      expect(edges).toHaveLength(1);
      expect(edges[0].target).toBe('User');
    });

    it('declares pages with slugs and routes', () => {
      const edges = edgesOfType(data, 'filament_resource_page');
      expect(edges).toHaveLength(3);
      const slugs = edges.map((e) => (e.metadata as Record<string, string>).slug);
      expect(slugs).toEqual(expect.arrayContaining(['index', 'create', 'edit']));
    });

    it('references relation managers', () => {
      const edges = edgesOfType(data, 'filament_resource_relation');
      expect(edges).toHaveLength(2);
      expect(edges.map((e) => e.target)).toEqual(
        expect.arrayContaining(['PostsRelationManager', 'CommentsRelationManager']),
      );
    });

    it('extracts form fields (TextInput, Select)', () => {
      const edges = edgesOfType(data, 'filament_form_field');
      expect(edges.length).toBeGreaterThanOrEqual(3);
      expect(edges.map((e) => e.target)).toEqual(
        expect.arrayContaining(['name', 'email', 'role_id']),
      );
    });

    it('extracts table columns (TextColumn)', () => {
      const edges = edgesOfType(data, 'filament_table_column');
      expect(edges.length).toBeGreaterThanOrEqual(3);
      expect(edges.map((e) => e.target)).toEqual(
        expect.arrayContaining(['name', 'email', 'role.name']),
      );
    });

    it('extracts table filters (SelectFilter)', () => {
      const edges = edgesOfType(data, 'filament_table_filter');
      expect(edges).toHaveLength(1);
      expect(edges[0].target).toBe('role');
    });

    it('extracts relationship calls', () => {
      const edges = edgesOfType(data, 'filament_relationship');
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges.map((e) => e.target)).toContain('role');
    });
  });

  // ── Resource — OrderResource.php (advanced: actions, infolists, columns, filters, cluster, nav) ──

  describe('resource — OrderResource.php (advanced)', () => {
    const data = extract('app/Filament/Resources/OrderResource.php');

    it('binds to Order model', () => {
      expect(edgesOfType(data, 'filament_resource_model')[0].target).toBe('Order');
    });

    it('has global search via recordTitleAttribute', () => {
      expect(data.metadata?.recordTitleAttribute).toBe('order_number');
      expect(data.metadata?.globalSearch).toBe(true);
    });

    it('belongs to Settings cluster', () => {
      const edges = edgesOfType(data, 'filament_cluster_member');
      expect(edges).toHaveLength(1);
      expect(edges[0].target).toBe('Settings');
    });

    it('extracts navigation metadata', () => {
      expect(data.metadata?.navigationGroup).toBe('Shop');
      expect(data.metadata?.navigationIcon).toBe('heroicon-o-shopping-cart');
      expect(data.metadata?.navigationSort).toBe(3);
    });

    it('extracts form layout (Section, Tabs)', () => {
      const edges = edgesOfType(data, 'filament_form_layout');
      expect(edges.length).toBeGreaterThanOrEqual(2);
      expect(edges.map((e) => e.target)).toEqual(
        expect.arrayContaining(['Order Details', 'Extra']),
      );
    });

    it('extracts form fields (TextInput, DatePicker, Toggle)', () => {
      const edges = edgesOfType(data, 'filament_form_field');
      expect(edges.length).toBeGreaterThanOrEqual(3);
      const components = edges.map((e) => (e.metadata as Record<string, string>).component);
      expect(components).toContain('TextInput');
      expect(components).toContain('DatePicker');
      expect(components).toContain('Toggle');
    });

    it('extracts all column types (TextColumn, IconColumn, ToggleColumn)', () => {
      const edges = edgesOfType(data, 'filament_table_column');
      expect(edges.length).toBeGreaterThanOrEqual(4);
      const components = edges.map((e) => (e.metadata as Record<string, string>).component);
      expect(components).toContain('TextColumn');
      expect(components).toContain('IconColumn');
      expect(components).toContain('ToggleColumn');
    });

    it('extracts all filter types (SelectFilter, TernaryFilter, TrashedFilter)', () => {
      const edges = edgesOfType(data, 'filament_table_filter');
      expect(edges.length).toBeGreaterThanOrEqual(3);
      const components = edges.map((e) => (e.metadata as Record<string, string>).component);
      expect(components).toContain('SelectFilter');
      expect(components).toContain('TernaryFilter');
      expect(components).toContain('TrashedFilter');
    });

    it('extracts table row actions (View, Edit, Delete)', () => {
      const edges = edgesOfType(data, 'filament_resource_action');
      expect(edges.length).toBeGreaterThanOrEqual(3);
      const actions = edges.map((e) => (e.metadata as Record<string, string>).action);
      expect(actions).toContain('view');
      expect(actions).toContain('edit');
      expect(actions).toContain('delete');
    });

    it('extracts table action blocks (row + bulk)', () => {
      const edges = edgesOfType(data, 'filament_table_action');
      // row actions + bulk actions
      expect(edges.length).toBeGreaterThanOrEqual(2);
      const scopes = edges.map((e) => (e.metadata as Record<string, string>).scope);
      expect(scopes).toContain('row');
      expect(scopes).toContain('bulk');
    });

    it('extracts infolist entries (TextEntry, IconEntry)', () => {
      const edges = edgesOfType(data, 'filament_infolist_entry');
      expect(edges).toHaveLength(3);
      expect(edges.map((e) => e.target)).toEqual(
        expect.arrayContaining(['order_number', 'customer.name', 'is_shipped']),
      );
      const components = edges.map((e) => (e.metadata as Record<string, string>).component);
      expect(components).toContain('TextEntry');
      expect(components).toContain('IconEntry');
    });

    it('has 4 resource pages', () => {
      const edges = edgesOfType(data, 'filament_resource_page');
      expect(edges).toHaveLength(4);
      expect(edges.map((e) => (e.metadata as Record<string, string>).slug)).toEqual(
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

    it('detects as filament_importer with model and columns', () => {
      expect(data.frameworkRole).toBe('filament_importer');

      const edges = edgesOfType(data, 'filament_importer');
      expect(edges).toHaveLength(1);
      expect(edges[0].target).toBe('Product');

      expect(data.metadata?.importColumns).toEqual(['name', 'sku', 'price']);
    });
  });

  // ── Inline tests for patterns without fixtures ────────────────

  describe('tenancy', () => {
    it('extracts tenant model from panel provider', () => {
      const source = `<?php
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
      expect(edgesOfType(data, 'filament_panel_tenant')[0].target).toBe('Team');
    });
  });

  describe('notifications', () => {
    it('detects flash notification', () => {
      const source = `<?php
use Filament\\Notifications\\Notification;
class X { public function y() { Notification::make()->title('OK')->send(); } }`;
      const data = plugin.extractNodes('X.php', Buffer.from(source), 'php')._unsafeUnwrap();
      const edges = edgesOfType(data, 'filament_notification');
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).type).toBe('flash');
    });

    it('detects database notification', () => {
      const source = `<?php
use Filament\\Notifications\\Notification;
class X { public function y() { Notification::make()->title('OK')->sendToDatabase($user); } }`;
      const data = plugin.extractNodes('X.php', Buffer.from(source), 'php')._unsafeUnwrap();
      expect(
        (edgesOfType(data, 'filament_notification')[0].metadata as Record<string, string>).type,
      ).toBe('database');
    });
  });

  describe('exporter (inline)', () => {
    it('extracts exporter model and columns', () => {
      const source = `<?php
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
      expect(edgesOfType(data, 'filament_exporter')[0].target).toBe('Order');
      expect(data.metadata?.exportColumns).toEqual(['id', 'total']);
    });
  });

  describe('livewire interop (inline)', () => {
    it('detects HasForms + InteractsWithForms traits', () => {
      const source = `<?php
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
      expect(edgesOfType(data, 'filament_form_field').map((e) => e.target)).toContain('search');
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
});
