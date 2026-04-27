/**
 * Laravel Nova extraction (v2–v5).
 *
 * Extracts:
 * - Resource → Eloquent Model ($model property)
 * - Relationship fields (BelongsTo/HasMany/HasOne/MorphMany/etc.) → target Nova Resource
 * - Actions, Filters, Lenses registered on Resource
 * - Metrics → queried Eloquent Model
 *
 * Version differences handled:
 * - v2–v3: single fields() method (flat array)
 * - v4–v5: fields() + fieldsForIndex/Detail/Create/Update + Panel::make([...fields...])
 */
import type { RawEdge, FileParseResult, ResolveContext } from '../../../../../plugin-api/types.js';
import { escapeRegExp } from '../../../../../utils/security.js';

// ─── Interfaces ──────────────────────────────────────────────

interface NovaResourceInfo {
  className: string;
  namespace: string;
  fqn: string;
  /** Eloquent model FQN from `public static $model = Model::class` */
  modelFqn: string | null;
  /** Nova relationship fields pointing to other Nova Resources */
  fieldRelationships: NovaFieldRelationship[];
  /** Action classes registered via actions() */
  actions: string[];
  /** Filter classes registered via filters() */
  filters: string[];
  /** Lens classes registered via lenses() */
  lenses: string[];
  /** Metric classes registered via cards() / metrics() */
  metrics: string[];
}

interface NovaFieldRelationship {
  /** Field type: BelongsTo, HasMany, HasOne, MorphMany, MorphTo, MorphToMany */
  fieldType: string;
  /** Label string */
  label: string;
  /** Attribute/relation name */
  attribute: string;
  /** Target Nova Resource FQN (third arg of ::make()) */
  targetResourceFqn: string;
}

interface NovaMetricInfo {
  className: string;
  namespace: string;
  fqn: string;
  /** Eloquent models queried in calculate() via $this->count/trend/partition(req, Model::class) */
  queriedModels: string[];
}

// ─── Relationship field types (stable v2→v5) ─────────────────

const RELATIONSHIP_FIELDS = new Set([
  'BelongsTo',
  'HasMany',
  'HasOne',
  'HasOneThrough',
  'HasManyThrough',
  'BelongsToMany',
  'MorphTo',
  'MorphMany',
  'MorphOne',
  'MorphToMany',
]);

const METRIC_BASES = new Set(['Value', 'Trend', 'Partition', 'Progress']);

// ─── Detection regexes ────────────────────────────────────────

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_NAME_RE = /class\s+(\w+)/;
const USE_STMT_RE = /use\s+([\w\\]+?)(?:\s+as\s+(\w+))?;/g;

const EXTENDS_RESOURCE_RE = /class\s+\w+\s+extends\s+(?:[\w\\]*\\)?Resource\b/;
const _EXTENDS_ACTION_RE = /class\s+\w+\s+extends\s+(?:[\w\\]*\\)?Action\b/;
const _EXTENDS_FILTER_RE = /class\s+\w+\s+extends\s+(?:[\w\\]*\\)?Filter\b/;
const _EXTENDS_LENS_RE = /class\s+\w+\s+extends\s+(?:[\w\\]*\\)?Lens\b/;
const EXTENDS_METRIC_RE = new RegExp(
  `class\\s+\\w+\\s+extends\\s+(?:[\\w\\\\]*\\\\)?(?:${[...METRIC_BASES].join('|')})\\b`,
);

// ─── Resource extraction ──────────────────────────────────────

export function extractNovaResource(source: string, _filePath: string): NovaResourceInfo | null {
  if (!EXTENDS_RESOURCE_RE.test(source)) return null;

  // Exclude Filament/Moonshine/Backpack resources that also extend Resource
  const parentMatch = source.match(/class\s+\w+\s+extends\s+([\w\\]+)/);
  if (parentMatch && /Filament|Moonshine|Backpack/i.test(parentMatch[1])) return null;

  const useMap = buildUseMap(source);
  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  // $model property: public static $model = Model::class;
  const modelMatch = source.match(/public\s+static\s+\$model\s*=\s*([\w\\]+)::class/);
  const modelFqn = modelMatch ? resolveClass(modelMatch[1], useMap) : null;

  // Collect all field method bodies (v2–v3: fields(), v4–v5: + fieldsFor*)
  const fieldBodies = collectFieldBodies(source);
  const fieldRelationships = extractFieldRelationships(fieldBodies, useMap);

  // actions() / filters() / lenses()
  const actions = extractRegisteredClasses(source, 'actions', useMap);
  const filters = extractRegisteredClasses(source, 'filters', useMap);
  const lenses = extractRegisteredClasses(source, 'lenses', useMap);

  // cards() / metrics() — both are used for metrics
  const metrics = [
    ...extractRegisteredClasses(source, 'cards', useMap),
    ...extractRegisteredClasses(source, 'metrics', useMap),
  ];

  return {
    className,
    namespace,
    fqn,
    modelFqn,
    fieldRelationships,
    actions,
    filters,
    lenses,
    metrics,
  };
}

// ─── Metric extraction ────────────────────────────────────────

export function extractNovaMetric(source: string, _filePath: string): NovaMetricInfo | null {
  if (!EXTENDS_METRIC_RE.test(source)) return null;

  const useMap = buildUseMap(source);
  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  // $this->count($request, Model::class) / $this->trend / $this->partition / $this->countByDays
  const queriedModels = extractMetricModels(source, useMap);

  return { className, namespace, fqn, queriedModels };
}

// ─── Node & edge processing (called from LaravelPlugin) ──────

/** Pass-1: extract Nova metadata edges from a single file. */
export function processNovaNode(source: string, filePath: string, result: FileParseResult): void {
  result.edges = result.edges ?? [];

  const resource = extractNovaResource(source, filePath);
  if (resource) {
    result.frameworkRole = 'nova_resource';
    result.edges.push(...buildNovaResourceEdges(resource));
    return;
  }

  const metric = extractNovaMetric(source, filePath);
  if (metric) {
    result.frameworkRole = 'nova_metric';
    result.edges.push(...buildNovaMetricEdges(metric));
  }
}

/** Pass-2: resolve Nova symbol-level edges using the full index. */
export function resolveNovaEdges(
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
        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: sourceSymbol.id,
          targetNodeType: 'symbol',
          targetRefId: modelSymbol.id,
          edgeType: 'nova_resource_for',
        });
      }
    }
    for (const rel of resource.fieldRelationships) {
      const targetSymbol = ctx.getSymbolByFqn(rel.targetResourceFqn);
      if (targetSymbol) {
        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: sourceSymbol.id,
          targetNodeType: 'symbol',
          targetRefId: targetSymbol.id,
          edgeType: 'nova_field_relationship',
          metadata: { fieldType: rel.fieldType },
        });
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
        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: metricSymbol.id,
          targetNodeType: 'symbol',
          targetRefId: modelSymbol.id,
          edgeType: 'nova_metric_queries',
        });
      }
    }
  }
}

// ─── Edge builders (used by processNovaNode) ─────────────────

function buildNovaResourceEdges(resource: NovaResourceInfo): RawEdge[] {
  const edges: RawEdge[] = [];

  if (resource.modelFqn) {
    edges.push({
      edgeType: 'nova_resource_for',
      metadata: { sourceFqn: resource.fqn, targetFqn: resource.modelFqn },
    });
  }

  for (const rel of resource.fieldRelationships) {
    edges.push({
      edgeType: 'nova_field_relationship',
      metadata: {
        sourceFqn: resource.fqn,
        targetFqn: rel.targetResourceFqn,
        fieldType: rel.fieldType,
        label: rel.label,
        attribute: rel.attribute,
      },
    });
  }

  for (const actionFqn of resource.actions) {
    edges.push({
      edgeType: 'nova_action_on',
      metadata: { sourceFqn: actionFqn, targetFqn: resource.fqn },
    });
  }

  for (const filterFqn of resource.filters) {
    edges.push({
      edgeType: 'nova_filter_on',
      metadata: { sourceFqn: filterFqn, targetFqn: resource.fqn },
    });
  }

  for (const lensFqn of resource.lenses) {
    edges.push({
      edgeType: 'nova_lens_on',
      metadata: { sourceFqn: lensFqn, targetFqn: resource.fqn },
    });
  }

  return edges;
}

function buildNovaMetricEdges(metric: NovaMetricInfo): RawEdge[] {
  return metric.queriedModels.map((modelFqn) => ({
    edgeType: 'nova_metric_queries',
    metadata: { sourceFqn: metric.fqn, targetFqn: modelFqn },
  }));
}

// ─── Internal helpers ─────────────────────────────────────────

function buildUseMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = new RegExp(USE_STMT_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const fqn = match[1];
    const alias = match[2] ?? fqn.split('\\').pop()!;
    map.set(alias, fqn);
  }
  return map;
}

function resolveClass(ref: string, useMap: Map<string, string>): string {
  const clean = ref.startsWith('\\') ? ref.slice(1) : ref;
  if (clean.includes('\\')) return clean;
  return useMap.get(clean) ?? clean;
}

/**
 * Collect the bodies of fields() and fieldsFor*() methods.
 * v4+: also handles Panel::make('label', [...fields...]) nesting.
 */
function collectFieldBodies(source: string): string {
  const FIELD_METHODS = [
    'fields',
    'fieldsForIndex',
    'fieldsForDetail',
    'fieldsForCreate',
    'fieldsForUpdate',
  ];
  const parts: string[] = [];

  for (const method of FIELD_METHODS) {
    const re = new RegExp(`function\\s+${escapeRegExp(method)}\\s*\\([^)]*\\)[^{]*\\{`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const openBrace = source.indexOf('{', match.index + match[0].length - 1);
      const body = extractBraceBody(source, openBrace);
      parts.push(body);
    }
  }

  return parts.join('\n');
}

/**
 * Extract relationship fields from collected field method bodies.
 * Pattern: BelongsTo::make('Label', 'attribute', ResourceClass::class)
 */
function extractFieldRelationships(
  fieldBody: string,
  useMap: Map<string, string>,
): NovaFieldRelationship[] {
  const results: NovaFieldRelationship[] = [];

  // Match: FieldType::make('Label', 'attribute', ResourceClass::class)
  // The third arg may be omitted (e.g. BelongsTo only needs resource class)
  const re = /(\w+)::make\(\s*['"]([^'"]+)['"]\s*,\s*['"]?(\w+)['"]?\s*,\s*([\w\\]+)::class/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(fieldBody)) !== null) {
    const fieldType = match[1];
    if (!RELATIONSHIP_FIELDS.has(fieldType)) continue;

    results.push({
      fieldType,
      label: match[2],
      attribute: match[3],
      targetResourceFqn: resolveClass(match[4], useMap),
    });
  }

  return results;
}

/**
 * Extract new ClassName() instances from a named method's return array.
 * Used for actions(), filters(), lenses(), cards(), metrics().
 */
function extractRegisteredClasses(
  source: string,
  method: string,
  useMap: Map<string, string>,
): string[] {
  const results: string[] = [];

  const methodRe = new RegExp(`function\\s+${escapeRegExp(method)}\\s*\\([^)]*\\)[^{]*\\{`, 'g');
  let mMatch: RegExpExecArray | null;
  while ((mMatch = methodRe.exec(source)) !== null) {
    const openBrace = source.indexOf('{', mMatch.index + mMatch[0].length - 1);
    const body = extractBraceBody(source, openBrace);

    // Match: new ClassName or new Namespace\ClassName
    const newRe = /new\s+([\w\\]+)\s*[,()\]]/g;
    let match: RegExpExecArray | null;
    while ((match = newRe.exec(body)) !== null) {
      results.push(resolveClass(match[1], useMap));
    }

    // Also match ClassName::class in arrays
    const classRe = /([\w\\]+)::class/g;
    while ((match = classRe.exec(body)) !== null) {
      const cls = match[1];
      if (!['static', 'self', 'parent'].includes(cls)) {
        results.push(resolveClass(cls, useMap));
      }
    }
  }

  // Deduplicate
  return [...new Set(results)];
}

/**
 * Extract Eloquent models referenced in calculate() via
 * $this->count($request, Model::class) etc.
 */
function extractMetricModels(source: string, useMap: Map<string, string>): string[] {
  const results: string[] = [];

  const re =
    /\$this->(?:count|trend|partition|countByDays|countByWeeks|countByMonths|sumByDays|averageByDays)\s*\([^,]+,\s*([\w\\]+)::class/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    results.push(resolveClass(match[1], useMap));
  }

  return [...new Set(results)];
}

function extractBraceBody(source: string, openPos: number): string {
  let depth = 0;
  let start = -1;
  for (let i = openPos; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
      if (depth === 1) start = i + 1;
    } else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  return source.slice(start);
}
