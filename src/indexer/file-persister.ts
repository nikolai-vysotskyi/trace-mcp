/**
 * File persistence layer — extracted from IndexingPipeline.
 * Handles writing FileExtraction results to the database.
 */

import { deleteTrigramsByFile, indexTrigramsBatch } from '../db/fuzzy.js';
import type { RawEdge } from '../plugin-api/types.js';
import type { FileExtraction, PipelineState } from './pipeline-state.js';

/**
 * Callback for storing raw edges — injected from the pipeline so that
 * FilePersister doesn't depend on EdgeResolver directly.
 */
type StoreRawEdgesFn = (edges: RawEdge[]) => void;

export class FilePersister {
  /**
   * Per-batch tracking of new symbol names (name → set of symbol ids). Populated
   * during persistBatch by diffing old vs new symbol rows per file. Read by the
   * pipeline to build ChangeScope.newSymbolNames so resolvers can rebind
   * previously-dangling text-name references that NOW match a real symbol.
   */
  newSymbolNames = new Map<string, Set<number>>();
  /**
   * Per-batch tracking of deleted symbol names (name → set of symbol ids).
   * The ids are the OLD row ids that no longer exist after this batch — useful
   * for phantom-unbind: edges resolved to one of these ids must be cleared.
   */
  deletedSymbolNames = new Map<string, Set<number>>();
  /**
   * Scratch map: file_id → pre-delete (name, id) pairs. Captured before the
   * file's symbols are deleted; consumed right after persistSymbolsAndEntities
   * inserts the new symbols, so we can diff old vs new names per file.
   */
  private _pendingOldNames = new Map<number, Array<{ name: string; id: number }>>();

  constructor(
    private state: PipelineState,
    private storeRawEdges: StoreRawEdgesFn,
  ) {}

  /**
   * Persist phase: write a batch of extractions to DB in a single transaction.
   * Reduces SQLite journal syncs from N to 1 per batch. Resets symbol-name
   * churn tracking at the start so each call's ChangeScope reflects only the
   * current batch.
   */
  persistBatch(extractions: FileExtraction[]): void {
    this.newSymbolNames.clear();
    this.deletedSymbolNames.clear();
    this._pendingOldNames.clear();
    this.state.store.db.transaction(() => {
      for (const ext of extractions) {
        this.persistExtraction(ext);
      }
    })();
  }

  /**
   * Diff the pre-delete name snapshot vs the post-insert symbol set, pushing
   * each name into newSymbolNames / deletedSymbolNames. Called once per
   * persistExtraction after persistSymbolsAndEntities has populated the DB.
   */
  private commitNameChurn(fileId: number): void {
    // For brand-new files (no existingId path) _pendingOldNames has no entry —
    // treat oldNames as empty so every inserted symbol counts as new.
    const oldNames = this._pendingOldNames.get(fileId) ?? [];
    this._pendingOldNames.delete(fileId);
    const oldByName = new Map<string, Set<number>>();
    for (const { name, id } of oldNames) {
      let s = oldByName.get(name);
      if (!s) {
        s = new Set();
        oldByName.set(name, s);
      }
      s.add(id);
    }
    const newSyms = this.state.store.getSymbolsByFile(fileId);
    const newNames = new Set<string>();
    for (const s of newSyms) {
      newNames.add(s.name);
      if (!oldByName.has(s.name)) this.trackNewName(s.name, s.id);
    }
    for (const { name, id } of oldNames) {
      if (!newNames.has(name)) this.trackDeletedName(name, id);
    }
  }

  /** Record a name → id pair as a new symbol (created this batch). */
  private trackNewName(name: string, id: number): void {
    let s = this.newSymbolNames.get(name);
    if (!s) {
      s = new Set();
      this.newSymbolNames.set(name, s);
    }
    s.add(id);
  }

  /** Record a name → id pair as a deleted symbol (removed this batch). */
  private trackDeletedName(name: string, id: number): void {
    let s = this.deletedSymbolNames.get(name);
    if (!s) {
      s = new Set();
      this.deletedSymbolNames.set(name, s);
    }
    s.add(id);
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

      // Full reindex path — capture pre-delete names so we can diff against
      // the post-insert names and surface newSymbolNames / deletedSymbolNames
      // for phantom-rebind/unbind.
      const oldNames = store.getSymbolsByFile(fileId).map((s) => ({ name: s.name, id: s.id }));
      this.state.changedFileIds.add(fileId);
      deleteTrigramsByFile(store.db, fileId);
      store.deleteSymbolsByFile(fileId);
      // Stash for post-insert diffing — applied after persistSymbolsAndEntities
      // populates the new symbol rows.
      this._pendingOldNames.set(fileId, oldNames);
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
    // Phase 4 phantom-rebind: diff old vs new symbol names for this file now
    // that both states are visible in the DB.
    this.commitNameChurn(fileId);
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
