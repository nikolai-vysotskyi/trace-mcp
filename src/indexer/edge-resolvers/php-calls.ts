/**
 * PHP call edge resolver — resolves symbol-level call and heritage edges.
 *
 * Produces these edge types:
 * - `calls`         — method A calls method B (via $this->, self::, Class::, $obj->)
 * - `instantiates`  — method A creates an instance of class B (via `new B()`)
 * - `extends`       — class A extends class B
 * - `implements`    — class A implements interface B
 * - `uses_trait`    — class A uses trait B
 *
 * Resolution is workspace-isolated: targets are only resolved within the
 * same workspace as the source to prevent false connections between
 * independent projects sharing a common root.
 */
import type { PipelineState } from '../pipeline-state.js';
import type { PhpCallSite } from '../plugins/language/php/helpers.js';
import { logger } from '../../logger.js';

interface PhpSymbol {
  id: number;
  symbol_id: string;
  name: string;
  kind: string;
  fqn: string | null;
  file_id: number;
  parent_id: number | null;
  workspace: string | null;
  metadata: string | null;
}

export function resolvePhpCallEdges(state: PipelineState): void {
  const { store } = state;

  // Resolve edge type IDs
  const callsType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('calls') as { id: number } | undefined;
  const instType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('instantiates') as { id: number } | undefined;
  const extendsType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('extends') as { id: number } | undefined;
  const implementsType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('implements') as { id: number } | undefined;
  const usesTraitType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('uses_trait') as { id: number } | undefined;
  const propType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('accesses_property') as { id: number } | undefined;
  const constType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('accesses_constant') as { id: number } | undefined;
  if (!callsType || !instType || !extendsType || !implementsType || !usesTraitType || !propType || !constType) return;

  // Load all PHP symbols once
  const allSymbols = store.db.prepare(`
    SELECT s.id, s.symbol_id, s.name, s.kind, s.fqn, s.file_id, s.parent_id, f.workspace, s.metadata
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE f.language = 'php'
  `).all() as PhpSymbol[];
  if (allSymbols.length === 0) return;

  // Indexes
  const symbolById = new Map<number, PhpSymbol>();
  const byFqn = new Map<string, PhpSymbol[]>();
  const byName = new Map<string, PhpSymbol[]>();
  const symbolsByFile = new Map<number, PhpSymbol[]>();
  for (const s of allSymbols) {
    symbolById.set(s.id, s);
    if (s.fqn) {
      const list = byFqn.get(s.fqn) ?? [];
      list.push(s);
      byFqn.set(s.fqn, list);
    }
    const nameList = byName.get(s.name) ?? [];
    nameList.push(s);
    byName.set(s.name, nameList);
    const fileList = symbolsByFile.get(s.file_id) ?? [];
    fileList.push(s);
    symbolsByFile.set(s.file_id, fileList);
  }

  // Build per-file use statement map: file_id → Map<shortName, FQN>
  // Reads from file-level php_imports edges' metadata.
  const fileUseMap = buildFileUseMap(state);

  // Build per-file namespace map: file_id → namespace prefix (for relative class refs)
  const fileNamespaceMap = new Map<number, string | null>();
  for (const s of allSymbols) {
    if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'trait' || s.kind === 'enum') {
      if (s.fqn && s.name && s.fqn.endsWith(`\\${s.name}`)) {
        const ns = s.fqn.slice(0, -(s.name.length + 1));
        fileNamespaceMap.set(s.file_id, ns || null);
      } else if (s.fqn === s.name) {
        fileNamespaceMap.set(s.file_id, null);
      }
    }
  }

  // Pre-load node IDs for all symbols
  const symbolNodeMap = new Map<number, number>();
  const CHUNK = 500;
  const allIds = allSymbols.map((s) => s.id);
  for (let i = 0; i < allIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('symbol', allIds.slice(i, i + CHUNK))) {
      symbolNodeMap.set(k, v);
    }
  }

  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
     VALUES (?, ?, ?, 1, ?, ?, 'ast_resolved')`,
  );

  let calls = 0;
  let instantiations = 0;
  let extendsEdges = 0;
  let implementsEdges = 0;
  let usesTraitEdges = 0;
  let propAccesses = 0;
  let constAccesses = 0;

  store.db.transaction(() => {
    for (const sym of allSymbols) {
      if (!sym.metadata) continue;
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(sym.metadata); } catch { continue; }

      const sourceNodeId = symbolNodeMap.get(sym.id);
      if (sourceNodeId == null) continue;

      // Heritage edges: only on classes/interfaces
      if (sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'trait') {
        const ext = meta.extends as string[] | undefined;
        if (Array.isArray(ext)) {
          for (const ref of ext) {
            const target = resolveClassRef(ref, sym, fileUseMap, fileNamespaceMap, byFqn, byName);
            if (!target) continue;
            const tNode = symbolNodeMap.get(target.id);
            if (tNode == null || tNode === sourceNodeId) continue;
            const isCrossWs = sym.workspace !== target.workspace ? 1 : 0;
            if (isCrossWs) continue; // strict workspace isolation
            insertStmt.run(sourceNodeId, tNode, extendsType.id, JSON.stringify({ ref }), 0);
            extendsEdges++;
          }
        }
        const impl = meta.implements as string[] | undefined;
        if (Array.isArray(impl)) {
          for (const ref of impl) {
            const target = resolveClassRef(ref, sym, fileUseMap, fileNamespaceMap, byFqn, byName);
            if (!target) continue;
            const tNode = symbolNodeMap.get(target.id);
            if (tNode == null || tNode === sourceNodeId) continue;
            if (sym.workspace !== target.workspace) continue;
            insertStmt.run(sourceNodeId, tNode, implementsType.id, JSON.stringify({ ref }), 0);
            implementsEdges++;
          }
        }
        const traits = meta.usesTraits as string[] | undefined;
        if (Array.isArray(traits)) {
          for (const ref of traits) {
            const target = resolveClassRef(ref, sym, fileUseMap, fileNamespaceMap, byFqn, byName);
            if (!target) continue;
            const tNode = symbolNodeMap.get(target.id);
            if (tNode == null || tNode === sourceNodeId) continue;
            if (sym.workspace !== target.workspace) continue;
            insertStmt.run(sourceNodeId, tNode, usesTraitType.id, JSON.stringify({ ref }), 0);
            usesTraitEdges++;
          }
        }
      }

      // Call/access edges: only on methods/functions
      if ((sym.kind === 'method' || sym.kind === 'function') && Array.isArray(meta.callSites)) {
        const callSites = meta.callSites as PhpCallSite[];
        for (const cs of callSites) {
          const target = resolveCallSite(cs, sym, symbolById, symbolsByFile, fileUseMap, fileNamespaceMap, byFqn, byName);
          if (!target) continue;
          const tNode = symbolNodeMap.get(target.id);
          if (tNode == null || tNode === sourceNodeId) continue;
          if (sym.workspace !== target.workspace) continue;

          let edgeTypeId: number;
          switch (cs.type) {
            case 'new':
              edgeTypeId = instType.id;
              instantiations++;
              break;
            case 'this_prop':
            case 'member_prop':
            case 'static_prop':
            case 'relative_static_prop':
              edgeTypeId = propType.id;
              propAccesses++;
              break;
            case 'class_const':
            case 'relative_const':
              edgeTypeId = constType.id;
              constAccesses++;
              break;
            default:
              edgeTypeId = callsType.id;
              calls++;
          }
          insertStmt.run(sourceNodeId, tNode, edgeTypeId,
            JSON.stringify({ callee: cs.callee, line: cs.line, kind: cs.type }), 0);
        }
      }
    }
  })();

  const total = calls + instantiations + extendsEdges + implementsEdges + usesTraitEdges + propAccesses + constAccesses;
  if (total > 0) {
    logger.info(
      { calls, instantiations, extendsEdges, implementsEdges, usesTraitEdges, propAccesses, constAccesses },
      'PHP call/heritage edges resolved',
    );
  }
}

/**
 * Resolve a class name reference (may be short name or FQN) to a symbol.
 * Strategy:
 * 1. If ref contains '\\', treat as FQN — look up directly
 * 2. Otherwise, look up via file's use statements (alias or imported short name)
 * 3. Otherwise, try namespace-prefixed (same namespace as source)
 * 4. Otherwise, fall back to global name lookup (ambiguous but last resort)
 */
function resolveClassRef(
  ref: string,
  source: PhpSymbol,
  fileUseMap: Map<number, Map<string, string>>,
  fileNamespaceMap: Map<number, string | null>,
  byFqn: Map<string, PhpSymbol[]>,
  byName: Map<string, PhpSymbol[]>,
): PhpSymbol | null {
  // Strip leading backslash for absolute refs
  const normalized = ref.startsWith('\\') ? ref.slice(1) : ref;

  // 1. FQN lookup
  if (normalized.includes('\\')) {
    const hit = pickClassLike(byFqn.get(normalized), source.workspace);
    if (hit) return hit;
  }

  // 2. Via use statements
  const uses = fileUseMap.get(source.file_id);
  if (uses) {
    // Direct alias/imported name
    const viaUse = uses.get(normalized);
    if (viaUse) {
      const hit = pickClassLike(byFqn.get(viaUse), source.workspace);
      if (hit) return hit;
    }
    // For multi-segment refs like "Models\User", try resolving the first segment
    const firstSeg = normalized.split('\\')[0];
    const firstResolved = uses.get(firstSeg);
    if (firstResolved) {
      const full = firstResolved + normalized.slice(firstSeg.length);
      const hit = pickClassLike(byFqn.get(full), source.workspace);
      if (hit) return hit;
    }
  }

  // 3. Same-namespace prefix
  const ns = fileNamespaceMap.get(source.file_id);
  if (ns) {
    const hit = pickClassLike(byFqn.get(`${ns}\\${normalized}`), source.workspace);
    if (hit) return hit;
  }

  // 4. Global name fallback (no namespace or ambiguous)
  const byNameList = byName.get(normalized.split('\\').pop() ?? normalized);
  if (byNameList) {
    const hit = pickClassLike(byNameList, source.workspace);
    if (hit) return hit;
  }

  return null;
}

/** Pick a class/interface/trait/enum from candidates, preferring same workspace. */
function pickClassLike(candidates: PhpSymbol[] | undefined, workspace: string | null): PhpSymbol | null {
  if (!candidates || candidates.length === 0) return null;
  const classKinds = new Set(['class', 'interface', 'trait', 'enum']);
  const filtered = candidates.filter((c) => classKinds.has(c.kind));
  if (filtered.length === 0) return null;
  // Prefer same workspace
  const sameWs = filtered.find((c) => c.workspace === workspace);
  if (sameWs) return sameWs;
  return filtered[0];
}

/**
 * Resolve a call site to a target symbol.
 */
function resolveCallSite(
  cs: PhpCallSite,
  source: PhpSymbol,
  symbolById: Map<number, PhpSymbol>,
  symbolsByFile: Map<number, PhpSymbol[]>,
  fileUseMap: Map<number, Map<string, string>>,
  fileNamespaceMap: Map<number, string | null>,
  byFqn: Map<string, PhpSymbol[]>,
  byName: Map<string, PhpSymbol[]>,
): PhpSymbol | null {
  // The parent symbol (class the method belongs to), if any
  const parentClass = source.parent_id != null ? symbolById.get(source.parent_id) ?? null : null;

  switch (cs.type) {
    case 'this':
    case 'self': {
      // Look for method in the containing class (and its ancestors via extends)
      if (!parentClass) return null;
      return findMethodInClassHierarchy(cs.callee, parentClass, byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap);
    }

    case 'parent': {
      // Look in the parent class of the containing class
      if (!parentClass || !parentClass.metadata) return null;
      try {
        const parentMeta = JSON.parse(parentClass.metadata) as Record<string, unknown>;
        const ext = parentMeta.extends as string[] | undefined;
        if (!Array.isArray(ext) || ext.length === 0) return null;
        const parentParentClass = resolveClassRef(ext[0], parentClass, fileUseMap, fileNamespaceMap, byFqn, byName);
        if (!parentParentClass) return null;
        return findMethodInClassHierarchy(cs.callee, parentParentClass, byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap);
      } catch { return null; }
    }

    case 'static':
    case 'new': {
      if (!cs.classRef) return null;
      const targetClass = resolveClassRef(cs.classRef, source, fileUseMap, fileNamespaceMap, byFqn, byName);
      if (!targetClass) return null;
      if (cs.type === 'new') {
        // Look for __construct; fall back to the class itself
        const ctor = findMethodInClassHierarchy('__construct', targetClass, byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap);
        return ctor ?? targetClass;
      }
      return findMethodInClassHierarchy(cs.callee, targetClass, byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap);
    }

    case 'member':
      // Dynamic dispatch — receiver type not tracked yet. Skip.
      return null;

    case 'function': {
      // Top-level function call — resolve by name in same namespace or global
      const ns = fileNamespaceMap.get(source.file_id);
      if (ns) {
        const nsHit = pickFunction(byFqn.get(`${ns}\\${cs.callee}`));
        if (nsHit) return nsHit;
      }
      // Via use statements (function imports are rare but possible)
      const uses = fileUseMap.get(source.file_id);
      const viaUse = uses?.get(cs.callee);
      if (viaUse) {
        const hit = pickFunction(byFqn.get(viaUse));
        if (hit) return hit;
      }
      // Global function
      const global = pickFunction(byFqn.get(cs.callee));
      if (global) return global;
      // Any function with that name
      const byNameHit = byName.get(cs.callee)?.find((s) => s.kind === 'function');
      return byNameHit ?? null;
    }

    case 'this_prop': {
      // $this->prop — find property in containing class or ancestors
      if (!parentClass) return null;
      return findMemberInClassHierarchy(
        cs.callee, 'property', parentClass,
        byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap,
      );
    }

    case 'relative_static_prop': {
      // self::$prop — static property in containing class or ancestors
      if (!parentClass) return null;
      return findMemberInClassHierarchy(
        cs.callee, 'property', parentClass,
        byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap,
      );
    }

    case 'static_prop': {
      // Class::$prop — static property on a specific class
      if (!cs.classRef) return null;
      const targetClass = resolveClassRef(cs.classRef, source, fileUseMap, fileNamespaceMap, byFqn, byName);
      if (!targetClass) return null;
      return findMemberInClassHierarchy(
        cs.callee, 'property', targetClass,
        byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap,
      );
    }

    case 'relative_const': {
      // self::FOO — constant or enum_case in containing class or ancestors
      if (!parentClass) return null;
      return findConstOrEnumCase(
        cs.callee, parentClass,
        byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap,
      );
    }

    case 'class_const': {
      // Class::FOO — constant or enum case on a specific class/enum
      if (!cs.classRef) return null;
      const targetClass = resolveClassRef(cs.classRef, source, fileUseMap, fileNamespaceMap, byFqn, byName);
      if (!targetClass) return null;
      return findConstOrEnumCase(
        cs.callee, targetClass,
        byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap,
      );
    }

    case 'member_prop':
      // Dynamic dispatch ($obj->prop) — receiver type not tracked yet.
      return null;
  }
}

/**
 * Find a property in the class hierarchy (walks extends + traits).
 */
function findMemberInClassHierarchy(
  memberName: string,
  memberKind: 'property',
  classSymbol: PhpSymbol,
  byFqn: Map<string, PhpSymbol[]>,
  byName: Map<string, PhpSymbol[]>,
  symbolsByFile: Map<number, PhpSymbol[]>,
  fileUseMap: Map<number, Map<string, string>>,
  fileNamespaceMap: Map<number, string | null>,
  visited = new Set<number>(),
): PhpSymbol | null {
  if (visited.has(classSymbol.id)) return null;
  visited.add(classSymbol.id);

  const fileSymbols = symbolsByFile.get(classSymbol.file_id) ?? [];
  const direct = fileSymbols.find((s) =>
    s.kind === memberKind && s.name === memberName && s.parent_id === classSymbol.id,
  );
  if (direct) return direct;

  if (!classSymbol.metadata) return null;
  try {
    const meta = JSON.parse(classSymbol.metadata) as Record<string, unknown>;
    const parents: string[] = [];
    if (Array.isArray(meta.extends)) parents.push(...(meta.extends as string[]));
    if (Array.isArray(meta.usesTraits)) parents.push(...(meta.usesTraits as string[]));

    for (const ref of parents) {
      const parentClass = resolveClassRef(ref, classSymbol, fileUseMap, fileNamespaceMap, byFqn, byName);
      if (!parentClass) continue;
      const found = findMemberInClassHierarchy(
        memberName, memberKind, parentClass,
        byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap, visited,
      );
      if (found) return found;
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Find a constant or enum case in a class/enum or its ancestors.
 * Class constants can be inherited via extends; enum cases cannot.
 */
function findConstOrEnumCase(
  memberName: string,
  classSymbol: PhpSymbol,
  byFqn: Map<string, PhpSymbol[]>,
  byName: Map<string, PhpSymbol[]>,
  symbolsByFile: Map<number, PhpSymbol[]>,
  fileUseMap: Map<number, Map<string, string>>,
  fileNamespaceMap: Map<number, string | null>,
  visited = new Set<number>(),
): PhpSymbol | null {
  if (visited.has(classSymbol.id)) return null;
  visited.add(classSymbol.id);

  const fileSymbols = symbolsByFile.get(classSymbol.file_id) ?? [];
  // Enum cases live inside enums
  if (classSymbol.kind === 'enum') {
    const enumCase = fileSymbols.find((s) =>
      s.kind === 'enum_case' && s.name === memberName && s.parent_id === classSymbol.id,
    );
    if (enumCase) return enumCase;
  }

  // Regular class constant
  const constant = fileSymbols.find((s) =>
    s.kind === 'constant' && s.name === memberName && s.parent_id === classSymbol.id,
  );
  if (constant) return constant;

  // Walk ancestors for constants (enum cases don't inherit)
  if (!classSymbol.metadata) return null;
  try {
    const meta = JSON.parse(classSymbol.metadata) as Record<string, unknown>;
    const parents: string[] = [];
    if (Array.isArray(meta.extends)) parents.push(...(meta.extends as string[]));
    if (Array.isArray(meta.implements)) parents.push(...(meta.implements as string[]));
    if (Array.isArray(meta.usesTraits)) parents.push(...(meta.usesTraits as string[]));

    for (const ref of parents) {
      const parentClass = resolveClassRef(ref, classSymbol, fileUseMap, fileNamespaceMap, byFqn, byName);
      if (!parentClass) continue;
      const found = findConstOrEnumCase(
        memberName, parentClass,
        byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap, visited,
      );
      if (found) return found;
    }
  } catch { /* ignore */ }

  return null;
}

function pickFunction(candidates: PhpSymbol[] | undefined): PhpSymbol | null {
  if (!candidates) return null;
  return candidates.find((c) => c.kind === 'function') ?? null;
}

/**
 * Find a method by name in a class or its ancestor classes/traits.
 */
function findMethodInClassHierarchy(
  methodName: string,
  classSymbol: PhpSymbol,
  byFqn: Map<string, PhpSymbol[]>,
  byName: Map<string, PhpSymbol[]>,
  symbolsByFile: Map<number, PhpSymbol[]>,
  fileUseMap: Map<number, Map<string, string>>,
  fileNamespaceMap: Map<number, string | null>,
  visited = new Set<number>(),
): PhpSymbol | null {
  if (visited.has(classSymbol.id)) return null;
  visited.add(classSymbol.id);

  // Look for method directly in this class
  const fileSymbols = symbolsByFile.get(classSymbol.file_id) ?? [];
  const methodFqn = classSymbol.fqn ? `${classSymbol.fqn}\\${methodName}` : null;
  const direct = fileSymbols.find((s) =>
    s.kind === 'method' && s.name === methodName && s.parent_id === classSymbol.id,
  );
  if (direct) return direct;

  // Also check by FQN (handles edge cases)
  if (methodFqn) {
    const hit = byFqn.get(methodFqn)?.find((s) => s.kind === 'method');
    if (hit) return hit;
  }

  // Walk up via extends and uses_trait
  if (!classSymbol.metadata) return null;
  try {
    const meta = JSON.parse(classSymbol.metadata) as Record<string, unknown>;
    const parents: string[] = [];
    if (Array.isArray(meta.extends)) parents.push(...(meta.extends as string[]));
    if (Array.isArray(meta.usesTraits)) parents.push(...(meta.usesTraits as string[]));

    for (const ref of parents) {
      const parentClass = resolveClassRef(ref, classSymbol, fileUseMap, fileNamespaceMap, byFqn, byName);
      if (!parentClass) continue;
      const found = findMethodInClassHierarchy(methodName, parentClass, byFqn, byName, symbolsByFile, fileUseMap, fileNamespaceMap, visited);
      if (found) return found;
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Build per-file map: file_id → Map<shortName, FQN>
 * Reads from php_imports edges stored in pendingImports state.
 */
function buildFileUseMap(state: PipelineState): Map<number, Map<string, string>> {
  const result = new Map<number, Map<string, string>>();

  // Query from file-level import edges already resolved
  const rows = state.store.db.prepare(`
    SELECT n_src.ref_id as source_file_id, e.metadata
    FROM edges e
    JOIN edge_types et ON e.edge_type_id = et.id
    JOIN nodes n_src ON e.source_node_id = n_src.id
    JOIN files f ON n_src.ref_id = f.id AND n_src.node_type = 'file'
    WHERE et.name = 'imports' AND f.language = 'php' AND e.metadata IS NOT NULL
  `).all() as Array<{ source_file_id: number; metadata: string | null }>;

  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      const meta = JSON.parse(row.metadata) as { from?: string; specifiers?: string[] };
      if (!meta.from) continue;
      const fqn = meta.from;
      const shortName = meta.specifiers?.[0] ?? fqn.split('\\').pop() ?? fqn;
      let fileMap = result.get(row.source_file_id);
      if (!fileMap) {
        fileMap = new Map();
        result.set(row.source_file_id, fileMap);
      }
      fileMap.set(shortName, fqn);
    } catch { /* ignore */ }
  }

  return result;
}
