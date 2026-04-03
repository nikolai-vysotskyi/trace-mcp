import type { TraceMcpResult } from '../errors.js';

// --- Node & Edge type declarations ---

export interface NodeTypeDeclaration {
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
  | 'enum_case' | 'namespace';

// --- Raw edges from FrameworkPlugin ---

export interface RawEdge {
  sourceSymbolId?: string;
  sourceNodeType?: string;
  sourceRefId?: number;
  targetSymbolId?: string;
  targetNodeType?: string;
  targetRefId?: number;
  edgeType: string;
  resolved?: boolean;
  metadata?: Record<string, unknown>;
}

// --- Framework-specific nodes ---

export interface RawRoute {
  method: string;
  uri: string;
  name?: string;
  controllerSymbolId?: string;
  middleware?: string[];
  fileId?: number;
  line?: number;
}

export interface RawComponent {
  name: string;
  kind: 'page' | 'component' | 'layout';
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
  warnings?: string[];
}

// --- Plugin manifest ---

export interface PluginManifest {
  name: string;
  version: string;
  priority: number;        // lower = earlier
  dependencies?: string[]; // names of plugins this depends on
}

// --- Project context (passed to FrameworkPlugin.detect) ---

export interface ProjectContext {
  rootPath: string;
  composerJson?: Record<string, unknown>;
  packageJson?: Record<string, unknown>;
  configFiles: string[];
}

// --- Language Plugin ---

export interface LanguagePlugin {
  manifest: PluginManifest;
  supportedExtensions: string[];
  extractSymbols(filePath: string, content: Buffer): TraceMcpResult<FileParseResult>;
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
  getSymbolsByFile(fileId: number): { id: number; symbolId: string; name: string; kind: string; fqn: string | null; metadata?: Record<string, unknown> | null }[];
  getSymbolByFqn(fqn: string): { id: number; symbolId: string } | undefined;
  getNodeId(nodeType: string, refId: number): number | undefined;
  createNodeIfNeeded(nodeType: string, refId: number): number;
}
