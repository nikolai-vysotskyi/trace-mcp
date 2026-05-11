/**
 * TypeScript/JavaScript call edge resolver.
 * Resolves call sites stored in symbol metadata into `calls` edges.
 *
 * Resolution strategy (ordered by confidence):
 *   1. this.method()  → same class methods, then inherited (via `extends`)
 *   2. super.method() → parent class methods
 *   3. foo()          → same-file top-level function, then imported name,
 *                       then globally-unique function (name-index fallback)
 *   4. x.method()     → receiverType / localTypes inference → class method
 *   5. Cls.method()   → static method on `Cls` (same file or imported)
 *
 * Runs AFTER ESM import resolution so `imports` edges are available.
 */

import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

interface TsCallSite {
  calleeName: string;
  line: number;
  receiver?: string;
  isThisCall?: boolean;
  isSuperCall?: boolean;
  isNew?: boolean;
  receiverType?: string;
  receiverAssignedFrom?: string;
}

interface LocalTypes {
  [name: string]: { type?: string; assignedFrom?: string };
}

interface SymbolRow {
  id: number;
  symbol_id: string;
  name: string;
  kind: string;
  file_id: number;
  parent_symbol_id: string | null;
  metadata: string | null;
  workspace: string | null;
}

type SymEntry = {
  id: number;
  symbol_id: string;
  name: string;
  kind: string;
  file_id: number;
  parent_symbol_id: string | null;
  metadata?: string | null;
  workspace: string | null;
};

const TS_JS_LANGS = "('typescript','javascript','tsx','jsx','vue')";

export function resolveTypeScriptCallEdges(state: PipelineState, scope?: ChangeScope): void {
  const { store } = state;

  const callsEdgeType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('calls') as
    | { id: number }
    | undefined;
  if (!callsEdgeType) return;

  // Scope-aware source SELECT: only re-resolve call edges OUT from files
  // whose symbols were re-extracted in this run. Targets are still queried
  // globally (cross-file resolution needs the full symbol set). Outgoing
  // edges from unchanged files were not deleted, so we don't recreate them.
  const scopedIds = scope ? Array.from(scope.changedFileIds) : null;
  if (scopedIds && scopedIds.length === 0) return;

  let symbolsWithCalls: SymbolRow[];
  if (scopedIds && scopedIds.length > 0) {
    const ph = scopedIds.map(() => '?').join(',');
    symbolsWithCalls = store.db
      .prepare(`
      SELECT s.id, s.symbol_id, s.name, s.kind, s.file_id,
             p.symbol_id AS parent_symbol_id, s.metadata, f.workspace
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        LEFT JOIN symbols p ON s.parent_id = p.id
       WHERE f.language IN ${TS_JS_LANGS}
         AND s.metadata IS NOT NULL
         AND s.metadata LIKE '%"callSites"%'
         AND s.file_id IN (${ph})
    `)
      .all(...scopedIds) as SymbolRow[];
  } else {
    symbolsWithCalls = store.db
      .prepare(`
      SELECT s.id, s.symbol_id, s.name, s.kind, s.file_id,
             p.symbol_id AS parent_symbol_id, s.metadata, f.workspace
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        LEFT JOIN symbols p ON s.parent_id = p.id
       WHERE f.language IN ${TS_JS_LANGS}
         AND s.metadata IS NOT NULL
         AND s.metadata LIKE '%"callSites"%'
    `)
      .all() as SymbolRow[];
  }

  if (symbolsWithCalls.length === 0) return;

  const allSyms = store.db
    .prepare(`
    SELECT s.id, s.symbol_id, s.name, s.kind, s.file_id,
           p.symbol_id AS parent_symbol_id, s.metadata, f.workspace
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      LEFT JOIN symbols p ON s.parent_id = p.id
     WHERE f.language IN ${TS_JS_LANGS}
  `)
    .all() as SymEntry[];

  // Indexes
  const nameIndex = new Map<string, SymEntry[]>();
  const symbolById = new Map<string, SymEntry>();
  const symbolsByFile = new Map<number, SymEntry[]>();

  for (const s of allSyms) {
    const byName = nameIndex.get(s.name) ?? [];
    byName.push(s);
    nameIndex.set(s.name, byName);

    symbolById.set(s.symbol_id, s);

    const byFile = symbolsByFile.get(s.file_id) ?? [];
    byFile.push(s);
    symbolsByFile.set(s.file_id, byFile);
  }

  // per-file imports
  const fileImportMap = buildFileImportMap(state);

  // Pre-load node IDs for all symbols
  const symbolNodeMap = new Map<number, number>();
  const CHUNK = 500;
  const allSymIds = allSyms.map((s) => s.id);
  for (let i = 0; i < allSymIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('symbol', allSymIds.slice(i, i + CHUNK))) {
      symbolNodeMap.set(k, v);
    }
  }

  // Build class heritage index: class symbol_id → extends class name (unresolved), implements
  const classExtends = new Map<string, string>();
  for (const s of allSyms) {
    if (s.kind !== 'class' || !s.metadata) continue;
    try {
      const meta = JSON.parse(s.metadata) as Record<string, unknown>;
      if (typeof meta.extends === 'string') classExtends.set(s.symbol_id, meta.extends);
    } catch {
      /* ignore */
    }
  }

  // Build return-type index from signatures: funcName → type
  // `function getUser(): User` / `const getUser = (): User => ...`
  const returnTypeIndex = new Map<string, string>();
  for (const s of allSyms) {
    if (s.kind !== 'function' && s.kind !== 'method') continue;
    const row = store.db.prepare(`SELECT signature FROM symbols WHERE id = ?`).get(s.id) as
      | { signature: string | null }
      | undefined;
    if (!row?.signature) continue;
    const m = row.signature.match(/\):\s*(?:Promise<)?([A-Z][A-Za-z0-9_]*)/);
    if (m) returnTypeIndex.set(s.name, m[1]);
  }

  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
     VALUES (?, ?, ?, 1, ?, 0, 'ast_resolved')`,
  );

  let created = 0;

  store.db.transaction(() => {
    for (const sym of symbolsWithCalls) {
      let callSites: TsCallSite[];
      let localTypes: LocalTypes = {};
      try {
        const meta = JSON.parse(sym.metadata!) as Record<string, unknown>;
        const cs = meta.callSites;
        if (!Array.isArray(cs)) continue;
        callSites = cs as TsCallSite[];
        if (meta.localTypes && typeof meta.localTypes === 'object') {
          localTypes = meta.localTypes as LocalTypes;
        }
      } catch {
        continue;
      }

      const sourceNodeId = symbolNodeMap.get(sym.id);
      if (sourceNodeId == null) continue;

      const parentClassId = sym.parent_symbol_id;
      const fileSymbols = symbolsByFile.get(sym.file_id) ?? [];
      const fileImports = fileImportMap.get(sym.file_id);
      const sourceWorkspace = sym.workspace;

      for (const call of callSites) {
        const target = resolveCall(
          call,
          parentClassId,
          fileSymbols,
          fileImports,
          nameIndex,
          symbolsByFile,
          symbolById,
          classExtends,
          returnTypeIndex,
          localTypes,
          sourceWorkspace,
        );
        if (!target) continue;

        const targetNodeId = symbolNodeMap.get(target.id);
        if (targetNodeId == null || targetNodeId === sourceNodeId) continue;

        const edgeMeta: Record<string, unknown> = { callee: call.calleeName, line: call.line };
        if (call.receiverType) edgeMeta.receiver_type = call.receiverType;
        if (call.isNew) edgeMeta.new = true;

        insertStmt.run(sourceNodeId, targetNodeId, callsEdgeType.id, JSON.stringify(edgeMeta));
        created++;
      }
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'TypeScript/JavaScript call edges resolved');
  }
}

/** Pick best candidate from a list, preferring same workspace. Strict: never cross workspace. */
function pickSameWs<T extends { workspace: string | null }>(
  candidates: T[],
  workspace: string | null,
): T | null {
  if (candidates.length === 0) return null;
  const sameWs = candidates.filter((c) => c.workspace === workspace);
  if (sameWs.length > 0) return sameWs[0];
  return null; // strict workspace isolation — never leak across workspaces
}

function resolveCall(
  call: TsCallSite,
  parentClassId: string | null,
  fileSymbols: SymEntry[],
  fileImports: Map<string, number[]> | undefined,
  nameIndex: Map<string, SymEntry[]>,
  symbolsByFile: Map<number, SymEntry[]>,
  symbolById: Map<string, SymEntry>,
  classExtends: Map<string, string>,
  returnTypeIndex: Map<string, string>,
  localTypes: LocalTypes,
  sourceWorkspace: string | null,
): SymEntry | null {
  const { calleeName, receiver, isThisCall, isSuperCall, isNew } = call;

  // ── 1. this.method() ──
  if (isThisCall && parentClassId) {
    const sameClass = fileSymbols.find(
      (s) => s.parent_symbol_id === parentClassId && s.name === calleeName,
    );
    if (sameClass) return sameClass;

    // Walk `extends` chain
    const inherited = resolveInheritedMember(
      parentClassId,
      calleeName,
      fileSymbols,
      fileImports,
      nameIndex,
      symbolsByFile,
      classExtends,
      sourceWorkspace,
    );
    if (inherited) return inherited;

    return null;
  }

  // ── 2. super.method() ──
  if (isSuperCall && parentClassId) {
    return resolveInheritedMember(
      parentClassId,
      calleeName,
      fileSymbols,
      fileImports,
      nameIndex,
      symbolsByFile,
      classExtends,
      sourceWorkspace,
    );
  }

  // ── 3. Bare call: foo() or new Foo() ──
  if (!receiver) {
    // Same-file top-level function / class
    const sameFile = fileSymbols.find(
      (s) =>
        s.name === calleeName &&
        s.parent_symbol_id == null &&
        (s.kind === 'function' || s.kind === 'class' || (isNew && s.kind === 'class')),
    );
    if (sameFile) return sameFile;

    // Imported name
    if (fileImports) {
      const targetFileIds = fileImports.get(calleeName);
      if (targetFileIds) {
        for (const tfid of targetFileIds) {
          const syms = symbolsByFile.get(tfid) ?? [];
          const match = syms.find(
            (s) =>
              s.name === calleeName &&
              s.parent_symbol_id == null &&
              (s.kind === 'function' || s.kind === 'class' || s.kind === 'variable'),
          );
          if (match) return match;
        }
      }
    }

    // Workspace-scoped candidate pick (covers Nuxt/Vue auto-imports:
    // composables used without explicit imports still land in the same workspace).
    const candidates = nameIndex.get(calleeName);
    if (candidates) {
      const topLevel = candidates.filter(
        (s) =>
          s.parent_symbol_id == null &&
          (s.kind === 'function' || s.kind === 'class' || s.kind === 'variable'),
      );
      if (topLevel.length === 0) return null;
      if (topLevel.length === 1) {
        // If only one candidate globally, honor workspace isolation — but
        // in monorepos a unique match is often correct. Accept only if
        // same workspace OR no workspace defined.
        if (topLevel[0].workspace === sourceWorkspace) return topLevel[0];
        return null;
      }
      return pickSameWs(topLevel, sourceWorkspace);
    }

    return null;
  }

  // ── 4. Member call: receiver.method() ──
  // 4a. Inline: (new Foo()).method()
  if (call.receiverType) {
    const m = resolveMethodOnClass(
      call.receiverType,
      calleeName,
      fileSymbols,
      fileImports,
      nameIndex,
      symbolsByFile,
      symbolById,
      classExtends,
      sourceWorkspace,
    );
    if (m) return m;
  }

  // 4b. Local variable: const x = new Foo() → resolve method on Foo
  const local = localTypes[receiver];
  if (local?.type) {
    const m = resolveMethodOnClass(
      local.type,
      calleeName,
      fileSymbols,
      fileImports,
      nameIndex,
      symbolsByFile,
      symbolById,
      classExtends,
      sourceWorkspace,
    );
    if (m) return m;
  }
  if (local?.assignedFrom) {
    const retType = returnTypeIndex.get(local.assignedFrom);
    if (retType) {
      const m = resolveMethodOnClass(
        retType,
        calleeName,
        fileSymbols,
        fileImports,
        nameIndex,
        symbolsByFile,
        symbolById,
        classExtends,
      );
      if (m) return m;
    }
  }

  // 4c. this.foo from localTypes (this.foo = new Foo())
  const thisKey = `this.${receiver}`;
  const thisBinding = localTypes[thisKey];
  if (thisBinding?.type) {
    const m = resolveMethodOnClass(
      thisBinding.type,
      calleeName,
      fileSymbols,
      fileImports,
      nameIndex,
      symbolsByFile,
      symbolById,
      classExtends,
      sourceWorkspace,
    );
    if (m) return m;
  }

  // 4d. Receiver is a class in same file (static method: Cls.foo())
  const sameFileClass = fileSymbols.find(
    (s) => s.name === receiver && s.kind === 'class' && s.parent_symbol_id == null,
  );
  if (sameFileClass) {
    const method = fileSymbols.find(
      (s) => s.parent_symbol_id === sameFileClass.symbol_id && s.name === calleeName,
    );
    if (method) return method;
  }

  // 4e. Receiver is imported (class/namespace)
  if (fileImports) {
    const targetFileIds = fileImports.get(receiver);
    if (targetFileIds) {
      for (const tfid of targetFileIds) {
        const syms = symbolsByFile.get(tfid) ?? [];
        // First, try class.method
        const cls = syms.find((s) => s.name === receiver && s.kind === 'class');
        if (cls) {
          const method = syms.find(
            (s) => s.parent_symbol_id === cls.symbol_id && s.name === calleeName,
          );
          if (method) return method;
        }
        // Or top-level function on receiver module
        const topFn = syms.find(
          (s) =>
            s.name === calleeName &&
            s.parent_symbol_id == null &&
            (s.kind === 'function' || s.kind === 'variable'),
        );
        if (topFn) return topFn;
      }
    }
  }

  return null;
}

function resolveInheritedMember(
  classSymbolId: string,
  memberName: string,
  fileSymbols: SymEntry[],
  fileImports: Map<string, number[]> | undefined,
  nameIndex: Map<string, SymEntry[]>,
  symbolsByFile: Map<number, SymEntry[]>,
  classExtends: Map<string, string>,
  sourceWorkspace?: string | null,
): SymEntry | null {
  // Walk up class's extends chain by name
  const seen = new Set<string>();
  let currentClassId: string | null = classSymbolId;
  while (currentClassId && !seen.has(currentClassId)) {
    seen.add(currentClassId);
    const parentName = classExtends.get(currentClassId);
    if (!parentName) break;

    const parentClass = resolveClassByName(
      parentName,
      fileSymbols,
      fileImports,
      nameIndex,
      symbolsByFile,
      sourceWorkspace,
    );
    if (!parentClass) return null;

    // search the parent class for the member
    const syms = symbolsByFile.get(parentClass.file_id) ?? [];
    const member = syms.find(
      (s) => s.parent_symbol_id === parentClass.symbol_id && s.name === memberName,
    );
    if (member) return member;

    currentClassId = parentClass.symbol_id;
  }
  return null;
}

function resolveClassByName(
  name: string,
  fileSymbols: SymEntry[],
  fileImports: Map<string, number[]> | undefined,
  nameIndex: Map<string, SymEntry[]>,
  symbolsByFile: Map<number, SymEntry[]>,
  sourceWorkspace?: string | null,
): SymEntry | null {
  // same file first
  const same = fileSymbols.find((s) => s.name === name && s.kind === 'class');
  if (same) return same;

  // imported
  if (fileImports) {
    const tfids = fileImports.get(name);
    if (tfids) {
      for (const tfid of tfids) {
        const syms = symbolsByFile.get(tfid) ?? [];
        const cls = syms.find((s) => s.name === name && s.kind === 'class');
        if (cls) return cls;
      }
    }
  }

  // global — workspace-preferring
  const cands = nameIndex.get(name);
  if (cands) {
    const classes = cands.filter((s) => s.kind === 'class');
    if (classes.length === 0) return null;
    if (sourceWorkspace !== undefined) {
      const pick = pickSameWs(classes, sourceWorkspace);
      if (pick) return pick;
      return null;
    }
    if (classes.length === 1) return classes[0];
  }
  return null;
}

function resolveMethodOnClass(
  className: string,
  methodName: string,
  fileSymbols: SymEntry[],
  fileImports: Map<string, number[]> | undefined,
  nameIndex: Map<string, SymEntry[]>,
  symbolsByFile: Map<number, SymEntry[]>,
  _symbolById: Map<string, SymEntry>,
  classExtends: Map<string, string>,
  sourceWorkspace?: string | null,
): SymEntry | null {
  const cls = resolveClassByName(
    className,
    fileSymbols,
    fileImports,
    nameIndex,
    symbolsByFile,
    sourceWorkspace,
  );
  if (!cls) return null;

  // Search the class
  const syms = symbolsByFile.get(cls.file_id) ?? [];
  const method = syms.find((s) => s.parent_symbol_id === cls.symbol_id && s.name === methodName);
  if (method) return method;

  // Walk parents
  return resolveInheritedMember(
    cls.symbol_id,
    methodName,
    syms,
    fileImports,
    nameIndex,
    symbolsByFile,
    classExtends,
    sourceWorkspace,
  );
}

/**
 * Build per-file import map from stored `imports` edges (TS/JS).
 * Returns: source_file_id → Map<importedName, target_file_id[]>
 */
function buildFileImportMap(state: PipelineState): Map<number, Map<string, number[]>> {
  const { store } = state;
  const result = new Map<number, Map<string, number[]>>();

  const importEdgeType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('imports') as { id: number } | undefined;
  if (!importEdgeType) return result;

  const importEdges = store.db
    .prepare(`
    SELECT e.source_node_id, e.target_node_id, e.metadata
      FROM edges e
      JOIN nodes ns ON ns.id = e.source_node_id
      JOIN nodes nt ON nt.id = e.target_node_id
     WHERE e.edge_type_id = ?
       AND ns.node_type = 'file'
       AND nt.node_type = 'file'
  `)
    .all(importEdgeType.id) as Array<{
    source_node_id: number;
    target_node_id: number;
    metadata: string | null;
  }>;

  if (importEdges.length === 0) return result;

  const allNodeIds = new Set<number>();
  for (const e of importEdges) {
    allNodeIds.add(e.source_node_id);
    allNodeIds.add(e.target_node_id);
  }

  const nodeToFileId = new Map<number, number>();
  if (allNodeIds.size > 0) {
    const nodeArr = Array.from(allNodeIds);
    const CHUNK = 500;
    for (let i = 0; i < nodeArr.length; i += CHUNK) {
      const chunk = nodeArr.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = store.db
        .prepare(`SELECT id, ref_id FROM nodes WHERE node_type = 'file' AND id IN (${ph})`)
        .all(...chunk) as Array<{ id: number; ref_id: number }>;
      for (const r of rows) nodeToFileId.set(r.id, r.ref_id);
    }
  }

  // Filter to TS/JS source files (avoid PHP/Python polluting the map)
  const tsJsFileIds = new Set<number>();
  const fileLangs = store.db
    .prepare(`
    SELECT id FROM files WHERE language IN ${TS_JS_LANGS}
  `)
    .all() as Array<{ id: number }>;
  for (const r of fileLangs) tsJsFileIds.add(r.id);

  for (const edge of importEdges) {
    const sourceFileId = nodeToFileId.get(edge.source_node_id);
    const targetFileId = nodeToFileId.get(edge.target_node_id);
    if (sourceFileId == null || targetFileId == null) continue;
    if (!tsJsFileIds.has(sourceFileId)) continue;

    let specifiers: string[] = [];
    if (edge.metadata) {
      try {
        const meta = JSON.parse(edge.metadata) as Record<string, unknown>;
        if (Array.isArray(meta.specifiers)) specifiers = meta.specifiers as string[];
      } catch {
        /* ignore */
      }
    }

    let fileMap = result.get(sourceFileId);
    if (!fileMap) {
      fileMap = new Map();
      result.set(sourceFileId, fileMap);
    }

    for (const spec of specifiers) {
      if (!spec || spec === '*') continue;
      // Normalize `* as NS` → NS
      const match = spec.match(/^\*\s+as\s+(\w+)$/);
      const name = match ? match[1] : spec;

      const existing = fileMap.get(name) ?? [];
      if (!existing.includes(targetFileId)) existing.push(targetFileId);
      fileMap.set(name, existing);
    }
  }

  return result;
}
