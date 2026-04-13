/**
 * Python call edge resolver — resolves call sites stored in symbol metadata
 * into `calls` edges in the dependency graph.
 *
 * Resolution strategy:
 * 1. self/cls calls → resolve within same class's methods
 * 2. Bare name calls → check same-file symbols, then imported names
 * 3. Attribute calls (receiver.method) → resolve receiver via imports, then find method
 *
 * This resolver runs AFTER import resolution, so file-level import edges are available.
 */
import type { PipelineState } from '../pipeline-state.js';
import { logger } from '../../logger.js';

interface CallSiteRow {
  calleeName: string;
  line: number;
  receiver?: string;
  isSelfCall?: boolean;
  receiverType?: string;
  receiverAssignedFrom?: string;
  metadata?: { pattern?: boolean; prefix?: string };
}

interface SymbolRow {
  id: number;
  symbol_id: string;
  name: string;
  kind: string;
  file_id: number;
  parent_symbol_id: string | null; // joined from parent symbol
  metadata: string | null;
}

export function resolvePythonCallEdges(state: PipelineState): void {
  const { store } = state;

  // 1. Get the 'calls' edge type
  const callsEdgeType = store.db.prepare(
    `SELECT id FROM edge_types WHERE name = ?`,
  ).get('calls') as { id: number } | undefined;
  if (!callsEdgeType) return;

  // 2. Get all Python symbols that have callSites in metadata
  const symbolsWithCalls = store.db.prepare(`
    SELECT s.id, s.symbol_id, s.name, s.kind, s.file_id,
           p.symbol_id AS parent_symbol_id, s.metadata
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    LEFT JOIN symbols p ON s.parent_id = p.id
    WHERE f.language = 'python'
      AND s.metadata IS NOT NULL
      AND s.metadata LIKE '%"callSites"%'
  `).all() as SymbolRow[];

  if (symbolsWithCalls.length === 0) return;

  // 3. Build resolution indexes

  // All Python symbols indexed by name → array of {id, symbol_id, file_id, kind, parent_symbol_id}
  const allPySymbols = store.db.prepare(`
    SELECT s.id, s.symbol_id, s.name, s.kind, s.file_id,
           p.symbol_id AS parent_symbol_id
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    LEFT JOIN symbols p ON s.parent_id = p.id
    WHERE f.language = 'python'
  `).all() as Array<{ id: number; symbol_id: string; name: string; kind: string; file_id: number; parent_symbol_id: string | null }>;

  // name → symbols with that name
  const nameIndex = new Map<string, typeof allPySymbols>();
  for (const s of allPySymbols) {
    const list = nameIndex.get(s.name) ?? [];
    list.push(s);
    nameIndex.set(s.name, list);
  }

  // symbol_id → symbol (for quick lookups)
  const symbolById = new Map<string, (typeof allPySymbols)[0]>();
  for (const s of allPySymbols) {
    symbolById.set(s.symbol_id, s);
  }

  // file_id → symbols in that file
  const symbolsByFile = new Map<number, typeof allPySymbols>();
  for (const s of allPySymbols) {
    const list = symbolsByFile.get(s.file_id) ?? [];
    list.push(s);
    symbolsByFile.set(s.file_id, list);
  }

  // Build per-file import map: file_id → Map<importedName, targetFileId>
  // This tells us that in file X, name "Foo" was imported from file Y
  const fileImportMap = buildFileImportMap(state);

  // Pre-load symbol → node ID mappings
  const CHUNK = 500;
  const allSymbolIds = allPySymbols.map((s) => s.id);
  const symbolNodeMap = new Map<number, number>();
  for (let i = 0; i < allSymbolIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('symbol', allSymbolIds.slice(i, i + CHUNK))) {
      symbolNodeMap.set(k, v);
    }
  }

  // 4. Build return type index: function name → return type from signature
  // e.g. `def get_user(id: int) -> User:` → "get_user" → "User"
  const returnTypeIndex = new Map<string, string>();
  for (const s of allPySymbols) {
    if (s.kind !== 'function' && s.kind !== 'method') continue;
    const sigRow = store.db.prepare(
      `SELECT signature FROM symbols WHERE id = ?`,
    ).get(s.id) as { signature: string | null } | undefined;
    if (!sigRow?.signature) continue;
    const retMatch = sigRow.signature.match(/-> *([A-Z][A-Za-z0-9_]*)/);
    if (retMatch) {
      returnTypeIndex.set(s.name, retMatch[1]);
    }
  }

  // 5. Resolve call sites
  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
     VALUES (?, ?, ?, 1, ?, 0, 'ast_resolved')`,
  );

  let created = 0;

  store.db.transaction(() => {
    for (const sym of symbolsWithCalls) {
      let callSites: CallSiteRow[];
      try {
        const meta = JSON.parse(sym.metadata!) as Record<string, unknown>;
        callSites = meta.callSites as CallSiteRow[];
        if (!Array.isArray(callSites)) continue;
      } catch { continue; }

      const sourceNodeId = symbolNodeMap.get(sym.id);
      if (sourceNodeId == null) continue;

      // Get the class this method belongs to (if any)
      const parentClassId = sym.parent_symbol_id;
      const fileSymbols = symbolsByFile.get(sym.file_id) ?? [];
      const fileImports = fileImportMap.get(sym.file_id);

      for (const call of callSites) {
        // Pattern-based calls (f-string getattr) → multiple targets
        if (call.metadata?.pattern && call.metadata.prefix && call.receiver) {
          const prefix = call.metadata.prefix;
          const targets = resolvePrefixPattern(
            prefix, call.receiver, call.isSelfCall ? parentClassId : null,
            fileSymbols, fileImports, nameIndex, symbolsByFile,
          );
          for (const target of targets) {
            const targetNodeId = symbolNodeMap.get(target.id);
            if (targetNodeId == null || targetNodeId === sourceNodeId) continue;
            insertStmt.run(sourceNodeId, targetNodeId, callsEdgeType.id,
              JSON.stringify({ callee: target.name, line: call.line, pattern: prefix }));
            created++;
          }
          continue;
        }

        const targetSymbol = resolveCallSite(
          call, sym, parentClassId, fileSymbols, fileImports,
          nameIndex, symbolsByFile, symbolById, returnTypeIndex, callSites,
        );
        if (!targetSymbol) continue;

        const targetNodeId = symbolNodeMap.get(targetSymbol.id);
        if (targetNodeId == null || targetNodeId === sourceNodeId) continue;

        insertStmt.run(
          sourceNodeId,
          targetNodeId,
          callsEdgeType.id,
          JSON.stringify({ callee: call.calleeName, line: call.line }),
        );
        created++;
      }
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'Python call edges resolved');
  }
}

/**
 * Resolve a single call site to a target symbol.
 */
function resolveCallSite(
  call: CallSiteRow,
  callerSym: SymbolRow,
  parentClassId: string | null,
  fileSymbols: SymbolEntry[],
  fileImports: Map<string, number[]> | undefined,
  nameIndex: Map<string, SymbolEntry[]>,
  symbolsByFile: Map<number, SymbolEntry[]>,
  symbolById: Map<string, SymbolEntry>,
  returnTypeIndex: Map<string, string>,
  siblingCalls: CallSiteRow[],
): { id: number } | null {
  const { calleeName, receiver, isSelfCall } = call;

  // ── 1. self.method() / cls.method() → resolve within same class ──
  if (isSelfCall && parentClassId) {
    if (receiver === 'super') {
      // super().method() — resolve via parent class's bases
      // For now, try to find any method with this name that's NOT in this class
      const candidates = nameIndex.get(calleeName);
      if (candidates) {
        const match = candidates.find((s) =>
          (s.kind === 'method' || s.kind === 'function')
          && s.parent_symbol_id !== parentClassId
          && s.parent_symbol_id != null,
        );
        if (match) return match;
      }
      return null;
    }

    // Look for method in same class
    const classMethod = fileSymbols.find((s) =>
      s.parent_symbol_id === parentClassId
      && s.name === calleeName
      && (s.kind === 'method' || s.kind === 'function'),
    );
    if (classMethod) return classMethod;

    // Also check properties (could be a callable attribute)
    const classProp = fileSymbols.find((s) =>
      s.parent_symbol_id === parentClassId && s.name === calleeName,
    );
    if (classProp) return classProp;

    // Inherited method — look for the method in any class with this name
    // (covers self.validate() where validate is defined on a base class)
    const inherited = nameIndex.get(calleeName);
    if (inherited) {
      const match = inherited.find((s) =>
        (s.kind === 'method' || s.kind === 'function')
        && s.parent_symbol_id != null,
      );
      if (match) return match;
    }

    return null;
  }

  // ── 2. Bare name call: foo() ──
  if (!receiver) {
    // 2a. Same-file function/class definition
    const sameFile = fileSymbols.find((s) =>
      s.name === calleeName
      && (s.kind === 'function' || s.kind === 'class')
      && s.parent_symbol_id == null, // top-level only
    );
    if (sameFile) return sameFile;

    // 2b. Imported name — resolve via file imports
    if (fileImports) {
      const importedFromFiles = fileImports.get(calleeName);
      if (importedFromFiles) {
        for (const targetFileId of importedFromFiles) {
          const targetFileSymbols = symbolsByFile.get(targetFileId) ?? [];
          const match = targetFileSymbols.find((s) =>
            s.name === calleeName
            && (s.kind === 'function' || s.kind === 'class')
            && s.parent_symbol_id == null,
          );
          if (match) return match;
        }
      }

      // 2b-star. Star imports: `from module import *` — check all star-imported files
      const starImports = fileImports.get('*');
      if (starImports) {
        for (const targetFileId of starImports) {
          const targetFileSymbols = symbolsByFile.get(targetFileId) ?? [];
          const match = targetFileSymbols.find((s) =>
            s.name === calleeName
            && (s.kind === 'function' || s.kind === 'class')
            && s.parent_symbol_id == null,
          );
          if (match) return match;
        }
      }
    }

    // 2c. Global name fallback — if there's exactly one function/class with this name
    const globalCandidates = nameIndex.get(calleeName);
    if (globalCandidates) {
      const topLevel = globalCandidates.filter((s) =>
        (s.kind === 'function' || s.kind === 'class') && s.parent_symbol_id == null,
      );
      if (topLevel.length === 1) return topLevel[0];
    }

    return null;
  }

  // ── 3. Attribute call: receiver.method() ──

  // 3a. Type-inferred receiver: `user = User(...)` then `user.save()`
  //     receiverType tells us the class name to look up the method on
  let typeName = call.receiverType;

  // 3a-ret. Return type inference: `user = get_user(id)` where `def get_user() -> User:`
  //         receiverAssignedFrom tells us which function was called to create this variable
  if (!typeName && call.receiverAssignedFrom) {
    typeName = returnTypeIndex.get(call.receiverAssignedFrom);
  }

  if (typeName) {
    const resolved = resolveMethodOnClass(typeName, calleeName, fileSymbols, fileImports, nameIndex, symbolsByFile);
    if (resolved) return resolved;
  }

  // 3b. Receiver is an imported module/class
  if (fileImports) {
    const importedFromFiles = fileImports.get(receiver);
    if (importedFromFiles) {
      for (const targetFileId of importedFromFiles) {
        const targetFileSymbols = symbolsByFile.get(targetFileId) ?? [];

        // Try top-level function/variable with calleeName
        const topLevelMatch = targetFileSymbols.find((s) =>
          s.name === calleeName
          && s.parent_symbol_id == null,
        );
        if (topLevelMatch) return topLevelMatch;
      }
    }

    // 3c. Star imports: check all star-imported files for the callee
    const starImports = fileImports.get('*');
    if (starImports) {
      for (const targetFileId of starImports) {
        const targetFileSymbols = symbolsByFile.get(targetFileId) ?? [];
        // Receiver might be a class from a star import
        const cls = targetFileSymbols.find((s) => s.name === receiver && s.kind === 'class');
        if (cls) {
          const method = targetFileSymbols.find((s) =>
            s.parent_symbol_id === cls.symbol_id && s.name === calleeName,
          );
          if (method) return method;
        }
      }
    }
  }

  // 3d. Receiver is a class name in same file
  const receiverClass = fileSymbols.find((s) =>
    s.name === receiver && s.kind === 'class' && s.parent_symbol_id == null,
  );
  if (receiverClass) {
    const method = fileSymbols.find((s) =>
      s.parent_symbol_id === receiverClass.symbol_id && s.name === calleeName,
    );
    if (method) return method;
  }

  // 3e. Receiver is a class from imports → find its methods
  if (fileImports) {
    const importedClassFiles = fileImports.get(receiver);
    if (importedClassFiles) {
      for (const targetFileId of importedClassFiles) {
        const targetSymbols = symbolsByFile.get(targetFileId) ?? [];
        const cls = targetSymbols.find((s) => s.name === receiver && s.kind === 'class');
        if (cls) {
          const method = targetSymbols.find((s) =>
            s.parent_symbol_id === cls.symbol_id && s.name === calleeName,
          );
          if (method) return method;
        }
      }
    }
  }

  return null;
}

type SymbolEntry = { id: number; symbol_id: string; name: string; kind: string; file_id: number; parent_symbol_id: string | null };

/**
 * Resolve f-string pattern: getattr(self, f"handle_{x}") → all methods starting with "handle_"
 */
function resolvePrefixPattern(
  prefix: string,
  receiver: string,
  parentClassId: string | null,
  fileSymbols: SymbolEntry[],
  fileImports: Map<string, number[]> | undefined,
  nameIndex: Map<string, SymbolEntry[]>,
  symbolsByFile: Map<number, SymbolEntry[]>,
): SymbolEntry[] {
  const results: SymbolEntry[] = [];

  // self/cls → find all methods in same class with prefix
  if ((receiver === 'self' || receiver === 'cls') && parentClassId) {
    for (const s of fileSymbols) {
      if (s.parent_symbol_id === parentClassId && s.name.startsWith(prefix)
        && (s.kind === 'method' || s.kind === 'function')) {
        results.push(s);
      }
    }
    // Also check inherited methods
    if (results.length === 0) {
      for (const [, syms] of nameIndex) {
        for (const s of syms) {
          if (s.name.startsWith(prefix) && s.parent_symbol_id != null
            && (s.kind === 'method' || s.kind === 'function')) {
            results.push(s);
          }
        }
      }
    }
    return results;
  }

  // Imported class/module
  if (fileImports) {
    const importedFiles = fileImports.get(receiver);
    if (importedFiles) {
      for (const fid of importedFiles) {
        const syms = symbolsByFile.get(fid) ?? [];
        for (const s of syms) {
          if (s.name.startsWith(prefix) && (s.kind === 'function' || s.kind === 'method')) {
            results.push(s);
          }
        }
      }
    }
  }

  return results;
}

/**
 * Resolve `calleeName` as a method on a class identified by `typeName`.
 * Searches same-file classes, imported classes, and global name index.
 */
function resolveMethodOnClass(
  typeName: string,
  calleeName: string,
  fileSymbols: SymbolEntry[],
  fileImports: Map<string, number[]> | undefined,
  nameIndex: Map<string, SymbolEntry[]>,
  symbolsByFile: Map<number, SymbolEntry[]>,
): SymbolEntry | null {
  // Same-file class
  const localClass = fileSymbols.find((s) => s.name === typeName && s.kind === 'class');
  if (localClass) {
    const method = fileSymbols.find((s) =>
      s.parent_symbol_id === localClass.symbol_id && s.name === calleeName,
    );
    if (method) return method;
  }

  // Imported class
  if (fileImports) {
    const classFiles = fileImports.get(typeName);
    if (classFiles) {
      for (const fid of classFiles) {
        const syms = symbolsByFile.get(fid) ?? [];
        const cls = syms.find((s) => s.name === typeName && s.kind === 'class');
        if (cls) {
          const method = syms.find((s) =>
            s.parent_symbol_id === cls.symbol_id && s.name === calleeName,
          );
          if (method) return method;
        }
      }
    }
  }

  // Global name index — unique class match
  const classCandidates = nameIndex.get(typeName);
  if (classCandidates) {
    const classes = classCandidates.filter((s) => s.kind === 'class');
    if (classes.length === 1) {
      const cls = classes[0];
      const methods = nameIndex.get(calleeName);
      if (methods) {
        const method = methods.find((s) => s.parent_symbol_id === cls.symbol_id);
        if (method) return method;
      }
    }
  }

  // Inherited method fallback: if the method wasn't found directly on the class,
  // look for any method with that name that belongs to some parent class.
  // This handles `user.validate()` where User inherits validate from BaseModel.
  const methodCandidates = nameIndex.get(calleeName);
  if (methodCandidates) {
    const match = methodCandidates.find((s) =>
      (s.kind === 'method' || s.kind === 'function')
      && s.parent_symbol_id != null,
    );
    if (match) return match;
  }

  return null;
}

/**
 * Build per-file import map from stored import edges.
 * Returns: file_id → Map<importedName, targetFileId[]>
 *
 * Uses the 'imports' edges that were resolved by resolvePythonImportEdges,
 * plus the pendingImports metadata to know which names were imported.
 */
function buildFileImportMap(state: PipelineState): Map<number, Map<string, number[]>> {
  const { store } = state;
  const result = new Map<number, Map<string, number[]>>();

  // Get file-level import edges for Python files
  const importEdgeType = store.db.prepare(
    `SELECT id FROM edge_types WHERE name = ?`,
  ).get('imports') as { id: number } | undefined;
  if (!importEdgeType) return result;

  // Query import edges with their metadata (which contains specifier names)
  const importEdges = store.db.prepare(`
    SELECT e.source_node_id, e.target_node_id, e.metadata
    FROM edges e
    WHERE e.edge_type_id = ?
  `).all(importEdgeType.id) as Array<{
    source_node_id: number;
    target_node_id: number;
    metadata: string | null;
  }>;

  if (importEdges.length === 0) {
    // Fall back to pendingImports if edges aren't stored yet
    return buildFromPendingImports(state);
  }

  // node_id → file info
  const allNodeIds = new Set<number>();
  for (const e of importEdges) {
    allNodeIds.add(e.source_node_id);
    allNodeIds.add(e.target_node_id);
  }

  // Map node IDs back to file IDs
  const nodeToFileId = new Map<number, number>();
  if (allNodeIds.size > 0) {
    const nodeArr = Array.from(allNodeIds);
    const CHUNK = 500;
    for (let i = 0; i < nodeArr.length; i += CHUNK) {
      const chunk = nodeArr.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = store.db.prepare(
        `SELECT id, ref_id FROM nodes WHERE node_type = 'file' AND id IN (${ph})`,
      ).all(...chunk) as Array<{ id: number; ref_id: number }>;
      for (const r of rows) nodeToFileId.set(r.id, r.ref_id);
    }
  }

  for (const edge of importEdges) {
    const sourceFileId = nodeToFileId.get(edge.source_node_id);
    const targetFileId = nodeToFileId.get(edge.target_node_id);
    if (sourceFileId == null || targetFileId == null) continue;

    let specifiers: string[] = [];
    if (edge.metadata) {
      try {
        const meta = JSON.parse(edge.metadata) as Record<string, unknown>;
        if (Array.isArray(meta.specifiers)) {
          specifiers = meta.specifiers as string[];
        }
        // If importing a module (no specifiers), use the module name
        if (specifiers.length === 0 && typeof meta.from === 'string') {
          const fromPath = meta.from as string;
          const lastPart = fromPath.split('.').pop();
          if (lastPart) specifiers = [lastPart];
        }
      } catch { /* skip */ }
    }

    let fileMap = result.get(sourceFileId);
    if (!fileMap) {
      fileMap = new Map();
      result.set(sourceFileId, fileMap);
    }

    for (const spec of specifiers) {
      if (spec === '*') {
        // Star import — store under '*' key, resolver will check all exported symbols
        const existing = fileMap.get('*') ?? [];
        existing.push(targetFileId);
        fileMap.set('*', existing);
      } else {
        const existing = fileMap.get(spec) ?? [];
        existing.push(targetFileId);
        fileMap.set(spec, existing);
      }
    }
  }

  return result;
}

/**
 * Fallback: build import map from pendingImports when edges haven't been committed yet.
 */
function buildFromPendingImports(state: PipelineState): Map<number, Map<string, number[]>> {
  const result = new Map<number, Map<string, number[]>>();

  // Build module → fileId map
  const allPyFiles = state.store.db.prepare(
    `SELECT id, path FROM files WHERE language = 'python'`,
  ).all() as Array<{ id: number; path: string }>;

  const moduleToFileId = new Map<string, number>();
  for (const f of allPyFiles) {
    const normalized = f.path.replace(/\\/g, '/');
    if (!normalized.endsWith('.py') && !normalized.endsWith('.pyi')) continue;
    let module = normalized.replace(/\.pyi?$/, '');
    if (module.endsWith('/__init__')) module = module.slice(0, -'/__init__'.length);
    moduleToFileId.set(module.replace(/\//g, '.'), f.id);
  }

  for (const [fileId, imports] of state.pendingImports) {
    let fileMap = result.get(fileId);
    if (!fileMap) {
      fileMap = new Map();
      result.set(fileId, fileMap);
    }

    for (const imp of imports) {
      const targetFileId = moduleToFileId.get(imp.from);
      if (targetFileId == null) continue;

      for (const spec of imp.specifiers) {
        const existing = fileMap.get(spec) ?? [];
        existing.push(targetFileId);
        fileMap.set(spec, existing);
      }
    }
  }

  return result;
}
