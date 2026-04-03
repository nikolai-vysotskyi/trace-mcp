/**
 * get_model_context tool — assembles full context for an Eloquent, Mongoose, or Sequelize model.
 * Returns model symbol + relationships + schema + related controllers/requests.
 */
import type { Store, SymbolRow, OrmModelRow, OrmAssociationRow } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';

export interface ModelRelationship {
  type: string;      // edge type name: has_many, belongs_to, etc.
  relatedModel: string;
  relatedSymbolId?: string;
  method?: string;
}

export interface ModelSchema {
  tableName: string;
  columns: Record<string, unknown>[];
  operation: string;
  timestamp?: string;
}

export interface ModelContextResult {
  model: {
    name: string;
    fqn: string;
    symbolId: string;
    filePath: string;
    orm?: string;
    collection?: string;
  };
  relationships: ModelRelationship[];
  schema: ModelSchema[];
  relatedControllers: { name: string; symbolId: string; fqn: string | null }[];
  relatedRequests: { name: string; symbolId: string; fqn: string | null }[];
  ormMetadata?: Record<string, unknown>;
}

export function getModelContext(
  store: Store,
  modelName: string,
): TraceMcpResult<ModelContextResult> {
  // --- Try Mongoose / Sequelize ORM models first ---
  const ormModel = store.getOrmModelByName(modelName);
  if (ormModel) {
    return buildOrmModelContext(store, ormModel);
  }

  // --- Fall back to Eloquent (symbol-based) ---
  let modelSymbol: SymbolRow | undefined;

  modelSymbol = store.getSymbolByFqn(modelName);
  if (!modelSymbol) {
    modelSymbol = store.getSymbolByFqn(`App\\Models\\${modelName}`);
  }
  if (!modelSymbol) {
    const allSymbols = store.db.prepare(
      "SELECT * FROM symbols WHERE name = ? AND kind = 'class'",
    ).all(modelName) as SymbolRow[];
    modelSymbol = allSymbols[0];
  }

  if (!modelSymbol) {
    return err(notFound(`model:${modelName}`));
  }

  const file = store.getFileById(modelSymbol.file_id);
  if (!file) {
    return err(notFound(`file for model:${modelName}`));
  }

  const relationships = getRelationships(store, modelSymbol);
  const schema = getModelSchema(store, modelName);
  const relatedControllers = getRelatedByRole(store, modelSymbol, 'controller');
  const relatedRequests = getRelatedByRole(store, modelSymbol, 'form_request');

  return ok({
    model: {
      name: modelSymbol.name,
      fqn: modelSymbol.fqn ?? modelSymbol.name,
      symbolId: modelSymbol.symbol_id,
      filePath: file.path,
    },
    relationships,
    schema,
    relatedControllers,
    relatedRequests,
  });
}

function buildOrmModelContext(
  store: Store,
  ormModel: OrmModelRow,
): TraceMcpResult<ModelContextResult> {
  const file = store.getFileById(ormModel.file_id);
  const metadata: Record<string, unknown> = ormModel.metadata
    ? JSON.parse(ormModel.metadata)
    : {};

  // Associations from orm_associations table
  const assocRows: OrmAssociationRow[] = store.getOrmAssociationsByModel(ormModel.id);
  const relationships: ModelRelationship[] = assocRows.map((a) => ({
    type: a.kind,
    relatedModel: a.target_model_name ?? '',
    method: a.options ? (JSON.parse(a.options) as { as?: string }).as : undefined,
  }));

  // Schema from fields column (Mongoose/Sequelize)
  const fields: Record<string, unknown>[] = ormModel.fields
    ? JSON.parse(ormModel.fields)
    : [];

  const schema: ModelSchema[] = fields.length > 0
    ? [{
        tableName: ormModel.collection_or_table ?? ormModel.name.toLowerCase() + 's',
        columns: fields,
        operation: 'schema',
      }]
    : [];

  return ok({
    model: {
      name: ormModel.name,
      fqn: ormModel.name,
      symbolId: `orm:${ormModel.name}`,
      filePath: file?.path ?? '',
      orm: ormModel.orm,
      collection: ormModel.collection_or_table ?? undefined,
    },
    relationships,
    schema,
    relatedControllers: [],
    relatedRequests: [],
    ormMetadata: metadata,
  });
}

function getRelationships(store: Store, modelSymbol: SymbolRow): ModelRelationship[] {
  const relationships: ModelRelationship[] = [];
  const nodeId = store.getNodeId('symbol', modelSymbol.id);
  if (!nodeId) return relationships;

  const relEdgeTypes = ['has_many', 'belongs_to', 'belongs_to_many', 'has_one', 'morphs_to'];

  const outEdges = store.getOutgoingEdges(nodeId);
  for (const edge of outEdges) {
    if (!relEdgeTypes.includes(edge.edge_type_name)) continue;

    const targetNode = store.getNodeByNodeId(edge.target_node_id);
    if (!targetNode || targetNode.node_type !== 'symbol') continue;

    const targetSym = store.getSymbolById(targetNode.ref_id);
    if (!targetSym) continue;

    const metadata = edge.metadata ? JSON.parse(edge.metadata) : {};
    relationships.push({
      type: edge.edge_type_name,
      relatedModel: targetSym.fqn ?? targetSym.name,
      relatedSymbolId: targetSym.symbol_id,
      method: metadata.method,
    });
  }

  // Also check incoming edges (e.g. belongs_to from other models)
  const inEdges = store.getIncomingEdges(nodeId);
  for (const edge of inEdges) {
    if (!relEdgeTypes.includes(edge.edge_type_name)) continue;

    const sourceNode = store.getNodeByNodeId(edge.source_node_id);
    if (!sourceNode || sourceNode.node_type !== 'symbol') continue;

    const sourceSym = store.getSymbolById(sourceNode.ref_id);
    if (!sourceSym) continue;

    const metadata = edge.metadata ? JSON.parse(edge.metadata) : {};
    relationships.push({
      type: `inverse:${edge.edge_type_name}`,
      relatedModel: sourceSym.fqn ?? sourceSym.name,
      relatedSymbolId: sourceSym.symbol_id,
      method: metadata.method,
    });
  }

  return relationships;
}

function getModelSchema(store: Store, modelName: string): ModelSchema[] {
  // Guess table name from model name (e.g. User -> users, BlogPost -> blog_posts)
  const tableName = modelNameToTable(modelName);
  const migrations = store.getMigrationsByTable(tableName);

  return migrations.map((m) => ({
    tableName: m.table_name,
    columns: m.columns ? JSON.parse(m.columns) : [],
    operation: m.operation,
    timestamp: m.timestamp ?? undefined,
  }));
}

function getRelatedByRole(
  store: Store,
  _modelSymbol: SymbolRow,
  _role: string,
): { name: string; symbolId: string; fqn: string | null }[] {
  // For now, return empty — this requires more complex graph traversal
  // that would need checking file framework_roles
  return [];
}

/** Convert a model class name to a table name (simple pluralization). */
function modelNameToTable(name: string): string {
  // Strip namespace
  const short = name.includes('\\') ? name.split('\\').pop()! : name;
  // Simple snake_case + plural
  const snake = short.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  // Very simple pluralization
  if (snake.endsWith('y')) return snake.slice(0, -1) + 'ies';
  if (snake.endsWith('s')) return snake;
  return snake + 's';
}
