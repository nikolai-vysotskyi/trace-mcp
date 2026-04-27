/**
 * Filament v3 plugin — detects Filament admin panel structure:
 *
 * Panel providers:    panels, registered resources/pages/widgets/clusters, tenancy, auth, plugins, SPA, navigation
 * Resources:          model binding, form/table/infolist schemas, pages, relation managers, global search
 * Widgets:            StatsOverview (Stat), Chart, Table widgets
 * Relation managers:  nested CRUD on parent resources
 * Custom pages:       standalone pages (extends Page), header/footer actions & widgets
 * Clusters:           resource grouping (extends Cluster, $cluster property)
 * Actions:            table/page/form/bulk actions (20+ built-in types)
 * Infolists:          read-only display entries (TextEntry, IconEntry, etc.)
 * Notifications:      flash, database, broadcast notifications
 * Importers/Exporters: CSV import/export (v3.1+/v3.2+)
 * Form layout:        Section, Tabs, Grid, Fieldset, Split, Wizard
 * Livewire interop:   HasForms, HasTable, HasActions, HasInfolists traits
 *
 * Edge types: filament_panel_resource, filament_panel_widget, filament_panel_page,
 * filament_panel_cluster, filament_panel_plugin, filament_panel_tenant,
 * filament_resource_model, filament_resource_page, filament_resource_relation,
 * filament_resource_action, filament_form_field, filament_form_layout,
 * filament_table_column, filament_table_filter, filament_table_action,
 * filament_infolist_entry, filament_relationship, filament_cluster_member,
 * filament_notification, filament_importer, filament_exporter.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// ── regex patterns ──────────────────────────────────────────────

// Panel provider
const PANEL_RESOURCES_RE = /->resources\(\s*\[([\s\S]*?)\]\s*\)/g;
const PANEL_PAGES_RE = /->pages\(\s*\[([\s\S]*?)\]\s*\)/g;
const PANEL_WIDGETS_RE = /->widgets\(\s*\[([\s\S]*?)\]\s*\)/g;
const PANEL_PLUGINS_RE = /->plugins\(\s*\[([\s\S]*?)\]\s*\)/g;
const PANEL_ID_RE = /->id\(\s*['"]([^'"]+)['"]\s*\)/;
const PANEL_PATH_RE = /->path\(\s*['"]([^'"]+)['"]\s*\)/;
const PANEL_TENANT_RE = /->tenant\(\s*([A-Z][\w\\]+)::class/;
const PANEL_SPA_RE = /->spa\(\)/;
const PANEL_TOP_NAV_RE = /->topNavigation\(\)/;
const PANEL_AUTH_RE = /->(login|registration|passwordReset|emailVerification|profile)\(\)/g;
const PANEL_DISCOVER_RE =
  /->discover(Resources|Pages|Widgets|Clusters)\(\s*in:\s*['"]([^'"]+)['"]\s*,\s*for:\s*['"]([^'"]+)['"]\s*\)/g;

// Resource
const RESOURCE_MODEL_RE = /protected\s+static\s+\??\s*string\s+\$model\s*=\s*([A-Z][\w\\]+)::class/;
const RESOURCE_PAGE_RE = /['"](\w+)['"]\s*=>\s*([\w\\]+)::route\(\s*['"]([^'"]+)['"]\s*\)/g;
const RELATION_CLASS_RE = /([\w\\]+RelationManager)::class/g;
const RESOURCE_CLUSTER_RE =
  /protected\s+static\s+\??\s*string\s+\$cluster\s*=\s*([A-Z][\w\\]+)::class/;
const RECORD_TITLE_ATTR_RE =
  /protected\s+static\s+\??\s*string\s+\$recordTitleAttribute\s*=\s*['"](\w+)['"]/;

// Navigation
const NAV_GROUP_RE = /protected\s+static\s+\??\s*string\s+\$navigationGroup\s*=\s*['"]([^'"]+)['"]/;
const NAV_ICON_RE = /protected\s+static\s+\??\s*string\s+\$navigationIcon\s*=\s*['"]([^'"]+)['"]/;
const NAV_LABEL_RE = /protected\s+static\s+\??\s*string\s+\$navigationLabel\s*=\s*['"]([^'"]+)['"]/;
const NAV_SORT_RE = /protected\s+static\s+\??\s*int\s+\$navigationSort\s*=\s*(\d+)/;
const NAV_PARENT_RE =
  /protected\s+static\s+\??\s*string\s+\$navigationParentItem\s*=\s*['"]([^'"]+)['"]/;

// Relation manager
const RELATION_NAME_RE = /protected\s+static\s+string\s+\$relationship\s*=\s*['"](\w+)['"]/;

// Form fields — all Filament v3 field components
const FORM_FIELD_COMPONENTS = new Set([
  'TextInput',
  'Select',
  'Textarea',
  'Toggle',
  'ToggleButtons',
  'Checkbox',
  'CheckboxList',
  'Radio',
  'DatePicker',
  'DateTimePicker',
  'TimePicker',
  'FileUpload',
  'RichEditor',
  'MarkdownEditor',
  'ColorPicker',
  'KeyValue',
  'Repeater',
  'Builder',
  'Hidden',
  'TagsInput',
  'MorphToSelect',
  'SpatieMediaLibraryFileUpload',
  'SpatieTagsInput',
]);

// Form layout components
const FORM_LAYOUT_COMPONENTS = new Set([
  'Section',
  'Tabs',
  'Tab',
  'Grid',
  'Fieldset',
  'Split',
  'Wizard',
  'Step',
  'Group',
  'Placeholder',
]);

// Table columns — all Filament v3 column types
const TABLE_COLUMN_COMPONENTS = new Set([
  'TextColumn',
  'IconColumn',
  'ImageColumn',
  'ColorColumn',
  'SelectColumn',
  'ToggleColumn',
  'CheckboxColumn',
  'TextInputColumn',
  'SpatieMediaLibraryImageColumn',
  'SpatieTagsColumn',
  'ViewColumn',
]);

// Table filters
const TABLE_FILTER_COMPONENTS = new Set([
  'Filter',
  'SelectFilter',
  'TernaryFilter',
  'TrashedFilter',
  'QueryBuilder',
]);

// Actions — all Filament v3 action types
const ACTION_COMPONENTS = new Set([
  'Action',
  'CreateAction',
  'EditAction',
  'DeleteAction',
  'ViewAction',
  'ForceDeleteAction',
  'RestoreAction',
  'ReplicateAction',
  'ImportAction',
  'ExportAction',
  'AttachAction',
  'DetachAction',
  'AssociateAction',
  'DissociateAction',
  'BulkAction',
  'DeleteBulkAction',
  'ForceDeleteBulkAction',
  'RestoreBulkAction',
  'DetachBulkAction',
  'DissociateBulkAction',
  'ActionGroup',
  'BulkActionGroup',
]);

// Infolist entries
const INFOLIST_ENTRY_COMPONENTS = new Set([
  'TextEntry',
  'IconEntry',
  'ImageEntry',
  'ColorEntry',
  'KeyValueEntry',
  'RepeatableEntry',
  'ViewEntry',
]);

// Generic ::make('name') extractor
const MAKE_CALL_RE = /(\w+)::make\(\s*['"]([^'"]*)['"]\s*\)/g;

// ->actions([...]) / ->headerActions([...]) / ->bulkActions([...])
const TABLE_ACTIONS_RE = /->actions\(\s*\[([\s\S]*?)\]\s*\)/g;
const TABLE_HEADER_ACTIONS_RE = /->headerActions\(\s*\[([\s\S]*?)\]\s*\)/g;
const TABLE_BULK_ACTIONS_RE = /->bulkActions\(\s*\[([\s\S]*?)\]\s*\)/g;

// Relationship calls
const RELATIONSHIP_CALL_RE = /->relationship\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*\)/g;

// Notification usage (non-global — only used with .test())
const NOTIFICATION_RE = /Notification::make\(\)/;
const NOTIFICATION_DB_RE = /->sendToDatabase\(/;
const NOTIFICATION_BROADCAST_RE = /->broadcast\(/;

// Importer / Exporter
const IMPORTER_MODEL_RE = /protected\s+static\s+\??\s*string\s+\$model\s*=\s*([A-Z][\w\\]+)::class/;
const IMPORT_COLUMN_RE = /ImportColumn::make\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXPORT_COLUMN_RE = /ExportColumn::make\(\s*['"]([^'"]+)['"]\s*\)/g;

// Livewire interop traits
const LIVEWIRE_TRAITS_RE =
  /use\s+(InteractsWithForms|InteractsWithTable|InteractsWithActions|InteractsWithInfolists)/g;
const LIVEWIRE_CONTRACTS_RE = /implements\s+[\w\\,\s]*(HasForms|HasTable|HasActions|HasInfolists)/g;

// Class reference list items
const CLASS_REF_RE = /([\w\\]+)::class/g;

// ── helpers ─────────────────────────────────────────────────────

function extractClassRefs(block: string): string[] {
  const refs: string[] = [];
  for (const m of block.matchAll(CLASS_REF_RE)) {
    refs.push(m[1]);
  }
  return refs;
}

function shortClass(fqcn: string): string {
  const parts = fqcn.split('\\');
  return parts[parts.length - 1];
}

function extractActionNames(block: string): string[] {
  const names: string[] = [];
  for (const m of block.matchAll(MAKE_CALL_RE)) {
    if (ACTION_COMPONENTS.has(m[1])) {
      names.push(m[2] || m[1]); // use explicit name or class name
    }
  }
  return names;
}

// ── detection helpers ───────────────────────────────────────────

const FILAMENT_IMPORTS = [
  'Filament\\Resources\\Resource',
  'Filament\\PanelProvider',
  'Filament\\Panel',
  'Filament\\Widgets\\',
  'Filament\\Forms\\',
  'Filament\\Tables\\',
  'Filament\\Infolists\\',
  'Filament\\Actions\\',
  'Filament\\Notifications\\',
  'Filament\\Resources\\RelationManagers\\RelationManager',
  'Filament\\Pages\\Page',
  'Filament\\Clusters\\Cluster',
  'Filament\\Actions\\Imports\\Importer',
  'Filament\\Actions\\Exports\\Exporter',
];

function isFilamentFile(source: string): boolean {
  return FILAMENT_IMPORTS.some((imp) => source.includes(imp));
}

// ── plugin ──────────────────────────────────────────────────────

export class FilamentPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'filament',
    version: '2.0.0',
    priority: 25, // after laravel (20)
    category: 'framework',
    dependencies: ['laravel'],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.composerJson) {
      const require = (ctx.composerJson.require ?? {}) as Record<string, string>;
      if ('filament/filament' in require) return true;
    }

    try {
      const composerPath = path.join(ctx.rootPath, 'composer.json');
      const content = JSON.parse(fs.readFileSync(composerPath, 'utf-8'));
      const require = (content.require ?? {}) as Record<string, string>;
      return 'filament/filament' in require;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        // Panel
        {
          name: 'filament_panel_resource',
          category: 'filament',
          description: 'Panel registers a resource',
        },
        {
          name: 'filament_panel_widget',
          category: 'filament',
          description: 'Panel registers a widget',
        },
        {
          name: 'filament_panel_page',
          category: 'filament',
          description: 'Panel registers a page',
        },
        {
          name: 'filament_panel_cluster',
          category: 'filament',
          description: 'Panel discovers a cluster',
        },
        {
          name: 'filament_panel_plugin',
          category: 'filament',
          description: 'Panel registers a plugin',
        },
        {
          name: 'filament_panel_tenant',
          category: 'filament',
          description: 'Panel uses tenant model',
        },
        // Resource
        {
          name: 'filament_resource_model',
          category: 'filament',
          description: 'Resource binds to Eloquent model',
        },
        {
          name: 'filament_resource_page',
          category: 'filament',
          description: 'Resource declares a page route',
        },
        {
          name: 'filament_resource_relation',
          category: 'filament',
          description: 'Resource uses a relation manager',
        },
        {
          name: 'filament_resource_action',
          category: 'filament',
          description: 'Resource/table/page action',
        },
        // Form
        { name: 'filament_form_field', category: 'filament', description: 'Form schema field' },
        {
          name: 'filament_form_layout',
          category: 'filament',
          description: 'Form layout component (Section, Tabs, etc.)',
        },
        // Table
        {
          name: 'filament_table_column',
          category: 'filament',
          description: 'Table column definition',
        },
        {
          name: 'filament_table_filter',
          category: 'filament',
          description: 'Table filter definition',
        },
        {
          name: 'filament_table_action',
          category: 'filament',
          description: 'Table row/header/bulk action',
        },
        // Infolist
        {
          name: 'filament_infolist_entry',
          category: 'filament',
          description: 'Infolist display entry',
        },
        // Relations
        {
          name: 'filament_relationship',
          category: 'filament',
          description: 'Field references an Eloquent relationship',
        },
        // Cluster
        {
          name: 'filament_cluster_member',
          category: 'filament',
          description: 'Resource/page belongs to a cluster',
        },
        // Notification
        {
          name: 'filament_notification',
          category: 'filament',
          description: 'Sends a notification',
        },
        // Import / Export
        { name: 'filament_importer', category: 'filament', description: 'CSV importer definition' },
        { name: 'filament_exporter', category: 'filament', description: 'CSV exporter definition' },
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
    if (!isFilamentFile(source)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    // ── Panel Provider ──────────────────────────────────────────
    if (source.includes('extends PanelProvider')) {
      result.frameworkRole = 'filament_panel_provider';

      const panelIdMatch = PANEL_ID_RE.exec(source);
      const panelPathMatch = PANEL_PATH_RE.exec(source);

      const authFeatures: string[] = [];
      for (const m of source.matchAll(PANEL_AUTH_RE)) authFeatures.push(m[1]);

      result.metadata = {
        panelId: panelIdMatch?.[1] ?? null,
        panelPath: panelPathMatch?.[1] ?? null,
        spa: PANEL_SPA_RE.test(source),
        topNavigation: PANEL_TOP_NAV_RE.test(source),
        authFeatures: authFeatures.length > 0 ? authFeatures : undefined,
      };

      // Resources
      for (const m of source.matchAll(PANEL_RESOURCES_RE)) {
        for (const cls of extractClassRefs(m[1])) {
          result.edges!.push({
            source: filePath,
            target: shortClass(cls),
            edgeType: 'filament_panel_resource',
            metadata: { class: cls },
          });
        }
      }

      // Pages
      for (const m of source.matchAll(PANEL_PAGES_RE)) {
        for (const cls of extractClassRefs(m[1])) {
          result.edges!.push({
            source: filePath,
            target: shortClass(cls),
            edgeType: 'filament_panel_page',
            metadata: { class: cls },
          });
        }
      }

      // Widgets
      for (const m of source.matchAll(PANEL_WIDGETS_RE)) {
        for (const cls of extractClassRefs(m[1])) {
          result.edges!.push({
            source: filePath,
            target: shortClass(cls),
            edgeType: 'filament_panel_widget',
            metadata: { class: cls },
          });
        }
      }

      // Plugins
      for (const m of source.matchAll(PANEL_PLUGINS_RE)) {
        // plugin instances: new SomePlugin(), SomePlugin::make()
        for (const cls of m[1].matchAll(/new\s+(\w+)\s*\(|(\w+)::make\s*\(/g)) {
          const name = cls[1] ?? cls[2];
          if (name) {
            result.edges!.push({
              source: filePath,
              target: name,
              edgeType: 'filament_panel_plugin',
              metadata: { plugin: name },
            });
          }
        }
      }

      // Tenancy
      const tenantMatch = PANEL_TENANT_RE.exec(source);
      if (tenantMatch) {
        result.edges!.push({
          source: filePath,
          target: shortClass(tenantMatch[1]),
          edgeType: 'filament_panel_tenant',
          metadata: { model: tenantMatch[1] },
        });
        result.metadata.tenantModel = tenantMatch[1];
      }

      // Discovery patterns
      for (const m of source.matchAll(PANEL_DISCOVER_RE)) {
        const kind = m[1].toLowerCase(); // Resources, Pages, Widgets, Clusters
        result.edges!.push({
          source: filePath,
          target: m[2],
          edgeType:
            kind === 'clusters'
              ? 'filament_panel_cluster'
              : kind === 'resources'
                ? 'filament_panel_resource'
                : kind === 'pages'
                  ? 'filament_panel_page'
                  : 'filament_panel_widget',
          metadata: { discovery: true, directory: m[2], namespace: m[3] },
        });
      }
    }

    // ── Resource ────────────────────────────────────────────────
    if (source.includes('extends Resource')) {
      result.frameworkRole = 'filament_resource';

      // Model binding
      const modelMatch = RESOURCE_MODEL_RE.exec(source);
      if (modelMatch) {
        result.edges!.push({
          source: filePath,
          target: shortClass(modelMatch[1]),
          edgeType: 'filament_resource_model',
          metadata: { model: modelMatch[1] },
        });
      }

      // Global search
      const titleAttr = RECORD_TITLE_ATTR_RE.exec(source);
      if (titleAttr) {
        result.metadata = {
          ...result.metadata,
          recordTitleAttribute: titleAttr[1],
          globalSearch: true,
        };
      }

      // Cluster membership
      const clusterMatch = RESOURCE_CLUSTER_RE.exec(source);
      if (clusterMatch) {
        result.edges!.push({
          source: filePath,
          target: shortClass(clusterMatch[1]),
          edgeType: 'filament_cluster_member',
          metadata: { cluster: clusterMatch[1] },
        });
      }

      // Resource pages
      for (const m of source.matchAll(RESOURCE_PAGE_RE)) {
        result.edges!.push({
          source: filePath,
          target: shortClass(m[2]),
          edgeType: 'filament_resource_page',
          metadata: { slug: m[1], route: m[3], page: m[2] },
        });
      }

      // Relation managers
      for (const m of source.matchAll(RELATION_CLASS_RE)) {
        result.edges!.push({
          source: filePath,
          target: shortClass(m[1]),
          edgeType: 'filament_resource_relation',
          metadata: { class: m[1] },
        });
      }

      // Navigation metadata
      this.extractNavigationMeta(source, result);

      // Shared extraction for forms, tables, infolists, actions
      this.extractComponentEdges(source, filePath, result);
    }

    // ── Custom Page (requires Filament\Pages\Page import) ────────
    if (
      source.includes('extends Page') &&
      source.includes('Filament\\Pages\\Page') &&
      !source.includes('extends PanelProvider')
    ) {
      result.frameworkRole = result.frameworkRole ?? 'filament_page';

      // Navigation metadata
      this.extractNavigationMeta(source, result);

      // Cluster membership
      const clusterMatch = RESOURCE_CLUSTER_RE.exec(source);
      if (clusterMatch) {
        result.edges!.push({
          source: filePath,
          target: shortClass(clusterMatch[1]),
          edgeType: 'filament_cluster_member',
          metadata: { cluster: clusterMatch[1] },
        });
      }
    }

    // ── Resource sub-pages (ListRecords, CreateRecord, EditRecord, ViewRecord, ManageRecords) ──
    if (/extends\s+(ListRecords|CreateRecord|EditRecord|ViewRecord|ManageRecords)/.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'filament_resource_page';
      this.extractComponentEdges(source, filePath, result);
    }

    // ── Cluster ─────────────────────────────────────────────────
    if (source.includes('extends Cluster')) {
      result.frameworkRole = 'filament_cluster';
      this.extractNavigationMeta(source, result);
    }

    // ── Relation Manager ────────────────────────────────────────
    if (source.includes('extends RelationManager')) {
      result.frameworkRole = 'filament_relation_manager';

      const relMatch = RELATION_NAME_RE.exec(source);
      if (relMatch) {
        result.metadata = { ...result.metadata, relationship: relMatch[1] };
      }

      this.extractComponentEdges(source, filePath, result);
    }

    // ── Widget ──────────────────────────────────────────────────
    if (/extends\s+(StatsOverviewWidget|ChartWidget|Widget|TableWidget)/.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'filament_widget';

      // Chart type
      const chartType =
        /protected\s+function\s+getType\(\)\s*:\s*string\s*\{[^}]*return\s+['"](\w+)['"]/.exec(
          source,
        );
      if (chartType) {
        result.metadata = { ...result.metadata, chartType: chartType[1] };
      }

      // Polling interval
      const polling =
        /protected\s+static\s+\??\s*string\s+\$pollingInterval\s*=\s*['"]([^'"]+)['"]/.exec(source);
      if (polling) {
        result.metadata = { ...result.metadata, pollingInterval: polling[1] };
      }

      this.extractComponentEdges(source, filePath, result);
    }

    // ── Importer ────────────────────────────────────────────────
    if (source.includes('extends Importer')) {
      result.frameworkRole = 'filament_importer';

      const modelMatch = IMPORTER_MODEL_RE.exec(source);
      if (modelMatch) {
        result.edges!.push({
          source: filePath,
          target: shortClass(modelMatch[1]),
          edgeType: 'filament_importer',
          metadata: { model: modelMatch[1] },
        });
      }

      const columns: string[] = [];
      for (const m of source.matchAll(IMPORT_COLUMN_RE)) columns.push(m[1]);
      if (columns.length > 0) {
        result.metadata = { ...result.metadata, importColumns: columns };
      }
    }

    // ── Exporter ────────────────────────────────────────────────
    if (source.includes('extends Exporter')) {
      result.frameworkRole = 'filament_exporter';

      const modelMatch = IMPORTER_MODEL_RE.exec(source);
      if (modelMatch) {
        result.edges!.push({
          source: filePath,
          target: shortClass(modelMatch[1]),
          edgeType: 'filament_exporter',
          metadata: { model: modelMatch[1] },
        });
      }

      const columns: string[] = [];
      for (const m of source.matchAll(EXPORT_COLUMN_RE)) columns.push(m[1]);
      if (columns.length > 0) {
        result.metadata = { ...result.metadata, exportColumns: columns };
      }
    }

    // ── Notifications ───────────────────────────────────────────
    if (NOTIFICATION_RE.test(source)) {
      const notifType = NOTIFICATION_DB_RE.test(source)
        ? 'database'
        : NOTIFICATION_BROADCAST_RE.test(source)
          ? 'broadcast'
          : 'flash';
      result.edges!.push({
        source: filePath,
        target: 'Notification',
        edgeType: 'filament_notification',
        metadata: { type: notifType },
      });
    }

    // ── Livewire interop ────────────────────────────────────────
    const traits: string[] = [];
    for (const m of source.matchAll(LIVEWIRE_TRAITS_RE)) traits.push(m[1]);
    for (const m of source.matchAll(LIVEWIRE_CONTRACTS_RE)) traits.push(m[1]);
    if (traits.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'filament_livewire';
      result.metadata = { ...result.metadata, filamentTraits: [...new Set(traits)] };
      // If it has HasTable/HasForms, extract component edges
      this.extractComponentEdges(source, filePath, result);
    }

    return ok(result);
  }

  /** Extract form fields, layout, table columns/filters/actions, infolist entries, and actions from source */
  private extractComponentEdges(source: string, filePath: string, result: FileParseResult): void {
    for (const m of source.matchAll(MAKE_CALL_RE)) {
      const component = m[1];
      const name = m[2];

      if (FORM_FIELD_COMPONENTS.has(component)) {
        result.edges!.push({
          source: filePath,
          target: name,
          edgeType: 'filament_form_field',
          metadata: { component, field: name },
        });
      } else if (FORM_LAYOUT_COMPONENTS.has(component)) {
        result.edges!.push({
          source: filePath,
          target: name,
          edgeType: 'filament_form_layout',
          metadata: { component, label: name },
        });
      } else if (TABLE_COLUMN_COMPONENTS.has(component)) {
        result.edges!.push({
          source: filePath,
          target: name,
          edgeType: 'filament_table_column',
          metadata: { component, column: name },
        });
      } else if (TABLE_FILTER_COMPONENTS.has(component)) {
        result.edges!.push({
          source: filePath,
          target: name,
          edgeType: 'filament_table_filter',
          metadata: { component, filter: name },
        });
      } else if (ACTION_COMPONENTS.has(component)) {
        result.edges!.push({
          source: filePath,
          target: name || component,
          edgeType: 'filament_resource_action',
          metadata: { component, action: name || component },
        });
      } else if (INFOLIST_ENTRY_COMPONENTS.has(component)) {
        result.edges!.push({
          source: filePath,
          target: name,
          edgeType: 'filament_infolist_entry',
          metadata: { component, entry: name },
        });
      }
    }

    // Table-level action blocks (->actions([...]), ->headerActions([...]), ->bulkActions([...]))
    for (const m of source.matchAll(TABLE_ACTIONS_RE)) {
      for (const name of extractActionNames(m[1])) {
        result.edges!.push({
          source: filePath,
          target: name,
          edgeType: 'filament_table_action',
          metadata: { scope: 'row', action: name },
        });
      }
    }
    for (const m of source.matchAll(TABLE_HEADER_ACTIONS_RE)) {
      for (const name of extractActionNames(m[1])) {
        result.edges!.push({
          source: filePath,
          target: name,
          edgeType: 'filament_table_action',
          metadata: { scope: 'header', action: name },
        });
      }
    }
    for (const m of source.matchAll(TABLE_BULK_ACTIONS_RE)) {
      for (const name of extractActionNames(m[1])) {
        result.edges!.push({
          source: filePath,
          target: name,
          edgeType: 'filament_table_action',
          metadata: { scope: 'bulk', action: name },
        });
      }
    }

    // Relationship calls on form fields
    for (const m of source.matchAll(RELATIONSHIP_CALL_RE)) {
      result.edges!.push({
        source: filePath,
        target: m[1],
        edgeType: 'filament_relationship',
        metadata: { relationship: m[1], display: m[2] },
      });
    }
  }

  /** Extract navigation metadata from a resource, page, or cluster */
  private extractNavigationMeta(source: string, result: FileParseResult): void {
    const nav: Record<string, string | number | undefined> = {};
    const g = NAV_GROUP_RE.exec(source);
    if (g) nav.navigationGroup = g[1];
    const i = NAV_ICON_RE.exec(source);
    if (i) nav.navigationIcon = i[1];
    const l = NAV_LABEL_RE.exec(source);
    if (l) nav.navigationLabel = l[1];
    const s = NAV_SORT_RE.exec(source);
    if (s) nav.navigationSort = parseInt(s[1], 10);
    const p = NAV_PARENT_RE.exec(source);
    if (p) nav.navigationParentItem = p[1];
    if (Object.keys(nav).length > 0) {
      result.metadata = { ...result.metadata, ...nav };
    }
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
