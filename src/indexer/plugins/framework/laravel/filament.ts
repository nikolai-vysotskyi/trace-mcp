/**
 * Filament v3 extraction.
 *
 * Extracts:
 * - Resource → Eloquent Model ($model property)
 * - Resource → RelationManager[] (getRelations())
 * - RelationManager $relationship → Eloquent relation name
 * - form/table ->relationship() calls → related Model
 * - PanelProvider → registered Resources/Pages/Widgets
 * - Widget $model / getStats() model references
 * - getPages() → Page class array
 */
import type { RawEdge } from '../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

export interface FilamentResourceInfo {
  className: string;
  namespace: string;
  fqn: string;
  /** Eloquent model FQN from `protected static ?string $model = Model::class` */
  modelFqn: string | null;
  relationManagers: string[];   // FQNs
  pages: FilamentPageRef[];
  formRelationships: FilamentRelRef[];
}

export interface FilamentPageRef {
  action: string;   // 'index' | 'create' | 'edit' | 'view'
  pageClass: string;
}

export interface FilamentRelRef {
  /** Relationship name string (e.g. 'role', 'posts') */
  relationName: string;
}

export interface FilamentRelationManagerInfo {
  className: string;
  namespace: string;
  fqn: string;
  /** Value of `protected static string $relationship = 'posts'` */
  relationshipName: string | null;
}

export interface FilamentPanelInfo {
  className: string;
  namespace: string;
  fqn: string;
  panelId: string | null;
  resources: string[];  // FQNs
  pages: string[];
  widgets: string[];
}

export interface FilamentWidgetInfo {
  className: string;
  namespace: string;
  fqn: string;
  /** Static $model property on TableWidget / ChartWidget */
  modelFqn: string | null;
  /** Model FQNs referenced in getStats() / getColumns() */
  queriedModels: string[];
}

// ─── Detection helpers ────────────────────────────────────────

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_NAME_RE = /class\s+(\w+)/;
const USE_STMT_RE = /use\s+([\w\\]+?)(?:\s+as\s+(\w+))?;/g;

const EXTENDS_RESOURCE_RE = /class\s+\w+\s+extends\s+(?:[\w\\]*\\)?Resource\b/;
const EXTENDS_RELATION_MANAGER_RE = /class\s+\w+\s+extends\s+(?:[\w\\]*\\)?RelationManager\b/;
const EXTENDS_PANEL_PROVIDER_RE = /class\s+\w+\s+extends\s+(?:[\w\\]*\\)?PanelProvider\b/;
const EXTENDS_WIDGET_RE = /class\s+\w+\s+extends\s+(?:[\w\\]*\\)?(?:StatsOverviewWidget|TableWidget|ChartWidget|Widget)\b/;

// ─── Resource extraction ──────────────────────────────────────

/**
 * Extract Filament Resource metadata from a PHP source file.
 */
export function extractFilamentResource(
  source: string,
  _filePath: string,
): FilamentResourceInfo | null {
  if (!EXTENDS_RESOURCE_RE.test(source)) return null;

  const useMap = buildUseMap(source);
  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  const modelFqn = extractModelProperty(source, useMap);
  const relationManagers = extractRelationManagers(source, useMap);
  const pages = extractPages(source, useMap);
  const formRelationships = extractFormRelationships(source);

  return { className, namespace, fqn, modelFqn, relationManagers, pages, formRelationships };
}

// ─── RelationManager extraction ───────────────────────────────

export function extractFilamentRelationManager(
  source: string,
  _filePath: string,
): FilamentRelationManagerInfo | null {
  if (!EXTENDS_RELATION_MANAGER_RE.test(source)) return null;

  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  // protected static string $relationship = 'posts';
  const relMatch = source.match(
    /protected\s+static\s+(?:string\s+)?\$relationship\s*=\s*['"](\w+)['"]/,
  );
  const relationshipName = relMatch?.[1] ?? null;

  return { className, namespace, fqn, relationshipName };
}

// ─── PanelProvider extraction ─────────────────────────────────

export function extractFilamentPanel(
  source: string,
  _filePath: string,
): FilamentPanelInfo | null {
  if (!EXTENDS_PANEL_PROVIDER_RE.test(source)) return null;

  const useMap = buildUseMap(source);
  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  // ->id('admin')
  const idMatch = source.match(/->id\(\s*['"](\w+)['"]\s*\)/);
  const panelId = idMatch?.[1] ?? null;

  const resources = extractClassList(source, 'resources', useMap);
  const pages = extractClassList(source, 'pages', useMap);
  const widgets = extractClassList(source, 'widgets', useMap);

  return { className, namespace, fqn, panelId, resources, pages, widgets };
}

// ─── Widget extraction ────────────────────────────────────────

export function extractFilamentWidget(
  source: string,
  _filePath: string,
): FilamentWidgetInfo | null {
  if (!EXTENDS_WIDGET_RE.test(source)) return null;

  const useMap = buildUseMap(source);
  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  // Static $model on TableWidget / ChartWidget
  const modelFqn = extractModelProperty(source, useMap);

  // Models used in getStats() / getColumns() — Stat::make('X', Model::count())
  const queriedModels = extractQueriedModels(source, useMap);

  return { className, namespace, fqn, modelFqn, queriedModels };
}

// ─── Edge builders ────────────────────────────────────────────

export function buildFilamentResourceEdges(resource: FilamentResourceInfo): RawEdge[] {
  const edges: RawEdge[] = [];

  if (resource.modelFqn) {
    edges.push({
      edgeType: 'filament_resource_for',
      metadata: { sourceFqn: resource.fqn, targetFqn: resource.modelFqn },
    });
  }

  for (const rm of resource.relationManagers) {
    edges.push({
      edgeType: 'filament_relation_manager',
      metadata: { sourceFqn: resource.fqn, targetFqn: rm },
    });
  }

  for (const rel of resource.formRelationships) {
    edges.push({
      edgeType: 'filament_form_relationship',
      metadata: { sourceFqn: resource.fqn, relationName: rel.relationName },
    });
  }

  return edges;
}

export function buildFilamentPanelEdges(panel: FilamentPanelInfo): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const fqn of [...panel.resources, ...panel.pages, ...panel.widgets]) {
    edges.push({
      edgeType: 'filament_panel_registers',
      metadata: { sourceFqn: panel.fqn, targetFqn: fqn, panelId: panel.panelId },
    });
  }
  return edges;
}

export function buildFilamentWidgetEdges(widget: FilamentWidgetInfo): RawEdge[] {
  const edges: RawEdge[] = [];
  const targets = [
    ...(widget.modelFqn ? [widget.modelFqn] : []),
    ...widget.queriedModels,
  ];
  for (const modelFqn of [...new Set(targets)]) {
    edges.push({
      edgeType: 'filament_widget_queries',
      metadata: { sourceFqn: widget.fqn, targetFqn: modelFqn },
    });
  }
  return edges;
}

// ─── Internal helpers ─────────────────────────────────────────

function buildUseMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const regex = new RegExp(USE_STMT_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const fqn = match[1];
    const alias = match[2] ?? fqn.split('\\').pop()!;
    map.set(alias, fqn);
  }
  return map;
}

function resolveClass(ref: string, useMap: Map<string, string>): string {
  if (ref.includes('\\')) return ref;
  return useMap.get(ref) ?? ref;
}

/** Extract `protected static ?string $model = SomeModel::class` */
function extractModelProperty(source: string, useMap: Map<string, string>): string | null {
  const match = source.match(
    /protected\s+static\s+(?:\?string\s+)?\$model\s*=\s*([\w\\]+)::class/,
  );
  if (!match) return null;
  return resolveClass(match[1], useMap);
}

/** Extract getRelations() return array → array of RelationManager FQNs */
function extractRelationManagers(source: string, useMap: Map<string, string>): string[] {
  const results: string[] = [];

  // Find getRelations() method body
  const methodMatch = source.match(/function\s+getRelations\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);
  if (!methodMatch) return results;

  const body = methodMatch[1];
  // Match: SomeRelationManager::class
  const classRe = /([\w\\]+)::class/g;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(body)) !== null) {
    results.push(resolveClass(match[1], useMap));
  }
  return results;
}

/** Extract getPages() return array → array of page refs */
function extractPages(source: string, useMap: Map<string, string>): FilamentPageRef[] {
  const results: FilamentPageRef[] = [];

  const methodMatch = source.match(/function\s+getPages\s*\([^)]*\)[^{]*\{([\s\S]*?)\}/);
  if (!methodMatch) return results;

  const body = methodMatch[1];
  // 'index' => Pages\ListUsers::route('/'),
  const pairRe = /['"](\w+)['"]\s*=>\s*([\w\\]+)::route\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pairRe.exec(body)) !== null) {
    results.push({
      action: match[1],
      pageClass: resolveClass(match[2], useMap),
    });
  }
  return results;
}

/** Extract ->relationship('name', ...) calls in form/table methods */
function extractFormRelationships(source: string): FilamentRelRef[] {
  const results: FilamentRelRef[] = [];
  const re = /->relationship\(\s*['"](\w+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    results.push({ relationName: match[1] });
  }
  // Deduplicate
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.relationName)) return false;
    seen.add(r.relationName);
    return true;
  });
}

/** Extract array of class FQNs from ->resources([...]) / ->pages([...]) / ->widgets([...]) */
function extractClassList(
  source: string,
  method: string,
  useMap: Map<string, string>,
): string[] {
  const results: string[] = [];
  // ->resources([ ... ]) — allow multiline
  const methodRe = new RegExp(`->${method}\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`, 'g');
  let mMatch: RegExpExecArray | null;
  while ((mMatch = methodRe.exec(source)) !== null) {
    const block = mMatch[1];
    const classRe = /([\w\\]+)::class/g;
    let match: RegExpExecArray | null;
    while ((match = classRe.exec(block)) !== null) {
      results.push(resolveClass(match[1], useMap));
    }
  }
  return results;
}

/** Extract Model FQNs used inside getStats() / getColumns() as Model::count(), Model::query(), etc. */
function extractQueriedModels(source: string, useMap: Map<string, string>): string[] {
  const results: string[] = [];

  // Find getStats or getColumns method body
  const methodMatch = source.match(
    /function\s+get(?:Stats|Columns|Data)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s*\}/,
  );
  if (!methodMatch) return results;

  const body = methodMatch[1];
  // Model::count(), Model::where(...), Model::query()
  const re = /([\w\\]+)::\s*(?:count|where|query|latest|all)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const cls = match[1];
    if (['DB', 'Schema', 'Str', 'Carbon', 'Cache', 'Log'].includes(cls)) continue;
    results.push(resolveClass(cls, useMap));
  }

  return [...new Set(results)];
}
