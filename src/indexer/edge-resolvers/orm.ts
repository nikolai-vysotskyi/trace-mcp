/** Pass 2b: Convert ORM associations into graph edges. */
import type { PipelineState } from '../pipeline-state.js';

export function resolveOrmAssociationEdges(state: PipelineState): void {
  const { store } = state;
  const changedFileIds =
    state.isIncremental && state.changedFileIds.size > 0
      ? Array.from(state.changedFileIds)
      : undefined;
  const associations = store.getAllOrmAssociations(changedFileIds);
  if (associations.length === 0) return;

  const allModels = store.getAllOrmModels();
  const modelOrmMap = new Map<number, string>();
  for (const m of allModels) modelOrmMap.set(m.id, m.orm);

  const ormKindToEdgeType: Record<string, Record<string, string>> = {
    mongoose: { ref: 'mongoose_references', discriminator: 'mongoose_discriminates' },
    sequelize: {
      hasMany: 'sequelize_has_many',
      belongsTo: 'sequelize_belongs_to',
      belongsToMany: 'sequelize_belongs_to_many',
      hasOne: 'sequelize_has_one',
    },
    typeorm: {
      OneToMany: 'typeorm_one_to_many',
      ManyToOne: 'typeorm_many_to_one',
      OneToOne: 'typeorm_one_to_one',
      ManyToMany: 'typeorm_many_to_many',
    },
    prisma: { hasMany: 'prisma_relation', belongsTo: 'prisma_relation' },
    drizzle: { hasMany: 'drizzle_relation', belongsTo: 'drizzle_relation' },
  };

  const modelNameMap = new Map<string, number>();
  for (const m of allModels) modelNameMap.set(m.name, m.id);

  const allModelIds = allModels.map((m) => m.id);
  const ormNodeMap = store.getNodeIdsBatch('orm_model', allModelIds);

  const edgeTypeCache = new Map<string, number>();
  const edgeTypeStmt = store.db.prepare('SELECT id FROM edge_types WHERE name = ?');
  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, NULL, 0)`,
  );

  store.db.transaction(() => {
    for (const assoc of associations) {
      let targetModelId = assoc.target_model_id;
      if (targetModelId == null && assoc.target_model_name) {
        targetModelId = modelNameMap.get(assoc.target_model_name) ?? null;
      }
      if (targetModelId == null) continue;

      const sourceNodeId = ormNodeMap.get(assoc.source_model_id);
      const targetNodeId = ormNodeMap.get(targetModelId);
      if (sourceNodeId == null || targetNodeId == null) continue;

      const orm = modelOrmMap.get(assoc.source_model_id) ?? 'unknown';
      const ormMap = ormKindToEdgeType[orm];
      const edgeType = ormMap?.[assoc.kind] ?? `orm_${assoc.kind}`;

      let edgeTypeId = edgeTypeCache.get(edgeType);
      if (edgeTypeId == null) {
        const row = edgeTypeStmt.get(edgeType) as { id: number } | undefined;
        if (!row) continue;
        edgeTypeId = row.id;
        edgeTypeCache.set(edgeType, edgeTypeId);
      }

      insertStmt.run(sourceNodeId, targetNodeId, edgeTypeId);
    }
  })();
}
