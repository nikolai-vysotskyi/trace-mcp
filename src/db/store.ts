import type Database from 'better-sqlite3';
import type { RawSymbol, RawEdge, RawRoute, RawComponent, RawMigration, RawOrmModel, RawOrmAssociation, RawRnScreen } from '../plugin-api/types.js';
import type { TraceMcpResult } from '../errors.js';

import { FileRepository } from './repositories/file-repository.js';
import { SymbolRepository } from './repositories/symbol-repository.js';
import { GraphRepository } from './repositories/graph-repository.js';
import { DomainRepository } from './repositories/domain-repository.js';
import { AnalyticsRepository } from './repositories/analytics-repository.js';

export class Store {
  public readonly files: FileRepository;
  public readonly symbols: SymbolRepository;
  public readonly graph: GraphRepository;
  public readonly domain: DomainRepository;
  public readonly analytics: AnalyticsRepository;

  constructor(public readonly db: Database.Database) {
    this.files = new FileRepository(db);
    this.symbols = new SymbolRepository(db);
    this.graph = new GraphRepository(db);
    this.domain = new DomainRepository(db);
    this.analytics = new AnalyticsRepository(db);
  }

  // --- Files (delegates to FileRepository) ---

  insertFile(
    path: string,
    language: string | null,
    contentHash: string | null,
    byteLength: number | null,
    workspace?: string | null,
    mtimeMs?: number | null,
  ): number {
    return this.files.insertFile(
      path, language, contentHash, byteLength,
      workspace ?? null, mtimeMs ?? null,
      (nodeType, refId) => this.graph.createNode(nodeType, refId),
    );
  }

  getFile(path: string): FileRow | undefined {
    return this.files.getFile(path);
  }

  getFileById(id: number): FileRow | undefined {
    return this.files.getFileById(id);
  }

  getFilesByPaths(paths: string[]): Map<string, FileRow> {
    return this.files.getFilesByPaths(paths);
  }

  getAllFiles(): FileRow[] {
    return this.files.getAllFiles();
  }

  updateFileWorkspace(fileId: number, workspace: string): void {
    this.files.updateFileWorkspace(fileId, workspace);
  }

  getFilesByWorkspace(workspace: string): FileRow[] {
    return this.files.getFilesByWorkspace(workspace);
  }

  updateFileHash(fileId: number, hash: string, byteLength: number, mtimeMs?: number | null): void {
    this.files.updateFileHash(fileId, hash, byteLength, mtimeMs ?? null);
  }

  updateFileStatus(fileId: number, status: string, frameworkRole?: string): void {
    this.files.updateFileStatus(fileId, status, frameworkRole ?? null);
  }

  updateFileGitignored(fileId: number, gitignored: boolean): void {
    this.files.updateFileGitignored(fileId, gitignored);
  }

  deleteFile(fileId: number): void {
    this.files.deleteFile(
      fileId,
      (fId) => this.graph.deleteEdgesForFileNodes(fId),
      (fId) => this.files.deleteEntitiesByFile(fId),
    );
  }

  deleteEntitiesByFile(fileId: number): void {
    this.files.deleteEntitiesByFile(fileId);
  }

  getFilesByIds(ids: number[]): Map<number, FileRow> {
    return this.files.getFilesByIds(ids);
  }

  // --- Symbols (delegates to SymbolRepository) ---

  insertSymbol(fileId: number, sym: RawSymbol, parentIdOverride?: number | null): number {
    return this.symbols.insertSymbol(
      fileId, sym, parentIdOverride,
      (nodeType, refId) => this.graph.createNode(nodeType, refId),
    );
  }

  insertSymbols(fileId: number, syms: RawSymbol[]): number[] {
    return this.symbols.insertSymbols(
      fileId, syms,
      (fId, sym, parentId) => this.insertSymbol(fId, sym, parentId),
    );
  }

  deleteSymbolsByFile(fileId: number): void {
    this.symbols.deleteSymbolsByFile(fileId);
  }

  getSymbolsByFile(fileId: number): SymbolRow[] {
    return this.symbols.getSymbolsByFile(fileId);
  }

  getSymbolsByFileIds(fileIds: number[]): SymbolRow[] {
    if (fileIds.length === 0) return [];
    const results: SymbolRow[] = [];
    for (const fid of fileIds) {
      results.push(...this.symbols.getSymbolsByFile(fid));
    }
    return results;
  }

  getSymbolBySymbolId(symbolId: string): SymbolRow | undefined {
    return this.symbols.getSymbolBySymbolId(symbolId);
  }

  getSymbolByFqn(fqn: string): SymbolRow | undefined {
    return this.symbols.getSymbolByFqn(fqn);
  }

  getSymbolById(id: number): SymbolRow | undefined {
    return this.symbols.getSymbolById(id);
  }

  getSymbolByName(name: string, kind?: string): SymbolRow | undefined {
    return this.symbols.getSymbolByName(name, kind);
  }

  getSymbolChildren(parentId: number): SymbolRow[] {
    return this.symbols.getSymbolChildren(parentId);
  }

  getExportedSymbols(filePattern?: string): SymbolWithFilePath[] {
    return this.symbols.getExportedSymbols(filePattern);
  }

  findImplementors(name: string): SymbolWithFilePath[] {
    return this.symbols.findImplementors(name);
  }

  getSymbolsWithHeritage(fileIds?: number[]): (SymbolRow & { file_path: string })[] {
    return this.symbols.getSymbolsWithHeritage(fileIds);
  }

  getSymbolsByIds(ids: number[]): Map<number, SymbolRow> {
    return this.symbols.getSymbolsByIds(ids);
  }

  findSymbolByRole(name: string, frameworkRole?: string): SymbolRow | undefined {
    return this.symbols.findSymbolByRole(name, frameworkRole);
  }

  updateSymbolSummary(symbolId: number, summary: string): void {
    this.symbols.updateSymbolSummary(symbolId, summary);
  }

  countUnsummarizedSymbols(kinds: string[]): number {
    return this.symbols.countUnsummarizedSymbols(kinds);
  }

  countUnembeddedSymbols(): number {
    return this.symbols.countUnembeddedSymbols();
  }

  getUnsummarizedSymbols(kinds: string[], limit: number): {
    id: number;
    name: string;
    fqn: string | null;
    kind: string;
    signature: string | null;
    file_path: string;
    byte_start: number;
    byte_end: number;
  }[] {
    return this.symbols.getUnsummarizedSymbols(kinds, limit);
  }

  // --- Nodes & Edges (delegates to GraphRepository) ---

  createNode(nodeType: string, refId: number): number {
    return this.graph.createNode(nodeType, refId);
  }

  getNodeId(nodeType: string, refId: number): number | undefined {
    return this.graph.getNodeId(nodeType, refId);
  }

  insertEdge(
    sourceNodeId: number,
    targetNodeId: number,
    edgeTypeName: string,
    resolved?: boolean,
    metadata?: Record<string, unknown>,
    isCrossWs?: boolean,
    resolutionTier?: string,
  ): TraceMcpResult<number> {
    return this.graph.insertEdge(sourceNodeId, targetNodeId, edgeTypeName, resolved, metadata, isCrossWs, resolutionTier);
  }

  deleteEdgesForFileNodes(fileId: number): void {
    this.graph.deleteEdgesForFileNodes(fileId);
  }

  deleteOutgoingImportEdges(fileId: number): void {
    this.graph.deleteOutgoingImportEdges(fileId);
  }

  deleteOutgoingEdgesForFileNodes(fileId: number): void {
    this.graph.deleteOutgoingEdgesForFileNodes(fileId);
  }

  traverseEdges(startNodeId: number, direction: 'outgoing' | 'incoming', depth: number): EdgeRow[] {
    return this.graph.traverseEdges(startNodeId, direction, depth);
  }

  getEdgesByType(edgeTypeName: string): EdgeRow[] {
    return this.graph.getEdgesByType(edgeTypeName);
  }

  getOutgoingEdges(nodeId: number): (EdgeRow & { edge_type_name: string })[] {
    return this.graph.getOutgoingEdges(nodeId);
  }

  getIncomingEdges(nodeId: number): (EdgeRow & { edge_type_name: string })[] {
    return this.graph.getIncomingEdges(nodeId);
  }

  ensureEdgeType(name: string, category: string, description: string): void {
    this.graph.ensureEdgeType(name, category, description);
  }

  getEdgeTypeName(edgeTypeId: number): string | undefined {
    return this.graph.getEdgeTypeName(edgeTypeId);
  }

  getNodeRef(nodeId: number): { nodeType: string; refId: number } | undefined {
    return this.graph.getNodeRef(nodeId);
  }

  getNodeByNodeId(nodeId: number): { node_type: string; ref_id: number } | undefined {
    return this.graph.getNodeByNodeId(nodeId);
  }

  getNodeIdsBatch(nodeType: string, refIds: number[]): Map<number, number> {
    return this.graph.getNodeIdsBatch(nodeType, refIds);
  }

  getNodeRefsBatch(nodeIds: number[]): Map<number, { nodeType: string; refId: number }> {
    return this.graph.getNodeRefsBatch(nodeIds);
  }

  getEdgesForNodesBatch(
    nodeIds: number[],
  ): Array<EdgeRow & { edge_type_name: string; pivot_node_id: number }> {
    return this.graph.getEdgesForNodesBatch(nodeIds);
  }

  getEdgeTypes(): EdgeTypeRow[] {
    return this.graph.getEdgeTypes();
  }

  // --- Domain entities (delegates to DomainRepository) ---

  insertRoute(route: RawRoute, fileId: number): number {
    return this.domain.insertRoute(route, fileId, (nodeType, refId) => this.graph.createNode(nodeType, refId));
  }

  getRouteByUriAndMethod(uri: string, method: string): RouteRow | undefined {
    return this.domain.getRouteByUriAndMethod(uri, method);
  }

  getAllRoutes(): RouteRow[] {
    return this.domain.getAllRoutes();
  }

  findRouteByPattern(uri: string, method: string): RouteRow | undefined {
    return this.domain.findRouteByPattern(uri, method);
  }

  insertComponent(comp: RawComponent, fileId: number): number {
    return this.domain.insertComponent(comp, fileId, (nodeType, refId) => this.graph.createNode(nodeType, refId));
  }

  getComponentByFileId(fileId: number): ComponentRow | undefined {
    return this.domain.getComponentByFileId(fileId);
  }

  getComponentByName(name: string): ComponentRow | undefined {
    return this.domain.getComponentByName(name);
  }

  getAllComponents(): ComponentRow[] {
    return this.domain.getAllComponents();
  }

  insertMigration(mig: RawMigration, fileId: number): number {
    return this.domain.insertMigration(mig, fileId, (nodeType, refId) => this.graph.createNode(nodeType, refId));
  }

  getMigrationsByTable(tableName: string): MigrationRow[] {
    return this.domain.getMigrationsByTable(tableName);
  }

  getAllMigrations(): MigrationRow[] {
    return this.domain.getAllMigrations();
  }

  insertOrmModel(model: RawOrmModel, fileId: number): number {
    return this.domain.insertOrmModel(model, fileId, (nodeType, refId) => this.graph.createNode(nodeType, refId));
  }

  getOrmModelByName(name: string): OrmModelRow | undefined {
    return this.domain.getOrmModelByName(name);
  }

  getOrmModelsByOrm(orm: string): OrmModelRow[] {
    return this.domain.getOrmModelsByOrm(orm);
  }

  getAllOrmModels(): OrmModelRow[] {
    return this.domain.getAllOrmModels();
  }

  insertOrmAssociation(
    sourceModelId: number,
    targetModelId: number | null,
    targetModelName: string,
    kind: string,
    options?: Record<string, unknown>,
    fileId?: number,
    line?: number,
  ): number {
    return this.domain.insertOrmAssociation(sourceModelId, targetModelId, targetModelName, kind, options, fileId, line);
  }

  getAllOrmAssociations(fileIds?: number[]): OrmAssociationRow[] {
    return this.domain.getAllOrmAssociations(fileIds);
  }

  getOrmAssociationsByModel(modelId: number): OrmAssociationRow[] {
    return this.domain.getOrmAssociationsByModel(modelId);
  }

  insertRnScreen(screen: RawRnScreen, fileId: number): number {
    return this.domain.insertRnScreen(screen, fileId, (nodeType, refId) => this.graph.createNode(nodeType, refId));
  }

  getRnScreenByName(name: string): RnScreenRow | undefined {
    return this.domain.getRnScreenByName(name);
  }

  getAllRnScreens(): RnScreenRow[] {
    return this.domain.getAllRnScreens();
  }

  // --- Analytics (delegates to AnalyticsRepository) ---

  insertEnvVar(fileId: number, entry: {
    key: string;
    valueType: string;
    valueFormat: string | null;
    comment: string | null;
    quoted: boolean;
    line: number;
  }): number {
    return this.analytics.insertEnvVar(fileId, entry);
  }

  deleteEnvVarsByFile(fileId: number): void {
    this.analytics.deleteEnvVarsByFile(fileId);
  }

  getEnvVarsByFile(fileId: number): EnvVarRow[] {
    return this.analytics.getEnvVarsByFile(fileId);
  }

  getAllEnvVars(): (EnvVarRow & { file_path: string })[] {
    return this.analytics.getAllEnvVars();
  }

  searchEnvVars(pattern: string): (EnvVarRow & { file_path: string })[] {
    return this.analytics.searchEnvVars(pattern);
  }

  getWorkspaceStats(): WorkspaceStats[] {
    return this.analytics.getWorkspaceStats();
  }

  getCrossWorkspaceEdges(): CrossWorkspaceEdge[] {
    return this.analytics.getCrossWorkspaceEdges();
  }

  getWorkspaceDependencyGraph(): WorkspaceDependency[] {
    return this.analytics.getWorkspaceDependencyGraph();
  }

  getWorkspaceExports(workspace: string): SymbolWithFilePath[] {
    return this.analytics.getWorkspaceExports(workspace);
  }

  getStats(): IndexStats {
    return this.analytics.getStats();
  }

  insertGraphSnapshot(
    snapshotType: string,
    data: Record<string, unknown>,
    commitHash?: string,
    filePath?: string,
  ): number {
    return this.analytics.insertGraphSnapshot(snapshotType, data, commitHash, filePath);
  }

  getGraphSnapshots(
    snapshotType: string,
    options?: { filePath?: string; since?: string; limit?: number },
  ): GraphSnapshotRow[] {
    return this.analytics.getGraphSnapshots(snapshotType, options);
  }

  pruneGraphSnapshots(maxAge?: number): number {
    return this.analytics.pruneGraphSnapshots(maxAge);
  }
}

// --- Row types re-exported from db/types.ts for backward compatibility ---
export type {
  FileRow, SymbolRow, EdgeRow, RouteRow, MigrationRow,
  ComponentRow, OrmModelRow, OrmAssociationRow, RnScreenRow,
  EnvVarRow, SymbolWithFilePath, EdgeTypeRow, IndexStats,
  GraphSnapshotRow, WorkspaceStats, CrossWorkspaceEdge, WorkspaceDependency,
} from './types.js';
import type {
  FileRow, SymbolRow, EdgeRow, RouteRow, MigrationRow,
  ComponentRow, OrmModelRow, OrmAssociationRow, RnScreenRow,
  EnvVarRow, SymbolWithFilePath, EdgeTypeRow, IndexStats,
  GraphSnapshotRow, WorkspaceStats, CrossWorkspaceEdge, WorkspaceDependency,
} from './types.js';
