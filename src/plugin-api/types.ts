import type { TraceMcpResult } from '../errors.js';

// --- Node & Edge type declarations ---

interface NodeTypeDeclaration {
  name: string;
}

export interface EdgeTypeDeclaration {
  name: string;
  category: string;
  directed?: boolean;
  description?: string;
}

// --- Raw symbols from LanguagePlugin ---

export interface RawSymbol {
  symbolId: string;       // 'app/Models/User.php::User#class'
  name: string;
  kind: SymbolKind;
  fqn?: string;           // 'App\Models\User'
  parentSymbolId?: string;
  signature?: string;
  byteStart: number;
  byteEnd: number;
  lineStart?: number;
  lineEnd?: number;
  metadata?: Record<string, unknown>;
}

export type SymbolKind =
  | 'class' | 'method' | 'function' | 'constant' | 'property'
  | 'interface' | 'trait' | 'enum' | 'type' | 'variable'
  | 'enum_case' | 'namespace'
  | 'decorator';

// --- Raw edges from FrameworkPlugin ---

/** How an edge was resolved during indexing — tiers from highest to lowest confidence */
export type EdgeResolution = 'lsp_resolved' | 'ast_resolved' | 'ast_inferred' | 'text_matched';

export interface RawEdge {
  sourceSymbolId?: string;
  sourceNodeType?: string;
  sourceRefId?: number;
  targetSymbolId?: string;
  targetNodeType?: string;
  targetRefId?: number;
  edgeType: string;
  resolved?: boolean;
  /** How this edge was resolved: ast_resolved (direct AST), ast_inferred (import graph), text_matched (heuristic) */
  resolution?: EdgeResolution;
  metadata?: Record<string, unknown>;
}

// --- Framework-specific nodes ---

export interface RawRoute {
  method: string;
  uri: string;
  name?: string;
  controllerSymbolId?: string;
  handler?: string;
  middleware?: string[];
  fileId?: number;
  line?: number;
  metadata?: Record<string, unknown>;
}

export interface RawComponent {
  name: string;
  kind: 'page' | 'component' | 'layout' | 'context' | 'provider' | 'hook';
  props?: Record<string, unknown>;
  emits?: string[];
  slots?: string[];
  composables?: string[];
  framework: string;
}

export interface RawMigration {
  tableName: string;
  operation: 'create' | 'alter' | 'drop';
  columns?: Record<string, unknown>[];
  indices?: Record<string, unknown>[];
  timestamp?: string;
}

export interface RawOrmModel {
  name: string;
  orm: 'mongoose' | 'sequelize' | 'sqlalchemy' | 'django' | 'prisma' | 'typeorm' | 'drizzle';
  collectionOrTable?: string;
  fields?: Record<string, unknown>[];
  options?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface RawOrmAssociation {
  sourceModelName: string;
  targetModelName: string;
  kind: string;  // 'hasMany', 'belongsTo', 'ref', 'discriminator', etc.
  options?: Record<string, unknown>;
  line?: number;
}

export interface RawRnScreen {
  name: string;
  componentPath?: string;
  navigatorType?: 'stack' | 'tab' | 'drawer' | 'native-stack';
  options?: Record<string, unknown>;
  deepLink?: string;
  metadata?: Record<string, unknown>;
}

// --- Plugin file result ---

export interface FileParseResult {
  language?: string;
  frameworkRole?: string;
  status: 'ok' | 'partial' | 'error';
  symbols: RawSymbol[];
  edges?: RawEdge[];
  routes?: RawRoute[];
  components?: RawComponent[];
  migrations?: RawMigration[];
  ormModels?: RawOrmModel[];
  ormAssociations?: RawOrmAssociation[];
  rnScreens?: RawRnScreen[];
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

// --- Plugin manifest ---

type PluginCategory = 'framework' | 'orm' | 'validation' | 'state' | 'api' | 'realtime' | 'testing' | 'tooling' | 'view';

export interface PluginManifest {
  name: string;
  version: string;
  priority: number;        // lower = earlier
  dependencies?: string[]; // names of plugins this depends on
  category?: PluginCategory;
}

// --- Project context (passed to FrameworkPlugin.detect) ---

/** Detected runtime/language version from manifest files. */
export interface DetectedVersion {
  runtime: string;       // 'node', 'php', 'python', 'ruby', 'go', 'java', 'rust'
  version?: string;      // e.g. '20.11.0', '>=8.2', '^3.12'
  source: string;        // file that provided this version, e.g. '.nvmrc', 'package.json#engines.node'
}

/** Parsed dependency entry from any manifest. */
export interface ParsedDependency {
  name: string;
  version?: string;      // raw version constraint, e.g. '^3.5.0', '>=1.21'
  dev?: boolean;
}

export interface ProjectContext {
  rootPath: string;

  // --- Existing manifest files ---
  composerJson?: Record<string, unknown>;
  packageJson?: Record<string, unknown>;
  pyprojectToml?: Record<string, unknown>;
  requirementsTxt?: string[];

  // --- Newly supported manifest files ---
  goMod?: { module: string; goVersion?: string; deps: ParsedDependency[] };
  cargoToml?: { package?: Record<string, unknown>; deps: ParsedDependency[] };
  gemfile?: { deps: ParsedDependency[] };
  pomXml?: { groupId?: string; artifactId?: string; version?: string; deps: ParsedDependency[] };
  buildGradle?: { deps: ParsedDependency[] };

  // --- Aggregated version detection ---
  detectedVersions: DetectedVersion[];

  // --- Aggregated dependencies from all manifests ---
  allDependencies: ParsedDependency[];

  configFiles: string[];
}

// --- Language Plugin ---

export interface LanguagePlugin {
  manifest: PluginManifest;
  supportedExtensions: string[];
  supportedVersions?: string[];  // e.g. ['7.0', '7.1', ..., '8.4'] or ['3.9', ..., '3.14']
  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult> | Promise<TraceMcpResult<FileParseResult>>;
}

// --- Framework Plugin ---

export interface FrameworkPlugin {
  manifest: PluginManifest;
  detect(ctx: ProjectContext): boolean;
  registerSchema(): { nodeTypes?: NodeTypeDeclaration[]; edgeTypes?: EdgeTypeDeclaration[] };
  extractNodes?(filePath: string, content: Buffer, language: string): TraceMcpResult<FileParseResult>;
  resolveEdges?(ctx: ResolveContext): TraceMcpResult<RawEdge[]>;
  configure?(config: Record<string, unknown>): void;
}

// --- Resolve context (Pass 2) ---

export interface ResolveContext {
  rootPath: string;
  getAllFiles(): { id: number; path: string; language: string | null }[];
  getSymbolsByFile(fileId: number): { id: number; symbolId: string; name: string; kind: string; fqn: string | null; lineStart?: number | null; lineEnd?: number | null; metadata?: Record<string, unknown> | null }[];
  getSymbolByFqn(fqn: string): { id: number; symbolId: string } | undefined;
  getNodeId(nodeType: string, refId: number): number | undefined;
  createNodeIfNeeded(nodeType: string, refId: number): number;
  /** Read file content — uses Pass 1 cache when available, falls back to disk. */
  readFile(relPath: string): string | undefined;
}
