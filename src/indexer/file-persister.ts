/**
 * File persistence layer — extracted from IndexingPipeline.
 * Handles writing FileExtraction results to the database.
 */
import type { PipelineState } from './pipeline-state.js';
import type { FileExtraction } from './pipeline-state.js';
import type { RawEdge } from '../plugin-api/types.js';
import { indexTrigramsBatch, deleteTrigramsByFile } from '../db/fuzzy.js';

/**
 * Callback for storing raw edges — injected from the pipeline so that
 * FilePersister doesn't depend on EdgeResolver directly.
 */
type StoreRawEdgesFn = (edges: RawEdge[]) => void;

export class FilePersister {
  constructor(
    private state: PipelineState,
    private storeRawEdges: StoreRawEdgesFn,
  ) {}

  /**
   * Persist phase: write a batch of extractions to DB in a single transaction.
   * Reduces SQLite journal syncs from N to 1 per batch.
   */
  persistBatch(extractions: FileExtraction[]): void {
    this.state.store.db.transaction(() => {
      for (const ext of extractions) {
        this.persistExtraction(ext);
      }
    })();
  }

  /** Write a single file extraction to DB (must be called inside a transaction). */
  persistExtraction(ext: FileExtraction): void {
    const store = this.state.store;

    // Upsert file record
    let fileId: number;
    if (ext.existingId != null) {
      fileId = ext.existingId;

      // Fast path: if symbols are structurally identical (same symbolIds, names,
      // kinds, signatures), only update byte positions + complexity metrics.
      // This avoids the expensive delete+reinsert cycle and FTS5 trigger churn.
      if (this.tryFastSymbolUpdate(fileId, ext)) {
        this.state.changedFileIds.add(fileId);
        store.updateFileHash(fileId, ext.hash, ext.contentSize, ext.mtimeMs);
        if (ext.gitignored) store.updateFileGitignored(fileId, true);
        // Workspace may change between indexing runs (e.g., after monorepo
        // detection logic was fixed). Update even on fast path.
        if (ext.workspace) store.updateFileWorkspace(fileId, ext.workspace);
        if (ext.importEdges.length > 0) {
          store.deleteOutgoingImportEdges(fileId);
          this.state.pendingImports.set(fileId, ext.importEdges);
        }
        return;
      }

      // Full reindex path
      this.state.changedFileIds.add(fileId);
      deleteTrigramsByFile(store.db, fileId);
      store.deleteSymbolsByFile(fileId);
      // Incremental: only delete outgoing edges — incoming edges from other files
      // stay intact (e.g. imports from A→B survive when B is re-indexed).
      if (this.state.isIncremental) {
        store.deleteOutgoingEdgesForFileNodes(fileId);
      } else {
        store.deleteEdgesForFileNodes(fileId);
      }
      store.deleteEntitiesByFile(fileId);
      store.updateFileHash(fileId, ext.hash, ext.contentSize, ext.mtimeMs);
      store.updateFileStatus(fileId, ext.status, ext.frameworkRole);
      if (ext.workspace) store.updateFileWorkspace(fileId, ext.workspace);
    } else {
      fileId = store.insertFile(
        ext.relPath,
        ext.language,
        ext.hash,
        ext.contentSize,
        ext.workspace,
        ext.mtimeMs,
      );
      this.state.changedFileIds.add(fileId);
      if (ext.status !== 'ok' || ext.frameworkRole) {
        store.updateFileStatus(fileId, ext.status, ext.frameworkRole);
      }
    }

    // Flag gitignored files — indexed for graph metadata, content not served to AI
    if (ext.gitignored) {
      store.updateFileGitignored(fileId, true);
    }

    // Persist base extraction symbols, edges, and entities
    this.persistSymbolsAndEntities(fileId, ext.relPath, ext.symbols, ext.otherEdges, ext);
    if (ext.importEdges.length > 0) {
      this.state.pendingImports.set(fileId, ext.importEdges);
    }

    // Persist framework extract results
    for (const fwResult of ext.frameworkExtracts) {
      this.persistSymbolsAndEntities(
        fileId,
        ext.relPath,
        fwResult.symbols,
        fwResult.edges ?? [],
        fwResult,
      );
      if (fwResult.frameworkRole) {
        store.updateFileStatus(fileId, fwResult.status, fwResult.frameworkRole);
      }
    }
  }

  /** Insert symbols+trigrams, edges, and entities (routes/components/migrations/ORM/screens). */
  private persistSymbolsAndEntities(
    fileId: number,
    relPath: string,
    symbols: FileExtraction['symbols'],
    edges: RawEdge[],
    entities: {
      routes?: FileExtraction['routes'];
      components?: FileExtraction['components'];
      migrations?: FileExtraction['migrations'];
      ormModels?: FileExtraction['ormModels'];
      ormAssociations?: FileExtraction['ormAssociations'];
      rnScreens?: FileExtraction['rnScreens'];
    },
  ): void {
    const store = this.state.store;

    // Auto-fill missing symbolId/byteStart/byteEnd — framework plugins often
    // produce metadata-only symbols without these required fields.
    const validSymbols = symbols.map((s) => {
      if (s.symbolId && s.byteStart != null) return s;
      return {
        ...s,
        symbolId: s.symbolId || `${relPath}::${s.name}#${s.kind}`,
        byteStart: s.byteStart ?? 0,
        byteEnd: s.byteEnd ?? 0,
      };
    });
    if (validSymbols.length > 0) {
      const insertedIds = store.insertSymbols(fileId, validSymbols);
      // Deduplicate by symbolId: INSERT OR REPLACE invalidates earlier IDs when
      // duplicate symbol_ids appear in the same batch — only the last ID survives.
      const trigramBySymbolId = new Map<string, { id: number; name: string; fqn: string | null }>();
      for (let i = 0; i < validSymbols.length; i++) {
        trigramBySymbolId.set(validSymbols[i].symbolId, {
          id: insertedIds[i],
          name: validSymbols[i].name,
          fqn: validSymbols[i].fqn ?? null,
        });
      }
      indexTrigramsBatch(store.db, [...trigramBySymbolId.values()]);
    }

    if (edges.length > 0) this.storeRawEdges(edges);

    for (const r of entities.routes ?? []) store.insertRoute(r, fileId);
    for (const c of entities.components ?? []) store.insertComponent(c, fileId);
    for (const m of entities.migrations ?? []) store.insertMigration(m, fileId);
    if (entities.ormModels?.length) {
      this.storeOrmResults(entities.ormModels, entities.ormAssociations ?? [], fileId);
    }
    for (const s of entities.rnScreens ?? []) store.insertRnScreen(s, fileId);
  }

  /**
   * Fast path for incremental re-indexing: if the set of symbols is structurally
   * identical (same symbolIds, names, kinds, fqns, signatures), only update byte
   * positions and complexity metrics via UPDATE — avoids the expensive
   * delete+reinsert cycle and FTS5 trigger churn (2 FTS ops per symbol saved).
   *
   * Returns true if the fast path was taken.
   */
  tryFastSymbolUpdate(fileId: number, ext: FileExtraction): boolean {
    const store = this.state.store;

    // Only viable when there are no framework-injected symbols, edges, or entities
    // that would also need to be diffed.
    if (
      ext.frameworkExtracts.some(
        (fw) =>
          fw.symbols.length > 0 ||
          (fw.edges?.length ?? 0) > 0 ||
          (fw.routes?.length ?? 0) > 0 ||
          (fw.components?.length ?? 0) > 0 ||
          (fw.migrations?.length ?? 0) > 0 ||
          (fw.ormModels?.length ?? 0) > 0 ||
          (fw.rnScreens?.length ?? 0) > 0,
      )
    )
      return false;

    // Also skip fast path if language plugin produced entities (routes, components, etc.)
    if (
      ext.routes.length > 0 ||
      ext.components.length > 0 ||
      ext.migrations.length > 0 ||
      ext.ormModels.length > 0 ||
      ext.rnScreens.length > 0
    )
      return false;

    const existing = store.getSymbolsByFile(fileId);
    if (existing.length !== ext.symbols.length) return false;
    if (existing.length === 0) return false;

    // Build symbolId → existing row map
    const existingMap = new Map<
      string,
      { id: number; name: string; kind: string; fqn: string | null; signature: string | null }
    >();
    for (const s of existing) {
      existingMap.set(s.symbol_id, {
        id: s.id,
        name: s.name,
        kind: s.kind,
        fqn: s.fqn,
        signature: s.signature,
      });
    }

    // Verify all new symbols match an existing symbol structurally
    for (const sym of ext.symbols) {
      const ex = existingMap.get(sym.symbolId);
      if (!ex) return false;
      if (ex.name !== sym.name || ex.kind !== sym.kind) return false;
      if ((ex.fqn ?? null) !== (sym.fqn ?? null)) return false;
      if ((ex.signature ?? null) !== (sym.signature ?? null)) return false;
    }

    // All match — bulk-update positions + complexity (no FTS triggers fire
    // because name, fqn, signature, summary are untouched).
    const updateStmt = store.db.prepare(
      `UPDATE symbols
         SET byte_start = ?, byte_end = ?, line_start = ?, line_end = ?,
             cyclomatic = ?, max_nesting = ?, param_count = ?, metadata = ?
       WHERE id = ?`,
    );

    for (const sym of ext.symbols) {
      const ex = existingMap.get(sym.symbolId)!;
      const cyclomatic =
        ((sym.metadata as Record<string, unknown> | undefined)?.cyclomatic as number | undefined) ??
        null;
      const maxNesting =
        ((sym.metadata as Record<string, unknown> | undefined)?.max_nesting as
          | number
          | undefined) ?? null;
      const paramCount =
        ((sym.metadata as Record<string, unknown> | undefined)?.param_count as
          | number
          | undefined) ?? null;
      updateStmt.run(
        sym.byteStart,
        sym.byteEnd,
        sym.lineStart ?? null,
        sym.lineEnd ?? null,
        cyclomatic,
        maxNesting,
        paramCount,
        sym.metadata ? JSON.stringify(sym.metadata) : null,
        ex.id,
      );
    }

    return true;
  }

  storeOrmResults(
    models: import('../plugin-api/types.js').RawOrmModel[],
    associations: import('../plugin-api/types.js').RawOrmAssociation[],
    fileId: number,
  ): void {
    const store = this.state.store;

    // Insert models first, collect name → id map
    const modelIdMap = new Map<string, number>();
    for (const m of models) {
      const id = store.insertOrmModel(m, fileId);
      modelIdMap.set(m.name, id);
    }

    // Insert associations — resolve target ID best-effort (may be null if not indexed yet)
    for (const assoc of associations) {
      const sourceId =
        modelIdMap.get(assoc.sourceModelName) ?? store.getOrmModelByName(assoc.sourceModelName)?.id;
      if (sourceId == null) continue;

      const targetId =
        modelIdMap.get(assoc.targetModelName) ??
        store.getOrmModelByName(assoc.targetModelName)?.id ??
        null;

      store.insertOrmAssociation(
        sourceId,
        targetId,
        assoc.targetModelName,
        assoc.kind,
        assoc.options,
        fileId,
      );
    }
  }
}
