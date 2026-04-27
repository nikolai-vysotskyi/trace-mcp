/**
 * Antipattern detector — static analysis of the indexed dependency graph
 * to find N+1 query risks, missing eager loads, unbounded queries,
 * event listener leaks, circular model dependencies, and missing indexes.
 */

import picomatch from 'picomatch';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../errors.js';
import type { Store, OrmModelRow, OrmAssociationRow, FileRow } from '../../db/store.js';
import {
  classifyNumericConfidence,
  type ConfidenceLevel,
  type Methodology,
} from '../shared/confidence.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AntipatternCategory =
  | 'n_plus_one_risk'
  | 'missing_eager_load'
  | 'unbounded_query'
  | 'event_listener_leak'
  | 'circular_dependency'
  | 'missing_index'
  | 'memory_leak'
  | 'god_class'
  | 'long_method'
  | 'long_parameter_list'
  | 'deep_nesting';

const ALL_CATEGORIES: AntipatternCategory[] = [
  'n_plus_one_risk',
  'missing_eager_load',
  'unbounded_query',
  'event_listener_leak',
  'circular_dependency',
  'missing_index',
  'memory_leak',
  'god_class',
  'long_method',
  'long_parameter_list',
  'deep_nesting',
];

export type Severity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

interface AntipatternFinding {
  id: string;
  category: AntipatternCategory;
  severity: Severity;
  title: string;
  description: string;
  file: string;
  line: number | null;
  model?: string;
  orm?: string;
  related_symbols?: string[];
  fix: string;
  confidence: number;
  /** Categorical level derived from `confidence`; populated by detectAntipatterns. */
  confidence_level?: ConfidenceLevel;
}

interface AntipatternResult {
  findings: AntipatternFinding[];
  summary: Record<Severity, number>;
  models_analyzed: number;
  /**
   * Total count of files touched by any enabled detector. For ORM-scoped
   * detectors this is the set of ORM model files; for listener/memory-leak
   * detectors this is the set of indexed TS/JS files with callSites metadata.
   */
  files_analyzed: number;
  /** Per-category scope counters so callers can distinguish "0 findings" from "detector was inapplicable". */
  scope_by_category: Partial<
    Record<AntipatternCategory, { files_scanned: number; models_scanned?: number }>
  >;
  categories_checked: AntipatternCategory[];
  _methodology: Methodology;
}

const ANTIPATTERN_METHODOLOGY: Methodology = {
  algorithm: 'rule_based_static_graph_analysis',
  signals: [
    'n_plus_one_risk: to-many associations (hasMany/belongsToMany/OneToMany) without eager-load hints, with evidence that the model is accessed from at least one handler/controller/resolver',
    'missing_eager_load: models with 2+ relationships lacking eager-load hints, accessed from multiple files',
    'unbounded_query: ORM models with no default pagination whose table name suggests high cardinality (logs/events/sessions/...) OR which are reached from route/call edges',
    'event_listener_leak: listener-registration callees (addEventListener/on/subscribe/setInterval/setTimeout) recorded in symbols.metadata.callSites without a matching cleanup callee (removeEventListener/off/unsubscribe/clearInterval/clearTimeout) in the same file. Framework-managed registrations (Livewire, Socket.IO, NestJS gateways, Mongoose/Sequelize hooks) are excluded.',
    'circular_dependency: ORM association cycles (A hasMany B, B belongsTo A) via Tarjan SCC over the association graph. Does NOT detect ES/CJS import cycles — use get_circular_imports for that.',
    'missing_index: foreign-key columns on owning-side associations (belongsTo/ManyToOne/ref) without an index in migrations. Explicit FKs from association options and implicit FKs (snake_case target + "_id") are both checked.',
    'memory_leak: cache-like Map/Set variables with growth calls (set/push/add) in their file but no cleanup calls (delete/clear/splice) or bounded-cache hints (WeakMap/LRU/TTL); plus event handlers whose callSites both register a listener and push to a collection without cleanup',
    'god_class: class symbols with excessive number of child methods (>=25) or excessive line count (>=500). Aggregates member counts via parent_id relationship in the symbols table.',
    'long_method: function/method symbols whose body spans >=60 lines (line_end - line_start). Excludes classes, trivial getters/setters.',
    'long_parameter_list: function/method symbols with >=6 parameters parsed from the stored signature. Indicates that parameters should be grouped into a data object / config struct.',
    'deep_nesting: function/method bodies with indentation depth >=5 levels (nested conditionals / loops). Scans source file content, skipping string literals, counting leading whitespace normalized to the file base indent.',
  ],
  confidence_formula:
    'Each rule emits a per-finding numeric confidence (0..1) based on how strong its static evidence is. confidence_level: <0.4=low, <0.75=medium, ≥0.75=high.',
  limitations: [
    'ORM-scoped signals (n_plus_one_risk, missing_eager_load, unbounded_query, missing_index, circular_dependency) return 0 findings on projects without an active ORM plugin',
    'string-based / dynamic ORM calls are not traced',
    'eager-load detection only checks documented hints; programmatic preloading is missed',
    'listener-leak cleanup pairing is file-scoped (intra-file); listeners registered in one file and cleaned up in another are false positives',
    'rules are static heuristics — runtime behavior may differ (cached queries, lazy proxies)',
    'requires the relevant ORM/framework plugin to be active for that file',
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonParse<T = Record<string, unknown>>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function groupBy<T, K extends string | number>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(item);
  }
  return map;
}

/** Kinds that represent "to-many" relationships (N+1 risk). */
const MANY_KINDS = new Set([
  'hasMany',
  'has_many',
  'hasManyThrough',
  'has_many_through',
  'belongsToMany',
  'belongs_to_many',
  'ManyToMany',
  'OneToMany',
  // Sequelize-specific edge names
  'sequelize_has_many',
  'sequelize_belongs_to_many',
]);

/** Kinds for any relationship (eager load analysis). */
const RELATION_KINDS = new Set([
  ...MANY_KINDS,
  'hasOne',
  'has_one',
  'belongsTo',
  'belongs_to',
  'ManyToOne',
  'OneToOne',
  'ref',
  'morphsTo',
  'morphs_to',
  'morphMany',
  'morph_many',
  'sequelize_has_one',
  'sequelize_belongs_to',
]);

/** Owning-side relationship kinds — the FK lives on THIS model's table. */
const BELONGS_TO_KINDS = new Set([
  'belongsTo',
  'belongs_to',
  'ManyToOne',
  'OneToOne',
  'ref',
  'morphsTo',
  'morphs_to',
  'sequelize_belongs_to',
]);

/** Convert a PascalCase / camelCase name to snake_case. */
function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** Check association options for eager loading hints. */
function hasEagerLoadHint(assoc: OrmAssociationRow, model: OrmModelRow): boolean {
  const opts = jsonParse(assoc.options);
  if (opts) {
    if (opts['eager'] === true || opts['eager_load'] === true) return true;
    if (opts['autopopulate'] === true) return true;
  }
  // Check model-level metadata for eager declarations
  const meta = jsonParse(model.metadata);
  if (meta) {
    // Laravel Eloquent: $with property
    const withProp = meta['with'] as string[] | undefined;
    if (Array.isArray(withProp) && withProp.length > 0) return true;
    // TypeORM: eager option on relation decorator
    if (meta['eager'] === true) return true;
  }
  const modelOpts = jsonParse(model.options);
  if (modelOpts) {
    // Sequelize: defaultScope with include
    const defaultScope = modelOpts['defaultScope'] as Record<string, unknown> | undefined;
    if (defaultScope?.['include']) return true;
  }
  return false;
}

/** High-cardinality table name heuristic.
 *  Matches whole-word tokens so `audit_logs`, `user_events`, `app_notifications` all hit. */
const HIGH_CARDINALITY_PATTERNS =
  /(^|[^a-z0-9])(logs?|events?|messages?|notifications?|activities|audit|metrics|jobs|queue|sessions?|clicks?|views?|requests?)([^a-z0-9]|$)/i;

/** Add/remove listener rules matched against `symbols.metadata.callSites[].calleeName`.
 *  Signature-based matching has been retired — function bodies aren't in `signature`,
 *  so the indexer's callSites metadata is the only reliable source for call-expression
 *  evidence. Patterns are anchored (`^...$`) to match exact callee names. */
interface ListenerRule {
  add: RegExp;
  cleanup: RegExp;
  label: string;
  /** When true, only flag if the call is inside a class/method (one-shot timers at top level rarely leak). */
  requiresContainer?: boolean;
}
const LISTENER_RULES: ListenerRule[] = [
  {
    add: /^addEventListener$/i,
    cleanup: /^removeEventListener$/i,
    label: 'addEventListener without removeEventListener',
  },
  {
    add: /^(on|addListener|addEventHandler)$/i,
    cleanup: /^(off|removeListener|removeEventHandler|removeAllListeners)$/i,
    label: '.on() without .off()/.removeListener()',
  },
  {
    add: /^subscribe$/i,
    cleanup: /^(unsubscribe|complete)$/i,
    label: '.subscribe() without .unsubscribe()',
  },
  {
    add: /^setInterval$/i,
    cleanup: /^clearInterval$/i,
    label: 'setInterval without clearInterval',
  },
  {
    add: /^setTimeout$/i,
    cleanup: /^clearTimeout$/i,
    label: 'setTimeout without clearTimeout (in class/component)',
    requiresContainer: true,
  },
];

/** Lifecycle-cleanup method/callee names — their presence signals implicit disposal. */
const LIFECYCLE_CLEANUP_NAMES = new Set([
  // Vue / React / Angular / Svelte
  'onUnmounted',
  'onBeforeUnmount',
  'onDestroy',
  'ngOnDestroy',
  'componentWillUnmount',
  'useEffect',
  'useLayoutEffect',
  // Node / EventEmitter / generic disposables
  'dispose',
  'destroy',
  'cleanup',
  'teardown',
]);

interface CallSiteMeta {
  calleeName: string;
  line: number;
  receiver?: string;
  receiverType?: string;
  isNew?: boolean;
  isThisCall?: boolean;
  isSuperCall?: boolean;
}

/** Extract callSites array from a symbol's metadata JSON. Returns [] if absent/invalid. */
function extractCallSites(metadata: string | null): CallSiteMeta[] {
  if (!metadata) return [];
  try {
    const meta = JSON.parse(metadata) as Record<string, unknown>;
    const cs = meta['callSites'];
    if (!Array.isArray(cs)) return [];
    return cs as CallSiteMeta[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Shared pre-fetched data
// ---------------------------------------------------------------------------

interface PreFetchedData {
  models: OrmModelRow[];
  modelMap: Map<number, OrmModelRow>;
  assocByModel: Map<number, OrmAssociationRow[]>;
  fileMap: Map<number, FileRow>;
  filePattern?: string;
  projectRoot?: string;
}

function preFetch(store: Store, filePattern?: string, projectRoot?: string): PreFetchedData {
  const models = store.getAllOrmModels();
  const modelMap = new Map(models.map((m) => [m.id, m]));
  const allAssociations = store.getAllOrmAssociations();
  const assocByModel = groupBy(allAssociations, (a) => a.source_model_id);

  const fileIds = [...new Set(models.map((m) => m.file_id))];
  const fileMap = store.getFilesByIds(fileIds);

  return { models, modelMap, assocByModel, fileMap, filePattern, projectRoot };
}

function matchesFilePattern(filePath: string, pattern?: string): boolean {
  if (!pattern) return true;
  // Support both real globs (src/**/*.ts) and plain substring patterns (src/api/).
  // A pattern with no glob metacharacters is treated as a case-insensitive substring match.
  const hasGlob = /[*?[\]{}]/.test(pattern);
  if (!hasGlob) return filePath.toLowerCase().includes(pattern.toLowerCase());
  const isMatch = picomatch(pattern, { dot: true, nocase: true });
  return isMatch(filePath);
}

// ---------------------------------------------------------------------------
// Detector 1: N+1 Query Risk
// ---------------------------------------------------------------------------

function detectNPlusOne(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  // Get node IDs for all models in one batch
  const modelIds = data.models.map((m) => m.id);
  const modelNodeIds = store.getNodeIdsBatch('orm_model', modelIds);

  // For each model, check its to-many associations
  for (const model of data.models) {
    const file = data.fileMap.get(model.file_id);
    if (!file || !matchesFilePattern(file.path, data.filePattern)) continue;

    const assocs = data.assocByModel.get(model.id) ?? [];
    const manyAssocs = assocs.filter((a) => MANY_KINDS.has(a.kind));
    if (manyAssocs.length === 0) continue;

    const modelNodeId = modelNodeIds.get(model.id);
    if (!modelNodeId) continue;

    // Check incoming edges to see who accesses this model
    const incoming = store.getIncomingEdges(modelNodeId);
    const callerNodeIds = incoming.map((e) => e.source_node_id);

    // Resolve callers to check if they're controllers/services
    const callerRefs = callerNodeIds.length > 0 ? store.getNodeRefsBatch(callerNodeIds) : new Map();
    const callerSymIds = [...callerRefs.values()]
      .filter((r) => r.nodeType === 'symbol')
      .map((r) => r.refId);
    const callerSyms = callerSymIds.length > 0 ? store.getSymbolsByIds(callerSymIds) : new Map();

    // Identify handler-like callers — request-path symbols that access the model.
    // Presence is strong evidence; absence is weaker (model may never be loaded in bulk),
    // so we still report but with lower severity/confidence instead of skipping.
    const handlerSymbols: string[] = [];
    for (const sym of callerSyms.values()) {
      const symMeta = jsonParse(sym.metadata);
      const role = (symMeta?.['frameworkRole'] as string | undefined) ?? '';
      const isHandler =
        role.includes('controller') ||
        role.includes('handler') ||
        role.includes('route') ||
        role.includes('resolver');
      if (isHandler) handlerSymbols.push(sym.symbol_id);
    }

    for (const assoc of manyAssocs) {
      const hasEager = hasEagerLoadHint(assoc, model);
      if (hasEager) continue;

      // Tier severity & confidence by evidence strength.
      let severity: Severity;
      let confidence: number;
      if (handlerSymbols.length >= 1) {
        severity = 'high';
        confidence = 0.85;
        if (handlerSymbols.length >= 2) confidence = Math.min(confidence + 0.05, 1.0);
        if (manyAssocs.length >= 2) confidence = Math.min(confidence + 0.05, 1.0);
      } else {
        severity = manyAssocs.length >= 2 ? 'medium' : 'low';
        confidence = manyAssocs.length >= 2 ? 0.55 : 0.45;
      }

      const targetName = assoc.target_model_name ?? `model#${assoc.target_model_id}`;
      const handlerNote =
        handlerSymbols.length > 0
          ? `, accessed from ${handlerSymbols.length} handler symbol(s)`
          : ' (no request-path accessor detected — verify this model is ever loaded in bulk)';
      counter++;
      findings.push({
        id: `NP1-${String(counter).padStart(3, '0')}`,
        category: 'n_plus_one_risk',
        severity,
        title: `N+1 risk: ${model.name}.${assoc.kind}(${targetName})`,
        description:
          `Model "${model.name}" has a ${assoc.kind} relationship to "${targetName}" without eager loading${handlerNote}. ` +
          `When iterating over ${model.name} records, each access to the "${targetName}" relationship triggers a separate query.`,
        file: file.path,
        line: assoc.line,
        model: model.name,
        orm: model.orm,
        related_symbols: handlerSymbols.length > 0 ? handlerSymbols : undefined,
        fix: eagerLoadFix(model.orm, model.name, targetName),
        confidence,
      });
    }
  }
  return findings;
}

function eagerLoadFix(orm: string, modelName: string, relName: string): string {
  switch (orm) {
    case 'eloquent':
    case 'laravel':
      return `Add "${relName}" to $with on ${modelName}, or use ${modelName}::with('${relName}')->get()`;
    case 'sequelize':
      return `Use ${modelName}.findAll({ include: ['${relName}'] }) or add to defaultScope`;
    case 'mongoose':
      return `Use ${modelName}.find().populate('${relName}') or enable autopopulate plugin`;
    case 'django':
      return `Use ${modelName}.objects.prefetch_related('${relName}') or select_related()`;
    case 'typeorm':
      return `Set { eager: true } on the relation decorator or use .find({ relations: ['${relName}'] })`;
    case 'prisma':
      return `Use ${modelName}.findMany({ include: { ${relName}: true } })`;
    case 'drizzle':
      return `Use the with clause: db.query.${modelName}.findMany({ with: { ${relName}: true } })`;
    default:
      return `Eager-load the "${relName}" relationship when querying ${modelName} to avoid N+1 queries`;
  }
}

// ---------------------------------------------------------------------------
// Detector 2: Missing Eager Load
// ---------------------------------------------------------------------------

function detectMissingEagerLoad(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  for (const model of data.models) {
    const file = data.fileMap.get(model.file_id);
    if (!file || !matchesFilePattern(file.path, data.filePattern)) continue;

    const assocs = data.assocByModel.get(model.id) ?? [];
    const relations = assocs.filter((a) => RELATION_KINDS.has(a.kind));
    if (relations.length < 2) continue;

    const uneager = relations.filter((a) => !hasEagerLoadHint(a, model));
    if (uneager.length === 0) continue;

    // Count how many files access this model via incoming edges
    const modelNodeId = store.getNodeId('orm_model', model.id);
    let accessorFileCount = 0;
    if (modelNodeId) {
      const incoming = store.getIncomingEdges(modelNodeId);
      const refs = store.getNodeRefsBatch(incoming.map((e) => e.source_node_id));
      const symIds = [...refs.values()].filter((r) => r.nodeType === 'symbol').map((r) => r.refId);
      if (symIds.length > 0) {
        const syms = store.getSymbolsByIds(symIds);
        accessorFileCount = new Set([...syms.values()].map((s) => s.file_id)).size;
      }
    }

    const confidence = accessorFileCount >= 3 ? 0.7 : 0.5;

    counter++;
    findings.push({
      id: `MEL-${String(counter).padStart(3, '0')}`,
      category: 'missing_eager_load',
      severity: 'medium',
      title: `${model.name}: ${uneager.length}/${relations.length} relationships lack eager loading`,
      description:
        `Model "${model.name}" has ${relations.length} relationships but ${uneager.length} have no eager loading configured. ` +
        `This can lead to N+1 queries when relationships are accessed lazily.` +
        (accessorFileCount >= 3
          ? ` The model is accessed from ${accessorFileCount} different files.`
          : ''),
      file: file.path,
      line: null,
      model: model.name,
      orm: model.orm,
      fix:
        `Review relationships on ${model.name} and configure eager loading for frequently accessed ones: ` +
        uneager.map((a) => a.target_model_name ?? a.kind).join(', '),
      confidence,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Detector 3: Unbounded Query
// ---------------------------------------------------------------------------

function detectUnboundedQuery(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  for (const model of data.models) {
    const file = data.fileMap.get(model.file_id);
    if (!file || !matchesFilePattern(file.path, data.filePattern)) continue;

    const tableName = model.collection_or_table ?? model.name.toLowerCase() + 's';

    // Check model options for pagination/limit config
    const opts = jsonParse(model.options);
    const meta = jsonParse(model.metadata);

    const hasPagination =
      opts?.['perPage'] != null ||
      opts?.['defaultScope']?.['limit'] != null ||
      meta?.['perPage'] != null ||
      meta?.['paginate'] === true;

    if (hasPagination) continue;

    // Check if table name suggests high cardinality
    const isHighCardinality = HIGH_CARDINALITY_PATTERNS.test(tableName);

    // Check routes that point to controllers using this model
    const modelNodeId = store.getNodeId('orm_model', model.id);
    let routeAccessCount = 0;
    if (modelNodeId) {
      const incoming = store.getIncomingEdges(modelNodeId);
      const routeEdges = incoming.filter(
        (e) =>
          e.edge_type_name === 'routes_to' ||
          e.edge_type_name === 'calls' ||
          e.edge_type_name === 'references',
      );
      routeAccessCount = routeEdges.length;
    }

    if (!isHighCardinality && routeAccessCount === 0) continue;

    const confidence = isHighCardinality ? 0.7 : 0.4;
    counter++;
    findings.push({
      id: `UBQ-${String(counter).padStart(3, '0')}`,
      category: 'unbounded_query',
      severity: isHighCardinality ? 'high' : 'medium',
      title: `Unbounded query risk: ${model.name} (table: ${tableName})`,
      description:
        `Model "${model.name}" has no default pagination or limit configured. ` +
        (isHighCardinality
          ? `Table "${tableName}" likely has high cardinality — unbounded queries can cause memory issues and slow responses.`
          : `Queries returning all rows can degrade performance as the table grows.`),
      file: file.path,
      line: null,
      model: model.name,
      orm: model.orm,
      fix: unboundedQueryFix(model.orm, model.name),
      confidence,
    });
  }
  return findings;
}

function unboundedQueryFix(orm: string, modelName: string): string {
  switch (orm) {
    case 'eloquent':
    case 'laravel':
      return `Add $perPage to ${modelName} or always use ->paginate() / ->limit() in controllers`;
    case 'sequelize':
      return `Add { limit } to defaultScope or always pass { limit } to findAll()`;
    case 'mongoose':
      return `Always chain .limit() on find() queries or use mongoose-paginate-v2`;
    case 'django':
      return `Use .objects.all()[:limit] or django-pagination in views`;
    case 'typeorm':
      return `Use .find({ take: N }) or QueryBuilder .take(N) to limit results`;
    case 'prisma':
      return `Use .findMany({ take: N }) to limit results`;
    default:
      return `Add default pagination or LIMIT to queries on ${modelName}`;
  }
}

// ---------------------------------------------------------------------------
// Detector 4: Event Listener Leak
// ---------------------------------------------------------------------------

function detectEventListenerLeak(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  // Phase A: Graph-based — only edge types where the framework does NOT
  // auto-manage disposal. Livewire, Socket.IO, NestJS gateways, Mongoose/Sequelize
  // hooks are lifecycle-managed and historically produced false positives.
  const listenerEdgeTypes = ['listens_to'];

  for (const edgeType of listenerEdgeTypes) {
    const edges = store.getEdgesByType(edgeType);
    if (edges.length === 0) continue;

    const sourceNodeIds = edges.map((e) => e.source_node_id);
    const refs = store.getNodeRefsBatch(sourceNodeIds);
    const symIds = [...refs.values()].filter((r) => r.nodeType === 'symbol').map((r) => r.refId);
    const syms = symIds.length > 0 ? store.getSymbolsByIds(symIds) : new Map();
    const fileIds = [...new Set([...syms.values()].map((s) => s.file_id))];
    const files = fileIds.length > 0 ? store.getFilesByIds(fileIds) : new Map();

    for (const edge of edges) {
      const ref = refs.get(edge.source_node_id);
      if (!ref || ref.nodeType !== 'symbol') continue;
      const sym = syms.get(ref.refId);
      if (!sym) continue;
      const file = files.get(sym.file_id);
      if (!file || !matchesFilePattern(file.path, data.filePattern)) continue;

      counter++;
      findings.push({
        id: `ELL-${String(counter).padStart(3, '0')}`,
        category: 'event_listener_leak',
        severity: 'medium',
        title: `Potential listener leak: ${sym.name} (${edgeType})`,
        description: `Symbol "${sym.name}" registers a ${edgeType} handler. Verify that the listener is properly cleaned up on disposal/unmount.`,
        file: file.path,
        line: sym.line_start,
        related_symbols: [sym.symbol_id],
        fix: `Ensure matching cleanup (removeListener/off/unsubscribe/dispose) in teardown/unmount lifecycle`,
        confidence: 0.55,
      });
    }
  }

  // Phase B: Call-site based — walk `metadata.callSites` (populated by the indexer)
  // to find listener registrations without matching cleanup in the same file or
  // in files that import this one. callSites records every call-expression
  // calleeName, which is the authoritative source — `signature` only contains
  // the declaration header, so body calls like `addEventListener(...)` never appear there.
  const symsWithCallSites = store.db
    .prepare(`
    SELECT s.id, s.file_id, s.symbol_id, s.name, s.kind, s.parent_id, s.line_start, s.metadata,
           f.path as file_path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.metadata IS NOT NULL
      AND s.metadata LIKE '%"callSites"%'
      AND f.gitignored = 0
  `)
    .all() as Array<{
    id: number;
    file_id: number;
    symbol_id: string;
    name: string;
    kind: string;
    parent_id: number | null;
    line_start: number | null;
    metadata: string;
    file_path: string;
  }>;

  type SymRow = (typeof symsWithCallSites)[number];
  const byFile = groupBy(symsWithCallSites, (s) => s.file_id);

  // Per-file cache of every callee name seen (for cleanup matching) plus imports scan.
  for (const [fileId, syms] of byFile) {
    const filePath = syms[0]?.file_path;
    if (!filePath || !matchesFilePattern(filePath, data.filePattern)) continue;

    // All call-expressions in this file, with the originating symbol.
    type EnrichedCall = { sym: SymRow; call: CallSiteMeta };
    const fileCalls: EnrichedCall[] = [];
    for (const s of syms) {
      for (const call of extractCallSites(s.metadata)) {
        fileCalls.push({ sym: s, call });
      }
    }
    if (fileCalls.length === 0) continue;

    // Union of calleeNames in this file — used for cleanup matching.
    const fileCalleeNames = fileCalls.map((c) => c.call.calleeName);

    // Also pull calleeNames from files that import this one. Use case: a Setup.ts
    // module exposes `init()` which registers a listener, and a sibling Teardown.ts
    // imports Setup and calls `cleanup()` with removeEventListener.
    const fileNodeId = store.getNodeId('file', fileId);
    const crossFileCalleeNames: string[] = [];
    if (fileNodeId) {
      const incomingEdges = store.getIncomingEdges(fileNodeId);
      const importerNodeIds = incomingEdges
        .filter((e) => e.edge_type_name === 'esm_imports' || e.edge_type_name === 'imports')
        .map((e) => e.source_node_id);
      if (importerNodeIds.length > 0) {
        const importerRefs = store.getNodeRefsBatch(importerNodeIds);
        const importerFileIds = [...importerRefs.values()]
          .filter((r) => r.nodeType === 'file')
          .map((r) => r.refId);
        for (const impFileId of importerFileIds) {
          const impSyms = store.getSymbolsByFile(impFileId);
          for (const s of impSyms) {
            for (const call of extractCallSites(s.metadata)) {
              crossFileCalleeNames.push(call.calleeName);
            }
          }
        }
      }
    }
    const combinedCalleeNames = [...fileCalleeNames, ...crossFileCalleeNames];

    const hasCleanupCall = (rule: ListenerRule) =>
      combinedCalleeNames.some((n) => rule.cleanup.test(n));
    const fileHasLifecycleCleanup =
      syms.some((s) => LIFECYCLE_CLEANUP_NAMES.has(s.name)) ||
      combinedCalleeNames.some((n) => LIFECYCLE_CLEANUP_NAMES.has(n));

    // Deduplicate: one finding per (rule, sym) pair — a symbol that registers
    // multiple listeners via the same rule gets only one report at its earliest line.
    const seen = new Set<string>();

    for (const { sym, call } of fileCalls) {
      for (const rule of LISTENER_RULES) {
        if (!rule.add.test(call.calleeName)) continue;
        if (rule.requiresContainer && sym.parent_id == null) continue;
        if (hasCleanupCall(rule)) continue;

        const dedupKey = `${sym.symbol_id}::${rule.label}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        counter++;
        findings.push({
          id: `ELL-${String(counter).padStart(3, '0')}`,
          category: 'event_listener_leak',
          severity: fileHasLifecycleCleanup ? 'low' : 'high',
          title: `${rule.label} in ${sym.name}`,
          description: `"${sym.name}" in ${filePath} calls ${call.calleeName}(...) at line ${call.line} but no matching cleanup (${rule.cleanup.source}) was found in the same file or importing files.`,
          file: filePath,
          line: call.line,
          related_symbols: [sym.symbol_id],
          fix: `Add a matching cleanup call (e.g. ${rule.cleanup.source.replace(/[\^$]/g, '')}) in teardown/unmount/destructor`,
          confidence: fileHasLifecycleCleanup ? 0.35 : 0.7,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector 5: Circular Model Dependencies
// ---------------------------------------------------------------------------

function detectCircularDeps(data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];

  // Build directed graph: modelId → Set<targetModelId>
  const graph = new Map<number, Set<number>>();
  for (const [modelId, assocs] of data.assocByModel) {
    const targets = new Set<number>();
    for (const a of assocs) {
      if (a.target_model_id != null) targets.add(a.target_model_id);
    }
    if (targets.size > 0) graph.set(modelId, targets);
  }

  // Tarjan's SCC
  let index = 0;
  const indices = new Map<number, number>();
  const lowlinks = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const sccs: number[][] = [];

  function strongConnect(v: number) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  }

  for (const nodeId of graph.keys()) {
    if (!indices.has(nodeId)) strongConnect(nodeId);
  }

  let counter = 0;
  for (const scc of sccs) {
    const modelNames = scc
      .map((id) => data.modelMap.get(id))
      .filter((m): m is OrmModelRow => m != null);

    if (modelNames.length === 0) continue;

    const first = modelNames[0];
    const file = data.fileMap.get(first.file_id);
    if (!file || !matchesFilePattern(file.path, data.filePattern)) continue;

    const cycle = modelNames.map((m) => m.name).join(' → ') + ' → ' + modelNames[0].name;
    counter++;
    findings.push({
      id: `CYC-${String(counter).padStart(3, '0')}`,
      category: 'circular_dependency',
      severity: 'low',
      title: `Circular model dependency: ${modelNames.map((m) => m.name).join(', ')}`,
      description: `Circular relationship chain detected: ${cycle}. This can cause infinite loops in serialization, cascading deletes, or eager loading.`,
      file: file.path,
      line: null,
      model: first.name,
      orm: first.orm,
      fix: `Break the cycle by removing one relationship or making it lazy-loaded / using a join table`,
      confidence: 1.0,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Detector 6: Missing Index on Foreign Key
// ---------------------------------------------------------------------------

function detectMissingIndex(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  // Pre-fetch all migrations grouped by table
  const allMigrations = store.getAllMigrations();
  const migByTable = groupBy(allMigrations, (m) => m.table_name);

  // Collect all indexed columns per table from migrations
  const indexedColumns = new Map<string, Set<string>>();
  for (const [table, migs] of migByTable) {
    const cols = new Set<string>();
    for (const mig of migs) {
      const indices = jsonParse<Array<{ columns?: string[] }>>(mig.indices);
      if (Array.isArray(indices)) {
        for (const idx of indices) {
          if (Array.isArray(idx.columns)) {
            for (const col of idx.columns) cols.add(col);
          } else if (typeof idx === 'string') {
            cols.add(idx);
          }
        }
      }
    }
    indexedColumns.set(table, cols);
  }

  for (const model of data.models) {
    const file = data.fileMap.get(model.file_id);
    if (!file || !matchesFilePattern(file.path, data.filePattern)) continue;

    const assocs = data.assocByModel.get(model.id) ?? [];
    const tableName = model.collection_or_table ?? model.name.toLowerCase() + 's';
    const tableIndexes = indexedColumns.get(tableName) ?? new Set();

    for (const assoc of assocs) {
      const opts = jsonParse(assoc.options);
      const explicitFk = opts?.['foreignKey'] as string | undefined;

      // ORM convention: inferred FK when not explicitly declared.
      // The owning side (belongsTo/ManyToOne/ref) stores the FK locally as
      // `<target_snake_case>_id`. hasMany/hasOne are on the inverse side — the
      // FK lives on the target table (we'll surface that via the target_model iteration).
      let fk = explicitFk;
      let isInferred = false;
      if (!fk) {
        if (!BELONGS_TO_KINDS.has(assoc.kind)) continue;
        const targetName = assoc.target_model_name;
        if (!targetName) continue;
        fk = toSnakeCase(targetName) + '_id';
        isInferred = true;
      }

      // Check if FK is indexed
      if (tableIndexes.has(fk)) continue;

      // Also check target table for the FK
      const targetModel = assoc.target_model_id ? data.modelMap.get(assoc.target_model_id) : null;
      const targetTable = targetModel
        ? (targetModel.collection_or_table ?? targetModel.name.toLowerCase() + 's')
        : null;
      if (targetTable) {
        const targetIndexes = indexedColumns.get(targetTable) ?? new Set();
        if (targetIndexes.has(fk)) continue;
      }

      counter++;
      findings.push({
        id: `MIX-${String(counter).padStart(3, '0')}`,
        category: 'missing_index',
        severity: 'medium',
        title: `Missing index on FK: ${tableName}.${fk}${isInferred ? ' (inferred)' : ''}`,
        description:
          `Foreign key "${fk}" on table "${tableName}" (from ${model.name}.${assoc.kind}${isInferred ? ', FK inferred from ORM convention' : ''}) has no corresponding index in migrations. ` +
          `JOINs and relationship lookups on this column will be slow on large tables.`,
        file: file.path,
        line: assoc.line,
        model: model.name,
        orm: model.orm,
        fix: `Add a migration to create an index on "${tableName}"."${fk}"`,
        confidence: isInferred ? 0.4 : 0.6,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Detector 7: Memory Leak Patterns
// ---------------------------------------------------------------------------

/** Patterns that suggest potential memory leaks via unbounded growth. */
const _MEMORY_LEAK_PATTERNS: {
  regex: RegExp;
  label: string;
  severity: Severity;
  description: string;
  fix: string;
}[] = [
  // Growing caches without eviction
  {
    regex: /\.(set|push|add)\s*\(/i,
    label: 'Unbounded cache/collection growth',
    severity: 'medium',
    description:
      'adds to a Map/Set/Array without size limits or eviction — can grow indefinitely in long-running processes.',
    fix: 'Add a max size check and eviction policy (LRU, TTL) or use WeakMap/WeakRef.',
  },
  // Module-level mutable Map/Set/Array (likely cache)
  {
    regex: /^(?:const|let|var)\s+\w+\s*=\s*new\s+(?:Map|Set)\s*\(/i,
    label: 'Module-level Map/Set (potential unbounded cache)',
    severity: 'low',
    description:
      'declares a module-level Map/Set. If items are added during request handling without cleanup, this grows unboundedly.',
    fix: 'Consider WeakMap/WeakRef for caches, or add TTL-based eviction.',
  },
];

/** Growth/cleanup callee names — matched exactly against callSites[].calleeName. */
const GROWTH_CALLEES = new Set(['set', 'push', 'add', 'unshift']);
const CLEANUP_CALLEES = new Set(['delete', 'clear', 'splice', 'shift', 'pop', 'evict']);
/** Bounded-cache hints in signature or anywhere in file text — suppress leak findings. */
const BOUNDED_SIGNATURE_RE =
  /weak(map|set|ref)|\blru\b|\bttl\b|maxsize|max_size|maxEntries|MAX_ENTRIES/i;
/** Listener-registration callees that trigger closure-leak Strategy 2. */
const LISTENER_CALLEE_RE = /^(addEventListener|on|subscribe|setInterval)$/i;

/** Walks indexer's callSites metadata to find memory-leak patterns.
 *  Replaces the legacy SQL-LIKE-over-signature approach, which only saw declaration
 *  text and missed every call expression in function bodies. */
function detectMemoryLeak(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  // Strategy 1: Find cache-like variables/properties (Map/Set declarations or
  // name-based hints) and verify growth vs. cleanup via callSites in the same file.
  // Name patterns use word-endings to avoid matching `useStore`, `restoreX`, etc.
  const cacheSymbols = store.db
    .prepare(`
    SELECT s.id, s.name, s.kind, s.symbol_id, s.line_start, s.signature,
           f.path as file_path, f.id as file_id
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE (s.signature LIKE '%new Map%'
      OR s.signature LIKE '%new Set%'
      OR s.signature LIKE '%: Map<%'
      OR s.signature LIKE '%: Set<%'
      OR s.name LIKE '%Cache'
      OR s.name LIKE '%_cache'
      OR s.name = 'cache'
      OR s.name LIKE '%Registry'
      OR s.name = '_registry'
      OR s.name LIKE '%Pool'
      OR s.name = '_pool')
    AND s.kind IN ('variable', 'property', 'constant')
    AND f.gitignored = 0
  `)
    .all() as Array<{
    id: number;
    name: string;
    kind: string;
    symbol_id: string;
    line_start: number | null;
    signature: string | null;
    file_path: string;
    file_id: number;
  }>;

  const byFile = groupBy(cacheSymbols, (s) => s.file_id);

  for (const [fileId, syms] of byFile) {
    const filePath = syms[0]?.file_path;
    if (!filePath || !matchesFilePattern(filePath, data.filePattern)) continue;

    // Aggregate every callSite calleeName in the file.
    const allFileSyms = store.getSymbolsByFile(fileId);
    const fileCalleeNames: string[] = [];
    for (const s of allFileSyms) {
      for (const call of extractCallSites(s.metadata)) {
        fileCalleeNames.push(call.calleeName);
      }
    }

    const hasGrowth = fileCalleeNames.some((n) => GROWTH_CALLEES.has(n));
    if (!hasGrowth) continue;

    const hasCleanupCall = fileCalleeNames.some((n) => CLEANUP_CALLEES.has(n));
    // Also accept declarative bounded-cache hints anywhere in a signature.
    const boundedBySignature = allFileSyms.some((s) =>
      BOUNDED_SIGNATURE_RE.test(s.signature ?? ''),
    );
    if (hasCleanupCall || boundedBySignature) continue;

    for (const sym of syms) {
      counter++;
      findings.push({
        id: `MEM-${String(counter).padStart(3, '0')}`,
        category: 'memory_leak',
        severity: 'medium',
        title: `Potential unbounded cache: ${sym.name}`,
        description: `"${sym.name}" in ${filePath} is a Map/Set/cache-like variable that grows (set/push/add calls present) but no eviction (no delete/clear/splice calls or LRU/TTL/WeakMap hints) was found in the same file.`,
        file: filePath,
        line: sym.line_start,
        related_symbols: [sym.symbol_id],
        fix: 'Add a max size check and eviction policy (LRU, TTL), or use WeakMap/WeakRef for object keys.',
        confidence: 0.5,
      });
    }
  }

  // Strategy 2: Closure-over-mutable — a symbol whose callSites both register
  // a listener AND push to a collection, with no cleanup calls anywhere in the file.
  const handlerCandidates = store.db
    .prepare(`
    SELECT s.id, s.file_id, s.symbol_id, s.name, s.line_start, s.metadata,
           f.path as file_path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.metadata IS NOT NULL
      AND s.metadata LIKE '%"callSites"%'
      AND f.gitignored = 0
  `)
    .all() as Array<{
    id: number;
    file_id: number;
    symbol_id: string;
    name: string;
    line_start: number | null;
    metadata: string;
    file_path: string;
  }>;

  for (const sym of handlerCandidates) {
    if (!matchesFilePattern(sym.file_path, data.filePattern)) continue;
    const callSites = extractCallSites(sym.metadata);
    if (callSites.length === 0) continue;

    const registersListener = callSites.some((c) => LISTENER_CALLEE_RE.test(c.calleeName));
    const pushesToCollection = callSites.some((c) => GROWTH_CALLEES.has(c.calleeName));
    if (!registersListener || !pushesToCollection) continue;

    const allFileSyms = store.getSymbolsByFile(sym.file_id);
    const fileHasCleanup = allFileSyms.some((s) =>
      extractCallSites(s.metadata).some((c) => CLEANUP_CALLEES.has(c.calleeName)),
    );
    if (fileHasCleanup) continue;

    counter++;
    findings.push({
      id: `MEM-${String(counter).padStart(3, '0')}`,
      category: 'memory_leak',
      severity: 'high',
      title: `Closure retains growing collection: ${sym.name}`,
      description: `"${sym.name}" in ${sym.file_path} registers an event listener AND pushes to a collection. Each invocation grows the collection without visible cleanup.`,
      file: sym.file_path,
      line: sym.line_start,
      related_symbols: [sym.symbol_id],
      fix: 'Move the collection inside the handler, add a size limit, or clean up on handler removal.',
      confidence: 0.6,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Size / complexity detectors (symbol-metadata based, no ORM dependency)
// ---------------------------------------------------------------------------

const GOD_CLASS_METHOD_THRESHOLD = 25;
const GOD_CLASS_LOC_THRESHOLD = 500;
const LONG_METHOD_LOC_THRESHOLD = 60;
const LONG_PARAM_LIST_THRESHOLD = 6;
const DEEP_NESTING_THRESHOLD = 5;

const _CLASS_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'trait', 'module']);
const _METHOD_KINDS = new Set(['method', 'function', 'constructor', 'arrow_function']);
const _TRIVIAL_NAME_RE = /^(?:get|set|is|has)[A-Z]/;

function countParamsFromSignature(signature: string | null): number {
  if (!signature) return 0;
  const openParen = signature.indexOf('(');
  const closeParen = signature.lastIndexOf(')');
  if (openParen === -1 || closeParen <= openParen) return 0;

  const inner = signature.slice(openParen + 1, closeParen).trim();
  if (!inner) return 0;

  // Strip nested parens and generics so commas inside them don't split params
  let depth = 0;
  let cleaned = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '<' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '>' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      cleaned += '\x00';
      continue;
    }
    cleaned += ch;
  }
  return cleaned.split('\x00').filter((p) => p.trim().length > 0).length;
}

function detectGodClass(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  const classes = store.db
    .prepare(`
    SELECT s.id, s.name, s.kind, s.symbol_id, s.line_start, s.line_end,
           f.path as file_path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.kind IN ('class', 'interface', 'struct', 'trait', 'module')
      AND f.gitignored = 0
  `)
    .all() as Array<{
    id: number;
    name: string;
    kind: string;
    symbol_id: string;
    line_start: number | null;
    line_end: number | null;
    file_path: string;
  }>;

  const methodCounts = new Map<number, number>();
  for (const row of store.db
    .prepare(`
    SELECT parent_id, COUNT(*) as cnt
    FROM symbols
    WHERE parent_id IS NOT NULL
      AND kind IN ('method', 'function', 'constructor', 'arrow_function')
    GROUP BY parent_id
  `)
    .all() as Array<{ parent_id: number; cnt: number }>) {
    methodCounts.set(row.parent_id, row.cnt);
  }

  for (const cls of classes) {
    if (!matchesFilePattern(cls.file_path, data.filePattern)) continue;

    const methodCount = methodCounts.get(cls.id) ?? 0;
    const loc = (cls.line_end ?? 0) - (cls.line_start ?? 0);

    const bigByMethods = methodCount >= GOD_CLASS_METHOD_THRESHOLD;
    const bigByLoc = loc >= GOD_CLASS_LOC_THRESHOLD;
    if (!bigByMethods && !bigByLoc) continue;

    const severity: Severity = methodCount >= 40 || loc >= 800 ? 'high' : 'medium';
    const confidence = bigByMethods && bigByLoc ? 0.9 : 0.7;

    counter++;
    const reasons: string[] = [];
    if (bigByMethods) reasons.push(`${methodCount} methods`);
    if (bigByLoc) reasons.push(`${loc} lines`);

    findings.push({
      id: `GOD-${String(counter).padStart(3, '0')}`,
      category: 'god_class',
      severity,
      title: `God class: ${cls.name}`,
      description: `${cls.kind} "${cls.name}" in ${cls.file_path} has ${reasons.join(' and ')} — likely has too many responsibilities.`,
      file: cls.file_path,
      line: cls.line_start,
      related_symbols: [cls.symbol_id],
      fix: 'Extract cohesive method groups into separate classes (Single Responsibility Principle). Split the class along its natural concerns.',
      confidence,
    });
  }

  return findings;
}

function detectLongMethod(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  const methods = store.db
    .prepare(`
    SELECT s.name, s.kind, s.symbol_id, s.line_start, s.line_end, s.signature,
           f.path as file_path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.kind IN ('method', 'function', 'constructor')
      AND s.line_start IS NOT NULL
      AND s.line_end IS NOT NULL
      AND (s.line_end - s.line_start) >= ?
      AND f.gitignored = 0
  `)
    .all(LONG_METHOD_LOC_THRESHOLD) as Array<{
    name: string;
    kind: string;
    symbol_id: string;
    line_start: number;
    line_end: number;
    signature: string | null;
    file_path: string;
  }>;

  for (const m of methods) {
    if (!matchesFilePattern(m.file_path, data.filePattern)) continue;
    const loc = m.line_end - m.line_start;

    const severity: Severity = loc >= 200 ? 'high' : loc >= 100 ? 'medium' : 'low';
    const confidence = 0.6 + Math.min(0.3, (loc - LONG_METHOD_LOC_THRESHOLD) / 400);

    counter++;
    findings.push({
      id: `LM-${String(counter).padStart(3, '0')}`,
      category: 'long_method',
      severity,
      title: `Long ${m.kind}: ${m.name} (${loc} lines)`,
      description: `${m.kind} "${m.name}" in ${m.file_path} spans ${loc} lines — hard to understand and test.`,
      file: m.file_path,
      line: m.line_start,
      related_symbols: [m.symbol_id],
      fix: 'Extract cohesive steps into helper methods. A function should do one thing and fit on a screen (ideally < 40 lines).',
      confidence,
    });
  }

  return findings;
}

function detectLongParameterList(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  const callables = store.db
    .prepare(`
    SELECT s.name, s.kind, s.symbol_id, s.line_start, s.signature,
           f.path as file_path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.kind IN ('method', 'function', 'constructor', 'arrow_function')
      AND s.signature IS NOT NULL
      AND f.gitignored = 0
  `)
    .all() as Array<{
    name: string;
    kind: string;
    symbol_id: string;
    line_start: number | null;
    signature: string;
    file_path: string;
  }>;

  for (const c of callables) {
    if (!matchesFilePattern(c.file_path, data.filePattern)) continue;
    const paramCount = countParamsFromSignature(c.signature);
    if (paramCount < LONG_PARAM_LIST_THRESHOLD) continue;

    const severity: Severity = paramCount >= 10 ? 'high' : 'medium';
    const confidence = paramCount >= 8 ? 0.85 : 0.7;

    counter++;
    findings.push({
      id: `LPL-${String(counter).padStart(3, '0')}`,
      category: 'long_parameter_list',
      severity,
      title: `Long parameter list: ${c.name} (${paramCount} params)`,
      description: `${c.kind} "${c.name}" in ${c.file_path} takes ${paramCount} parameters — hard to call correctly and easy to confuse argument order.`,
      file: c.file_path,
      line: c.line_start,
      related_symbols: [c.symbol_id],
      fix: 'Group related parameters into an options/config object. Consider a builder or introduce a dedicated parameter type.',
      confidence,
    });
  }

  return findings;
}

/** Count max indentation depth in a function body. Skips string literals and comments. */
function maxIndentDepth(body: string): number {
  const lines = body.split('\n');
  if (lines.length < 2) return 0;

  // Find base indent (non-empty, non-comment-only lines)
  const contentLines = lines
    .slice(1, -1)
    .filter((l) => l.trim().length > 0 && !/^\s*(?:\/\/|#|--|\*|\/\*)/.test(l));

  if (contentLines.length === 0) return 0;

  const indents = contentLines.map((l) => {
    const m = /^(\s*)/.exec(l);
    if (!m) return 0;
    // Count indent — tab = 4 spaces
    let n = 0;
    for (const ch of m[1]) n += ch === '\t' ? 4 : 1;
    return n;
  });

  const base = Math.min(...indents);
  const maxIndent = Math.max(...indents);
  const depthLevels = Math.floor((maxIndent - base) / 2); // assume 2-space step minimum
  return depthLevels;
}

function detectDeepNesting(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  const methods = store.db
    .prepare(`
    SELECT s.name, s.kind, s.symbol_id, s.line_start, s.line_end, s.byte_start, s.byte_end,
           f.path as file_path, f.id as file_id
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.kind IN ('method', 'function')
      AND s.line_start IS NOT NULL
      AND s.line_end IS NOT NULL
      AND (s.line_end - s.line_start) >= 10
      AND f.gitignored = 0
  `)
    .all() as Array<{
    name: string;
    kind: string;
    symbol_id: string;
    line_start: number;
    line_end: number;
    byte_start: number;
    byte_end: number;
    file_path: string;
    file_id: number;
  }>;

  // Read files only once per file
  const fileContentCache = new Map<number, string>();
  const projectRoot = data.projectRoot ?? process.cwd();

  for (const m of methods) {
    if (!matchesFilePattern(m.file_path, data.filePattern)) continue;

    let content = fileContentCache.get(m.file_id);
    if (content === undefined) {
      try {
        const buf = readFileSync(path.resolve(projectRoot, m.file_path));
        if (buf.length > 512 * 1024) continue;
        content = buf.toString('utf-8');
      } catch {
        content = '';
      }
      fileContentCache.set(m.file_id, content);
    }
    if (!content) continue;

    const body = content.slice(m.byte_start, m.byte_end);
    const depth = maxIndentDepth(body);
    if (depth < DEEP_NESTING_THRESHOLD) continue;

    const severity: Severity = depth >= 8 ? 'high' : 'medium';
    const confidence = Math.min(0.9, 0.5 + (depth - DEEP_NESTING_THRESHOLD) * 0.08);

    counter++;
    findings.push({
      id: `DN-${String(counter).padStart(3, '0')}`,
      category: 'deep_nesting',
      severity,
      title: `Deep nesting in ${m.name} (depth ${depth})`,
      description: `${m.kind} "${m.name}" in ${m.file_path} has ${depth} levels of nesting — cognitive load is high and edge cases are easy to miss.`,
      file: m.file_path,
      line: m.line_start,
      related_symbols: [m.symbol_id],
      fix: 'Use early returns (guard clauses) to flatten conditionals. Extract deeply-nested blocks into helper functions.',
      confidence,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function detectAntipatterns(
  store: Store,
  projectRoot: string,
  opts: {
    category?: AntipatternCategory[];
    file_pattern?: string;
    severity_threshold?: Severity;
    limit?: number;
  } = {},
): TraceMcpResult<AntipatternResult> {
  const categories = new Set<AntipatternCategory>(
    opts.category && opts.category.length > 0 ? opts.category : ALL_CATEGORIES,
  );
  const severityThreshold = SEVERITY_ORDER[opts.severity_threshold ?? 'low'];
  const limit = opts.limit ?? 100;

  // Pre-fetch shared data
  const data = preFetch(store, opts.file_pattern, projectRoot);

  // Count of TS/JS files with callSites metadata — the real scan surface for
  // listener-leak and memory-leak detectors (they don't depend on ORM models).
  const callSiteFileCount =
    (
      store.db
        .prepare(`
    SELECT COUNT(DISTINCT s.file_id) AS n
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.metadata IS NOT NULL
      AND s.metadata LIKE '%"callSites"%'
      AND f.gitignored = 0
  `)
        .get() as { n: number } | undefined
    )?.n ?? 0;

  // Run detectors
  let findings: AntipatternFinding[] = [];
  const scope: AntipatternResult['scope_by_category'] = {};

  const ormFileCount = data.fileMap.size;
  const ormModelCount = data.models.length;

  if (categories.has('n_plus_one_risk')) {
    findings.push(...detectNPlusOne(store, data));
    scope.n_plus_one_risk = { files_scanned: ormFileCount, models_scanned: ormModelCount };
  }
  if (categories.has('missing_eager_load')) {
    findings.push(...detectMissingEagerLoad(store, data));
    scope.missing_eager_load = { files_scanned: ormFileCount, models_scanned: ormModelCount };
  }
  if (categories.has('unbounded_query')) {
    findings.push(...detectUnboundedQuery(store, data));
    scope.unbounded_query = { files_scanned: ormFileCount, models_scanned: ormModelCount };
  }
  if (categories.has('event_listener_leak')) {
    findings.push(...detectEventListenerLeak(store, data));
    scope.event_listener_leak = { files_scanned: callSiteFileCount };
  }
  if (categories.has('circular_dependency')) {
    findings.push(...detectCircularDeps(data));
    scope.circular_dependency = { files_scanned: ormFileCount, models_scanned: ormModelCount };
  }
  if (categories.has('missing_index')) {
    findings.push(...detectMissingIndex(store, data));
    scope.missing_index = { files_scanned: ormFileCount, models_scanned: ormModelCount };
  }
  if (categories.has('memory_leak')) {
    findings.push(...detectMemoryLeak(store, data));
    scope.memory_leak = { files_scanned: callSiteFileCount };
  }

  // Size / complexity detectors — operate on any symbol kind, no ORM dependency
  const symbolFileCount =
    (
      store.db
        .prepare(`
    SELECT COUNT(DISTINCT s.file_id) AS n
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE f.gitignored = 0
  `)
        .get() as { n: number } | undefined
    )?.n ?? 0;

  if (categories.has('god_class')) {
    findings.push(...detectGodClass(store, data));
    scope.god_class = { files_scanned: symbolFileCount };
  }
  if (categories.has('long_method')) {
    findings.push(...detectLongMethod(store, data));
    scope.long_method = { files_scanned: symbolFileCount };
  }
  if (categories.has('long_parameter_list')) {
    findings.push(...detectLongParameterList(store, data));
    scope.long_parameter_list = { files_scanned: symbolFileCount };
  }
  if (categories.has('deep_nesting')) {
    findings.push(...detectDeepNesting(store, data));
    scope.deep_nesting = { files_scanned: symbolFileCount };
  }

  // Inject confidence_level derived from per-finding numeric confidence
  for (const f of findings) {
    f.confidence_level = classifyNumericConfidence(f.confidence);
  }

  // Filter by severity threshold
  findings = findings.filter((f) => SEVERITY_ORDER[f.severity] <= severityThreshold);

  // Sort by severity (critical first), then confidence descending
  findings.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.confidence - a.confidence;
  });

  // Apply limit
  findings = findings.slice(0, limit);

  // Compute summary
  const summary: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) summary[f.severity]++;

  // files_analyzed = union of (ORM model files), (files with callSites metadata iff
  // listener/memory detectors ran), and (all indexed files iff size/complexity
  // detectors ran). Gives a truthful scan surface even on no-ORM projects.
  const usedCallSiteScope = categories.has('event_listener_leak') || categories.has('memory_leak');
  const usedSymbolScope =
    categories.has('god_class') ||
    categories.has('long_method') ||
    categories.has('long_parameter_list') ||
    categories.has('deep_nesting');
  const filesAnalyzed = usedSymbolScope
    ? symbolFileCount
    : ormFileCount + (usedCallSiteScope ? callSiteFileCount : 0);

  return ok({
    findings,
    summary,
    models_analyzed: ormModelCount,
    files_analyzed: filesAnalyzed,
    scope_by_category: scope,
    categories_checked: [...categories],
    _methodology: ANTIPATTERN_METHODOLOGY,
  });
}
