/**
 * Antipattern detector — static analysis of the indexed dependency graph
 * to find N+1 query risks, missing eager loads, unbounded queries,
 * event listener leaks, circular model dependencies, and missing indexes.
 */

import { ok, type TraceMcpResult } from '../errors.js';
import type { Store, OrmModelRow, OrmAssociationRow, FileRow, MigrationRow } from '../db/store.js';

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
  | 'memory_leak';

const ALL_CATEGORIES: AntipatternCategory[] = [
  'n_plus_one_risk',
  'missing_eager_load',
  'unbounded_query',
  'event_listener_leak',
  'circular_dependency',
  'missing_index',
  'memory_leak',
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
}

interface AntipatternResult {
  findings: AntipatternFinding[];
  summary: Record<Severity, number>;
  models_analyzed: number;
  files_analyzed: number;
  categories_checked: AntipatternCategory[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonParse<T = Record<string, unknown>>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function groupBy<T, K extends string | number>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(item);
  }
  return map;
}

/** Kinds that represent "to-many" relationships (N+1 risk). */
const MANY_KINDS = new Set([
  'hasMany', 'has_many', 'hasManyThrough', 'has_many_through',
  'belongsToMany', 'belongs_to_many',
  'ManyToMany', 'OneToMany',
  // Sequelize-specific edge names
  'sequelize_has_many', 'sequelize_belongs_to_many',
]);

/** Kinds for any relationship (eager load analysis). */
const RELATION_KINDS = new Set([
  ...MANY_KINDS,
  'hasOne', 'has_one', 'belongsTo', 'belongs_to',
  'ManyToOne', 'OneToOne',
  'ref', 'morphsTo', 'morphs_to', 'morphMany', 'morph_many',
  'sequelize_has_one', 'sequelize_belongs_to',
]);

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

/** High-cardinality table name heuristic. */
const HIGH_CARDINALITY_PATTERNS = /^(logs?|events?|messages?|notifications?|activities|audit|metrics|jobs|queue|sessions?|clicks?|views?|requests?)$/i;

/** Add/remove listener pairs for leak detection.
 *  sigText and allNames are lowercased, so patterns must be case-insensitive. */
const LISTENER_PAIRS: [RegExp, RegExp, string][] = [
  [/addeventlistener\s*\(/i, /removeeventlistener\s*\(/i, 'addEventListener without removeEventListener'],
  [/\.on\s*\(/i, /\.off\s*\(|\.removelistener\s*\(|\.removealllisteners\s*\(/i, '.on() without .off()/.removeListener()'],
  [/\.subscribe\s*\(/i, /\.unsubscribe\s*\(|\.complete\s*\(/i, '.subscribe() without .unsubscribe()'],
  [/setinterval\s*\(/i, /clearinterval\s*\(/i, 'setInterval without clearInterval'],
  [/settimeout\s*\(/i, /cleartimeout\s*\(/i, 'setTimeout without clearTimeout (in class/component)'],
];

// ---------------------------------------------------------------------------
// Shared pre-fetched data
// ---------------------------------------------------------------------------

interface PreFetchedData {
  models: OrmModelRow[];
  modelMap: Map<number, OrmModelRow>;
  assocByModel: Map<number, OrmAssociationRow[]>;
  fileMap: Map<number, FileRow>;
  filePattern?: string;
}

function preFetch(store: Store, filePattern?: string): PreFetchedData {
  const models = store.getAllOrmModels();
  const modelMap = new Map(models.map(m => [m.id, m]));
  const allAssociations = store.getAllOrmAssociations();
  const assocByModel = groupBy(allAssociations, a => a.source_model_id);

  const fileIds = [...new Set(models.map(m => m.file_id))];
  const fileMap = store.getFilesByIds(fileIds);

  return { models, modelMap, assocByModel, fileMap, filePattern };
}

function matchesFilePattern(filePath: string, pattern?: string): boolean {
  if (!pattern) return true;
  const likePattern = pattern.replace(/\*/g, '').toLowerCase();
  return filePath.toLowerCase().includes(likePattern);
}

// ---------------------------------------------------------------------------
// Detector 1: N+1 Query Risk
// ---------------------------------------------------------------------------

function detectNPlusOne(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  // Get node IDs for all models in one batch
  const modelIds = data.models.map(m => m.id);
  const modelNodeIds = store.getNodeIdsBatch('orm_model', modelIds);

  // For each model, check its to-many associations
  for (const model of data.models) {
    const file = data.fileMap.get(model.file_id);
    if (!file || !matchesFilePattern(file.path, data.filePattern)) continue;

    const assocs = data.assocByModel.get(model.id) ?? [];
    const manyAssocs = assocs.filter(a => MANY_KINDS.has(a.kind));
    if (manyAssocs.length === 0) continue;

    const modelNodeId = modelNodeIds.get(model.id);
    if (!modelNodeId) continue;

    // Check incoming edges to see who accesses this model
    const incoming = store.getIncomingEdges(modelNodeId);
    const callerNodeIds = incoming.map(e => e.source_node_id);

    // Resolve callers to check if they're controllers/services
    const callerRefs = callerNodeIds.length > 0 ? store.getNodeRefsBatch(callerNodeIds) : new Map();
    const callerSymIds = [...callerRefs.values()]
      .filter(r => r.nodeType === 'symbol')
      .map(r => r.refId);
    const callerSyms = callerSymIds.length > 0 ? store.getSymbolsByIds(callerSymIds) : new Map();

    for (const assoc of manyAssocs) {
      const hasEager = hasEagerLoadHint(assoc, model);
      if (hasEager) continue;

      // Check if any caller looks like a controller/service/handler
      let accessedFromHandler = false;
      const relatedSymbols: string[] = [];

      for (const sym of callerSyms.values()) {
        const symMeta = jsonParse(sym.metadata);
        const isHandler = sym.kind === 'method' || sym.kind === 'function'
          || (symMeta?.['frameworkRole'] as string)?.includes('controller')
          || (symMeta?.['frameworkRole'] as string)?.includes('handler');
        if (isHandler) {
          accessedFromHandler = true;
          relatedSymbols.push(sym.symbol_id);
        }
      }

      let confidence = 0.6;
      if (!hasEager) confidence += 0.2;
      if (manyAssocs.length > 1) confidence += 0.1;
      if (accessedFromHandler) confidence += 0.1;
      confidence = Math.min(confidence, 1.0);

      const targetName = assoc.target_model_name ?? `model#${assoc.target_model_id}`;
      counter++;
      findings.push({
        id: `NP1-${String(counter).padStart(3, '0')}`,
        category: 'n_plus_one_risk',
        severity: 'high',
        title: `N+1 risk: ${model.name}.${assoc.kind}(${targetName})`,
        description: `Model "${model.name}" has a ${assoc.kind} relationship to "${targetName}" without eager loading. ` +
          `When iterating over ${model.name} records, each access to the "${targetName}" relationship triggers a separate query.`,
        file: file.path,
        line: assoc.line,
        model: model.name,
        orm: model.orm,
        related_symbols: relatedSymbols.length > 0 ? relatedSymbols : undefined,
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
    const relations = assocs.filter(a => RELATION_KINDS.has(a.kind));
    if (relations.length < 2) continue;

    const uneager = relations.filter(a => !hasEagerLoadHint(a, model));
    if (uneager.length === 0) continue;

    // Count how many files access this model via incoming edges
    const modelNodeId = store.getNodeId('orm_model', model.id);
    let accessorFileCount = 0;
    if (modelNodeId) {
      const incoming = store.getIncomingEdges(modelNodeId);
      const refs = store.getNodeRefsBatch(incoming.map(e => e.source_node_id));
      const symIds = [...refs.values()].filter(r => r.nodeType === 'symbol').map(r => r.refId);
      if (symIds.length > 0) {
        const syms = store.getSymbolsByIds(symIds);
        accessorFileCount = new Set([...syms.values()].map(s => s.file_id)).size;
      }
    }

    const confidence = accessorFileCount >= 3 ? 0.7 : 0.5;

    counter++;
    findings.push({
      id: `MEL-${String(counter).padStart(3, '0')}`,
      category: 'missing_eager_load',
      severity: 'medium',
      title: `${model.name}: ${uneager.length}/${relations.length} relationships lack eager loading`,
      description: `Model "${model.name}" has ${relations.length} relationships but ${uneager.length} have no eager loading configured. ` +
        `This can lead to N+1 queries when relationships are accessed lazily.` +
        (accessorFileCount >= 3 ? ` The model is accessed from ${accessorFileCount} different files.` : ''),
      file: file.path,
      line: null,
      model: model.name,
      orm: model.orm,
      fix: `Review relationships on ${model.name} and configure eager loading for frequently accessed ones: ` +
        uneager.map(a => a.target_model_name ?? a.kind).join(', '),
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
      opts?.['perPage'] != null
      || opts?.['defaultScope']?.['limit'] != null
      || meta?.['perPage'] != null
      || meta?.['paginate'] === true;

    if (hasPagination) continue;

    // Check if table name suggests high cardinality
    const isHighCardinality = HIGH_CARDINALITY_PATTERNS.test(tableName);

    // Check routes that point to controllers using this model
    const modelNodeId = store.getNodeId('orm_model', model.id);
    let routeAccessCount = 0;
    if (modelNodeId) {
      const incoming = store.getIncomingEdges(modelNodeId);
      const routeEdges = incoming.filter(e =>
        e.edge_type_name === 'routes_to' || e.edge_type_name === 'calls' || e.edge_type_name === 'references',
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
      description: `Model "${model.name}" has no default pagination or limit configured. ` +
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

  // Phase A: Graph-based — look for listener edge types without cleanup
  const listenerEdgeTypes = [
    'listens_to', 'livewire_listens', 'socketio_event',
    'mongoose_has_middleware', 'sequelize_has_hook',
    'nest_gateway_event',
  ];

  for (const edgeType of listenerEdgeTypes) {
    const edges = store.getEdgesByType(edgeType);
    if (edges.length === 0) continue;

    const sourceNodeIds = edges.map(e => e.source_node_id);
    const refs = store.getNodeRefsBatch(sourceNodeIds);
    const symIds = [...refs.values()].filter(r => r.nodeType === 'symbol').map(r => r.refId);
    const syms = symIds.length > 0 ? store.getSymbolsByIds(symIds) : new Map();
    const fileIds = [...new Set([...syms.values()].map(s => s.file_id))];
    const files = fileIds.length > 0 ? store.getFilesByIds(fileIds) : new Map();

    for (const edge of edges) {
      const ref = refs.get(edge.source_node_id);
      if (!ref || ref.nodeType !== 'symbol') continue;
      const sym = syms.get(ref.refId);
      if (!sym) continue;
      const file = files.get(sym.file_id);
      if (!file || !matchesFilePattern(file.path, data.filePattern)) continue;

      // Hooks/middleware are typically managed by the framework — lower severity
      const isFrameworkManaged = edgeType === 'mongoose_has_middleware'
        || edgeType === 'sequelize_has_hook';

      if (isFrameworkManaged) continue; // Skip framework-managed hooks

      counter++;
      findings.push({
        id: `ELL-${String(counter).padStart(3, '0')}`,
        category: 'event_listener_leak',
        severity: 'high',
        title: `Potential listener leak: ${sym.name} (${edgeType})`,
        description: `Symbol "${sym.name}" registers a ${edgeType} handler. Verify that the listener is properly cleaned up on disposal/unmount.`,
        file: file.path,
        line: sym.line_start,
        related_symbols: [sym.symbol_id],
        fix: `Ensure matching cleanup (removeListener/off/unsubscribe/dispose) in teardown/unmount lifecycle`,
        confidence: 0.6,
      });
    }
  }

  // Phase B: Pattern-based — search symbol metadata for add/remove listener patterns
  // We scan symbols whose names or signatures suggest listener registration
  const listenerSymbols = store.db.prepare(`
    SELECT s.*, f.path as file_path FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE (s.name LIKE '%addEventListener%'
      OR s.name LIKE '%subscribe%'
      OR s.name LIKE '%setInterval%'
      OR s.name LIKE '%useEffect%'
      OR s.signature LIKE '%addEventListener%'
      OR s.signature LIKE '%subscribe(%'
      OR s.signature LIKE '%setInterval(%')
    AND f.gitignored = 0
  `).all() as Array<{ id: number; file_id: number; name: string; kind: string; symbol_id: string; line_start: number | null; signature: string | null; file_path: string }>;

  // Group by file to check for cleanup pairs
  const byFile = groupBy(listenerSymbols, s => s.file_id);

  for (const [fileId, syms] of byFile) {
    const filePath = syms[0]?.file_path;
    if (!filePath || !matchesFilePattern(filePath, data.filePattern)) continue;

    // Check all symbols in this file for cleanup patterns
    const allFileSyms = store.getSymbolsByFile(fileId);
    const allNames = allFileSyms.map(s => s.name + ' ' + (s.signature ?? '')).join(' ');

    // Also check related files (files that import this one) for cleanup patterns
    const fileNodeId = store.getNodeId('file', fileId);
    let crossFileNames = '';
    if (fileNodeId) {
      const incomingEdges = store.getIncomingEdges(fileNodeId);
      const importerNodeIds = incomingEdges
        .filter(e => e.edge_type_name === 'esm_imports' || e.edge_type_name === 'imports')
        .map(e => e.source_node_id);
      if (importerNodeIds.length > 0) {
        const importerRefs = store.getNodeRefsBatch(importerNodeIds);
        const importerFileIds = [...importerRefs.values()]
          .filter(r => r.nodeType === 'file')
          .map(r => r.refId);
        for (const impFileId of importerFileIds) {
          const impSyms = store.getSymbolsByFile(impFileId);
          crossFileNames += ' ' + impSyms.map(s => s.name + ' ' + (s.signature ?? '')).join(' ');
        }
      }
    }
    const combinedNames = allNames + ' ' + crossFileNames;

    for (const sym of syms) {
      const sigText = (sym.name + ' ' + (sym.signature ?? '')).toLowerCase();

      for (const [addPattern, removePattern, label] of LISTENER_PAIRS) {
        if (!addPattern.test(sigText)) continue;
        // Check cleanup in same file AND in importing files
        if (removePattern.test(combinedNames)) continue;

        counter++;
        findings.push({
          id: `ELL-${String(counter).padStart(3, '0')}`,
          category: 'event_listener_leak',
          severity: 'high',
          title: `${label} in ${sym.name}`,
          description: `"${sym.name}" in ${filePath} registers a listener but no corresponding cleanup was found in the same file or importing files.`,
          file: filePath,
          line: sym.line_start,
          related_symbols: [sym.symbol_id],
          fix: `Add corresponding cleanup call in teardown/unmount/destructor`,
          confidence: 0.6,
        });
        break; // One finding per symbol
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
      .map(id => data.modelMap.get(id))
      .filter((m): m is OrmModelRow => m != null);

    if (modelNames.length === 0) continue;

    const first = modelNames[0];
    const file = data.fileMap.get(first.file_id);
    if (!file || !matchesFilePattern(file.path, data.filePattern)) continue;

    const cycle = modelNames.map(m => m.name).join(' → ') + ' → ' + modelNames[0].name;
    counter++;
    findings.push({
      id: `CYC-${String(counter).padStart(3, '0')}`,
      category: 'circular_dependency',
      severity: 'low',
      title: `Circular model dependency: ${modelNames.map(m => m.name).join(', ')}`,
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
  const migByTable = groupBy(allMigrations, m => m.table_name);

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
      const fk = opts?.['foreignKey'] as string | undefined;
      if (!fk) continue;

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
        title: `Missing index on FK: ${tableName}.${fk}`,
        description: `Foreign key "${fk}" on table "${tableName}" (from ${model.name}.${assoc.kind}) has no corresponding index in migrations. ` +
          `JOINs and relationship lookups on this column will be slow on large tables.`,
        file: file.path,
        line: assoc.line,
        model: model.name,
        orm: model.orm,
        fix: `Add a migration to create an index on "${tableName}"."${fk}"`,
        confidence: 0.6,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Detector 7: Memory Leak Patterns
// ---------------------------------------------------------------------------

/** Patterns that suggest potential memory leaks via unbounded growth. */
const MEMORY_LEAK_PATTERNS: { regex: RegExp; label: string; severity: Severity; description: string; fix: string }[] = [
  // Growing caches without eviction
  {
    regex: /\.(set|push|add)\s*\(/i,
    label: 'Unbounded cache/collection growth',
    severity: 'medium',
    description: 'adds to a Map/Set/Array without size limits or eviction — can grow indefinitely in long-running processes.',
    fix: 'Add a max size check and eviction policy (LRU, TTL) or use WeakMap/WeakRef.',
  },
  // Module-level mutable Map/Set/Array (likely cache)
  {
    regex: /^(?:const|let|var)\s+\w+\s*=\s*new\s+(?:Map|Set)\s*\(/i,
    label: 'Module-level Map/Set (potential unbounded cache)',
    severity: 'low',
    description: 'declares a module-level Map/Set. If items are added during request handling without cleanup, this grows unboundedly.',
    fix: 'Consider WeakMap/WeakRef for caches, or add TTL-based eviction.',
  },
];

/** SQL patterns for symbol body search to find memory-leaky patterns. */
function detectMemoryLeak(store: Store, data: PreFetchedData): AntipatternFinding[] {
  const findings: AntipatternFinding[] = [];
  let counter = 0;

  // Strategy 1: Find module-level Map/Set/Array that have .set/.push/.add calls
  // without any .delete/.clear/.splice calls in the same file.
  const cacheSymbols = store.db.prepare(`
    SELECT s.id, s.name, s.kind, s.symbol_id, s.line_start, s.signature,
           f.path as file_path, f.id as file_id
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE (s.signature LIKE '%new Map%'
      OR s.signature LIKE '%new Set%'
      OR s.signature LIKE '%: Map<%'
      OR s.signature LIKE '%: Set<%'
      OR s.name LIKE '%cache%'
      OR s.name LIKE '%Cache%'
      OR s.name LIKE '%registry%'
      OR s.name LIKE '%Registry%'
      OR s.name LIKE '%store%'
      OR s.name LIKE '%pool%')
    AND s.kind IN ('variable', 'property')
    AND f.gitignored = 0
  `).all() as Array<{
    id: number; name: string; kind: string; symbol_id: string;
    line_start: number | null; signature: string | null;
    file_path: string; file_id: number;
  }>;

  // Group by file
  const byFile = groupBy(cacheSymbols, s => s.file_id);

  for (const [fileId, syms] of byFile) {
    const filePath = syms[0]?.file_path;
    if (!filePath || !matchesFilePattern(filePath, data.filePattern)) continue;

    // Check all symbols in this file for cleanup patterns
    const allFileSyms = store.getSymbolsByFile(fileId);
    const allText = allFileSyms.map(s => s.name + ' ' + (s.signature ?? '')).join(' ');

    const hasCleanup = /\.delete\s*\(|\.clear\s*\(|\.splice\s*\(|\.shift\s*\(|\.pop\s*\(|weakmap|weakset|weakref|lru|ttl|maxsize|max_size|evict/i.test(allText);
    if (hasCleanup) continue;

    // Check if there are .set/.push/.add calls — signs of growth
    const hasGrowth = /\.set\s*\(|\.push\s*\(|\.add\s*\(/i.test(allText);
    if (!hasGrowth) continue;

    for (const sym of syms) {
      counter++;
      findings.push({
        id: `MEM-${String(counter).padStart(3, '0')}`,
        category: 'memory_leak',
        severity: 'medium',
        title: `Potential unbounded cache: ${sym.name}`,
        description: `"${sym.name}" in ${filePath} is a Map/Set/cache-like variable that grows (has .set/.push/.add calls) but no eviction (no .delete/.clear or size limit found in the same file).`,
        file: filePath,
        line: sym.line_start,
        related_symbols: [sym.symbol_id],
        fix: 'Add a max size check and eviction policy (LRU, TTL), or use WeakMap/WeakRef for object keys.',
        confidence: 0.5,
      });
    }
  }

  // Strategy 2: Detect closure-over-mutable patterns in event handlers
  // Look for symbols that are event handlers and reference outer-scope mutable state
  const closureLeakSymbols = store.db.prepare(`
    SELECT s.id, s.name, s.symbol_id, s.line_start, s.signature,
           f.path as file_path, f.id as file_id
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE (s.signature LIKE '%=>\s*{%' OR s.signature LIKE '%function%')
    AND (s.signature LIKE '%.on(%' OR s.signature LIKE '%addEventListener%'
      OR s.signature LIKE '%subscribe%' OR s.signature LIKE '%setInterval%')
    AND s.signature LIKE '%push%'
    AND f.gitignored = 0
  `).all() as Array<{
    id: number; name: string; symbol_id: string;
    line_start: number | null; signature: string | null;
    file_path: string; file_id: number;
  }>;

  for (const sym of closureLeakSymbols) {
    if (!matchesFilePattern(sym.file_path, data.filePattern)) continue;

    counter++;
    findings.push({
      id: `MEM-${String(counter).padStart(3, '0')}`,
      category: 'memory_leak',
      severity: 'high',
      title: `Closure retains growing array: ${sym.name}`,
      description: `"${sym.name}" in ${sym.file_path} is an event handler that pushes to a collection in its closure. Each event invocation grows the collection without cleanup.`,
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
// Main entry point
// ---------------------------------------------------------------------------

export function detectAntipatterns(
  store: Store,
  _projectRoot: string,
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
  const data = preFetch(store, opts.file_pattern);

  // Run detectors
  let findings: AntipatternFinding[] = [];

  if (categories.has('n_plus_one_risk')) findings.push(...detectNPlusOne(store, data));
  if (categories.has('missing_eager_load')) findings.push(...detectMissingEagerLoad(store, data));
  if (categories.has('unbounded_query')) findings.push(...detectUnboundedQuery(store, data));
  if (categories.has('event_listener_leak')) findings.push(...detectEventListenerLeak(store, data));
  if (categories.has('circular_dependency')) findings.push(...detectCircularDeps(data));
  if (categories.has('missing_index')) findings.push(...detectMissingIndex(store, data));
  if (categories.has('memory_leak')) findings.push(...detectMemoryLeak(store, data));

  // Filter by severity threshold
  findings = findings.filter(f => SEVERITY_ORDER[f.severity] <= severityThreshold);

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

  // Collect unique files analyzed
  const analyzedFiles = new Set<string>(findings.map(f => f.file));
  // Also count model files even if no findings
  for (const f of data.fileMap.values()) analyzedFiles.add(f.path);

  return ok({
    findings,
    summary,
    models_analyzed: data.models.length,
    files_analyzed: analyzedFiles.size,
    categories_checked: [...categories],
  });
}
