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
import { PhantomSymbolFactory } from './phantom-externals.js';

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
  const callsType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('calls') as
    | { id: number }
    | undefined;
  const instType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('instantiates') as { id: number } | undefined;
  const extendsType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('extends') as
    | { id: number }
    | undefined;
  const implementsType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('implements') as { id: number } | undefined;
  const usesTraitType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('uses_trait') as { id: number } | undefined;
  const propType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('accesses_property') as { id: number } | undefined;
  const constType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('accesses_constant') as { id: number } | undefined;
  const refType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('references') as
    | { id: number }
    | undefined;
  if (
    !callsType ||
    !instType ||
    !extendsType ||
    !implementsType ||
    !usesTraitType ||
    !propType ||
    !constType ||
    !refType
  )
    return;

  // Load all PHP symbols once
  const allSymbols = store.db
    .prepare(`
    SELECT s.id, s.symbol_id, s.name, s.kind, s.fqn, s.file_id, s.parent_id, f.workspace, s.metadata
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE f.language = 'php'
  `)
    .all() as PhpSymbol[];
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

  // Phantom factory: creates synthetic symbol nodes for vendor classes
  // (Migration, Model, Controller, etc.) so framework-base edges still land
  // somewhere and cluster descendants together in the graph.
  const phantoms = new PhantomSymbolFactory(state, 'php');
  let phantomNodesCreated = 0;

  let calls = 0;
  let instantiations = 0;
  let extendsEdges = 0;
  let implementsEdges = 0;
  let usesTraitEdges = 0;
  let propAccesses = 0;
  let constAccesses = 0;
  let typeRefs = 0;

  /** Helper to emit a reference edge to a class if the ref resolves. */
  function emitRef(
    sourceNodeId: number,
    source: PhpSymbol,
    classRef: string,
    refKind: string,
  ): void {
    const target = resolveClassRef(classRef, source, fileUseMap, fileNamespaceMap, byFqn, byName);
    if (target) {
      const tNode = symbolNodeMap.get(target.id);
      if (tNode == null || tNode === sourceNodeId) return;
      if (source.workspace !== target.workspace) return;
      insertStmt.run(
        sourceNodeId,
        tNode,
        refType!.id,
        JSON.stringify({ ref: classRef, kind: refKind }),
        0,
      );
      typeRefs++;
      return;
    }
    // Fallback: phantom external class (vendor/framework base)
    const phantomFqn = resolveFqnForRef(classRef, source, fileUseMap, fileNamespaceMap);
    if (!phantomFqn) return;
    const before = phantoms.peek(phantomFqn, source.workspace);
    const phantom = phantoms.ensure(phantomFqn, source.workspace, 'class');
    if (!before) phantomNodesCreated++;
    if (phantom.node_id === sourceNodeId) return;
    insertStmt.run(
      sourceNodeId,
      phantom.node_id,
      refType!.id,
      JSON.stringify({ ref: classRef, kind: refKind, external: true }),
      0,
    );
    typeRefs++;
  }

  store.db.transaction(() => {
    for (const sym of allSymbols) {
      if (!sym.metadata) continue;
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(sym.metadata);
      } catch {
        continue;
      }

      const sourceNodeId = symbolNodeMap.get(sym.id);
      if (sourceNodeId == null) continue;

      // Heritage edges: only on classes/interfaces.
      //
      // For each ref (extends/implements/uses trait), we first try to resolve
      // against the indexed project. On miss (common case: the parent is a
      // framework class in vendor/ — Migration, Model, Controller, Resource,
      // ServiceProvider, etc.) we emit the edge to a phantom external node.
      // This is what clusters all N Laravel migrations into one community,
      // every Nova resource into another, and so on.
      if (sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'trait') {
        const emitHeritage = (
          refs: string[] | undefined,
          edgeTypeId: number,
          phantomKind: 'class' | 'interface' | 'trait',
          counter: () => void,
        ): void => {
          if (!Array.isArray(refs)) return;
          for (const ref of refs) {
            const target = resolveClassRef(ref, sym, fileUseMap, fileNamespaceMap, byFqn, byName);
            if (target) {
              const tNode = symbolNodeMap.get(target.id);
              if (tNode == null || tNode === sourceNodeId) continue;
              if (sym.workspace !== target.workspace) continue; // strict workspace isolation
              insertStmt.run(sourceNodeId, tNode, edgeTypeId, JSON.stringify({ ref }), 0);
              counter();
              continue;
            }
            // Phantom fallback — synthesize a node for the unresolved class
            const phantomFqn = resolveFqnForRef(ref, sym, fileUseMap, fileNamespaceMap);
            if (!phantomFqn) continue;
            const before = phantoms.peek(phantomFqn, sym.workspace);
            const phantom = phantoms.ensure(phantomFqn, sym.workspace, phantomKind);
            if (!before) phantomNodesCreated++;
            if (phantom.node_id === sourceNodeId) continue;
            insertStmt.run(
              sourceNodeId,
              phantom.node_id,
              edgeTypeId,
              JSON.stringify({ ref, external: true }),
              0,
            );
            counter();
          }
        };
        emitHeritage(meta.extends as string[] | undefined, extendsType.id, 'class', () => {
          extendsEdges++;
        });
        emitHeritage(
          meta.implements as string[] | undefined,
          implementsType.id,
          'interface',
          () => {
            implementsEdges++;
          },
        );
        emitHeritage(meta.usesTraits as string[] | undefined, usesTraitType.id, 'trait', () => {
          usesTraitEdges++;
        });
      }

      // Type reference edges — connect symbols to classes used as type hints.
      // This turns type-hint-only classes from disconnected into connected.
      if (sym.kind === 'method' || sym.kind === 'function') {
        // Parameter types
        const paramTypes = meta.paramTypes as Record<string, string> | undefined;
        if (paramTypes) {
          for (const type of Object.values(paramTypes)) {
            emitRef(sourceNodeId, sym, type, 'param_type');
          }
        }
        // Return type
        const retType = meta.returnType as string | undefined;
        if (retType) emitRef(sourceNodeId, sym, retType, 'return_type');
      }
      if (sym.kind === 'property') {
        const propType = meta.type as string | undefined;
        if (propType) emitRef(sourceNodeId, sym, propType, 'property_type');
      }

      // Call/access edges: only on methods/functions
      if ((sym.kind === 'method' || sym.kind === 'function') && Array.isArray(meta.callSites)) {
        const callSites = meta.callSites as PhpCallSite[];
        for (const cs of callSites) {
          const target = resolveCallSite(
            cs,
            sym,
            symbolById,
            symbolsByFile,
            fileUseMap,
            fileNamespaceMap,
            byFqn,
            byName,
          );
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
            case 'class_ref':
              edgeTypeId = refType.id;
              typeRefs++;
              break;
            default:
              edgeTypeId = callsType.id;
              calls++;
          }
          insertStmt.run(
            sourceNodeId,
            tNode,
            edgeTypeId,
            JSON.stringify({ callee: cs.callee, line: cs.line, kind: cs.type }),
            0,
          );
        }
      }
    }
  })();

  const total =
    calls +
    instantiations +
    extendsEdges +
    implementsEdges +
    usesTraitEdges +
    propAccesses +
    constAccesses +
    typeRefs;
  if (total > 0) {
    logger.info(
      {
        calls,
        instantiations,
        extendsEdges,
        implementsEdges,
        usesTraitEdges,
        propAccesses,
        constAccesses,
        typeRefs,
        phantomNodesCreated,
      },
      'PHP call/heritage edges resolved',
    );
  }
}

/**
 * Resolve a short or dotted class reference to its FQN without requiring the
 * class to be in the index. Used to derive a stable identity for phantom
 * external symbols so edges from different files land on the same node.
 */
function resolveFqnForRef(
  ref: string,
  source: PhpSymbol,
  fileUseMap: Map<number, Map<string, string>>,
  fileNamespaceMap: Map<number, string | null>,
): string | null {
  if (!ref) return null;
  const normalized = ref.startsWith('\\') ? ref.slice(1) : ref;
  if (!normalized) return null;

  // Already an FQN
  if (normalized.includes('\\')) {
    const uses = fileUseMap.get(source.file_id);
    if (uses) {
      const firstSeg = normalized.split('\\')[0];
      const firstResolved = uses.get(firstSeg);
      if (firstResolved) return firstResolved + normalized.slice(firstSeg.length);
    }
    return normalized;
  }

  // Short name — consult use map for alias resolution
  const uses = fileUseMap.get(source.file_id);
  if (uses) {
    const viaUse = uses.get(normalized);
    if (viaUse) return viaUse;
  }

  // Assume same-namespace resolution as a last resort. This matches PHP's
  // own name resolution rules when no `use` statement shadows it.
  const ns = fileNamespaceMap.get(source.file_id);
  if (ns) return `${ns}\\${normalized}`;
  return normalized;
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

/**
 * Pick a class/interface/trait/enum from candidates. STRICT workspace
 * isolation — never falls back to another workspace, since each Laravel app
 * in a monorepo has its own `App\Models\User`, `App\Http\Controllers\Controller`,
 * etc. Returning an arbitrary match would create ghost edges between
 * independent projects that happen to share a parent directory.
 *
 * When no same-workspace candidate exists, return null and let the caller
 * emit a phantom external symbol instead.
 */
function pickClassLike(
  candidates: PhpSymbol[] | undefined,
  workspace: string | null,
): PhpSymbol | null {
  if (!candidates || candidates.length === 0) return null;
  const classKinds = new Set(['class', 'interface', 'trait', 'enum']);
  const filtered = candidates.filter((c) => classKinds.has(c.kind));
  if (filtered.length === 0) return null;
  const sameWs = filtered.find((c) => c.workspace === workspace);
  if (sameWs) return sameWs;
  // No cross-workspace fallback: different workspaces have independent
  // codebases. If the class isn't in this workspace, it's external.
  return null;
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
  const parentClass = source.parent_id != null ? (symbolById.get(source.parent_id) ?? null) : null;

  switch (cs.type) {
    case 'this':
    case 'self': {
      // Look for method in the containing class (and its ancestors via extends)
      if (!parentClass) return null;
      return findMethodInClassHierarchy(
        cs.callee,
        parentClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
      );
    }

    case 'parent': {
      // Look in the parent class of the containing class
      if (!parentClass || !parentClass.metadata) return null;
      try {
        const parentMeta = JSON.parse(parentClass.metadata) as Record<string, unknown>;
        const ext = parentMeta.extends as string[] | undefined;
        if (!Array.isArray(ext) || ext.length === 0) return null;
        const parentParentClass = resolveClassRef(
          ext[0],
          parentClass,
          fileUseMap,
          fileNamespaceMap,
          byFqn,
          byName,
        );
        if (!parentParentClass) return null;
        return findMethodInClassHierarchy(
          cs.callee,
          parentParentClass,
          byFqn,
          byName,
          symbolsByFile,
          fileUseMap,
          fileNamespaceMap,
        );
      } catch {
        return null;
      }
    }

    case 'static':
    case 'new': {
      if (!cs.classRef) return null;
      const targetClass = resolveClassRef(
        cs.classRef,
        source,
        fileUseMap,
        fileNamespaceMap,
        byFqn,
        byName,
      );
      if (!targetClass) return null;
      if (cs.type === 'new') {
        // Look for __construct; fall back to the class itself
        const ctor = findMethodInClassHierarchy(
          '__construct',
          targetClass,
          byFqn,
          byName,
          symbolsByFile,
          fileUseMap,
          fileNamespaceMap,
        );
        return ctor ?? targetClass;
      }
      // Try to find the method; fall back to the class (e.g., inherited framework
      // methods like Model::find that live in vendor/ — we still record the class ref).
      const method = findMethodInClassHierarchy(
        cs.callee,
        targetClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
      );
      return method ?? targetClass;
    }

    case 'member':
      // Dynamic dispatch — receiver type not tracked yet. Skip.
      return null;

    case 'function': {
      // Top-level function call — resolve by name in same namespace or global.
      // Workspace-aware to avoid cross-project leakage when helper names collide.
      const ns = fileNamespaceMap.get(source.file_id);
      if (ns) {
        const nsHit = pickFunction(byFqn.get(`${ns}\\${cs.callee}`), source.workspace);
        if (nsHit) return nsHit;
      }
      const uses = fileUseMap.get(source.file_id);
      const viaUse = uses?.get(cs.callee);
      if (viaUse) {
        const hit = pickFunction(byFqn.get(viaUse), source.workspace);
        if (hit) return hit;
      }
      // Global function — prefer same-workspace match.
      const global = pickFunction(byFqn.get(cs.callee), source.workspace);
      if (global) return global;
      // Any function with that name in same workspace first.
      const candidates = byName.get(cs.callee)?.filter((s) => s.kind === 'function') ?? [];
      const sameWs = candidates.find((c) => c.workspace === source.workspace);
      return sameWs ?? candidates[0] ?? null;
    }

    case 'this_prop': {
      // $this->prop — find property in containing class or ancestors
      if (!parentClass) return null;
      return findMemberInClassHierarchy(
        cs.callee,
        'property',
        parentClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
      );
    }

    case 'relative_static_prop': {
      // self::$prop — static property in containing class or ancestors
      if (!parentClass) return null;
      return findMemberInClassHierarchy(
        cs.callee,
        'property',
        parentClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
      );
    }

    case 'static_prop': {
      // Class::$prop — static property on a specific class
      if (!cs.classRef) return null;
      const targetClass = resolveClassRef(
        cs.classRef,
        source,
        fileUseMap,
        fileNamespaceMap,
        byFqn,
        byName,
      );
      if (!targetClass) return null;
      return findMemberInClassHierarchy(
        cs.callee,
        'property',
        targetClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
      );
    }

    case 'relative_const': {
      // self::FOO — constant or enum_case in containing class or ancestors
      if (!parentClass) return null;
      return findConstOrEnumCase(
        cs.callee,
        parentClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
      );
    }

    case 'class_const': {
      // Class::FOO — constant or enum case on a specific class/enum
      if (!cs.classRef) return null;
      const targetClass = resolveClassRef(
        cs.classRef,
        source,
        fileUseMap,
        fileNamespaceMap,
        byFqn,
        byName,
      );
      if (!targetClass) return null;
      return findConstOrEnumCase(
        cs.callee,
        targetClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
      );
    }

    case 'member_prop':
      // Dynamic dispatch ($obj->prop) — receiver type not tracked yet.
      return null;

    case 'class_ref': {
      // Class::class magic constant — resolves to the class itself, not a constant.
      if (!cs.classRef) return null;
      return resolveClassRef(cs.classRef, source, fileUseMap, fileNamespaceMap, byFqn, byName);
    }

    case 'this_member_call': {
      // $this->prop->method() — resolve prop type via class hierarchy, then find method on type
      if (!parentClass || !cs.propChain || cs.propChain.length === 0) return null;
      let currentClass: PhpSymbol | null = parentClass;
      for (const propName of cs.propChain) {
        if (!currentClass) return null;
        const prop = findMemberInClassHierarchy(
          propName,
          'property',
          currentClass,
          byFqn,
          byName,
          symbolsByFile,
          fileUseMap,
          fileNamespaceMap,
        );
        if (!prop || !prop.metadata) return null;
        try {
          const propMeta = JSON.parse(prop.metadata) as Record<string, unknown>;
          const typeRef = propMeta.type as string | undefined;
          if (!typeRef) return null;
          const classOwner =
            prop.parent_id != null ? (symbolById.get(prop.parent_id) ?? null) : null;
          currentClass = resolveClassRef(
            typeRef,
            classOwner ?? prop,
            fileUseMap,
            fileNamespaceMap,
            byFqn,
            byName,
          );
        } catch {
          return null;
        }
      }
      if (!currentClass) return null;
      const method = findMethodInClassHierarchy(
        cs.callee,
        currentClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
      );
      return method ?? currentClass;
    }

    case 'param_call': {
      if (!cs.receiver || !source.metadata) return null;
      try {
        const meta = JSON.parse(source.metadata) as Record<string, unknown>;
        const paramTypes = meta.paramTypes as Record<string, string> | undefined;
        if (!paramTypes) return null;
        const typeRef = paramTypes[cs.receiver];
        if (!typeRef) return null;
        const targetClass = resolveClassRef(
          typeRef,
          source,
          fileUseMap,
          fileNamespaceMap,
          byFqn,
          byName,
        );
        if (!targetClass) return null;
        const method = findMethodInClassHierarchy(
          cs.callee,
          targetClass,
          byFqn,
          byName,
          symbolsByFile,
          fileUseMap,
          fileNamespaceMap,
        );
        return method ?? targetClass;
      } catch {
        return null;
      }
    }

    case 'local_call': {
      if (!cs.receiver || !source.metadata) return null;
      try {
        const meta = JSON.parse(source.metadata) as Record<string, unknown>;
        const localTypes = meta.localTypes as Record<string, string> | undefined;
        if (!localTypes) return null;
        const typeRef = localTypes[cs.receiver];
        if (!typeRef) return null;
        const targetClass = resolveClassRef(
          typeRef,
          source,
          fileUseMap,
          fileNamespaceMap,
          byFqn,
          byName,
        );
        if (!targetClass) return null;
        const method = findMethodInClassHierarchy(
          cs.callee,
          targetClass,
          byFqn,
          byName,
          symbolsByFile,
          fileUseMap,
          fileNamespaceMap,
        );
        return method ?? targetClass;
      } catch {
        return null;
      }
    }
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
  const direct = fileSymbols.find(
    (s) => s.kind === memberKind && s.name === memberName && s.parent_id === classSymbol.id,
  );
  if (direct) return direct;

  if (!classSymbol.metadata) return null;
  try {
    const meta = JSON.parse(classSymbol.metadata) as Record<string, unknown>;
    const parents: string[] = [];
    if (Array.isArray(meta.extends)) parents.push(...(meta.extends as string[]));
    if (Array.isArray(meta.usesTraits)) parents.push(...(meta.usesTraits as string[]));

    for (const ref of parents) {
      const parentClass = resolveClassRef(
        ref,
        classSymbol,
        fileUseMap,
        fileNamespaceMap,
        byFqn,
        byName,
      );
      if (!parentClass) continue;
      const found = findMemberInClassHierarchy(
        memberName,
        memberKind,
        parentClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
        visited,
      );
      if (found) return found;
    }
  } catch {
    /* ignore */
  }

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
    const enumCase = fileSymbols.find(
      (s) => s.kind === 'enum_case' && s.name === memberName && s.parent_id === classSymbol.id,
    );
    if (enumCase) return enumCase;
  }

  // Regular class constant
  const constant = fileSymbols.find(
    (s) => s.kind === 'constant' && s.name === memberName && s.parent_id === classSymbol.id,
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
      const parentClass = resolveClassRef(
        ref,
        classSymbol,
        fileUseMap,
        fileNamespaceMap,
        byFqn,
        byName,
      );
      if (!parentClass) continue;
      const found = findConstOrEnumCase(
        memberName,
        parentClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
        visited,
      );
      if (found) return found;
    }
  } catch {
    /* ignore */
  }

  return null;
}

function pickFunction(
  candidates: PhpSymbol[] | undefined,
  preferWorkspace: string | null = null,
): PhpSymbol | null {
  if (!candidates) return null;
  const fns = candidates.filter((c) => c.kind === 'function');
  if (fns.length === 0) return null;
  // Prefer same-workspace function to avoid cross-project leakage when a
  // helper name (like hasDatabaseConnection) exists in multiple projects.
  if (preferWorkspace !== null) {
    const sameWs = fns.find((c) => c.workspace === preferWorkspace);
    if (sameWs) return sameWs;
  }
  return fns[0];
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
  const direct = fileSymbols.find(
    (s) => s.kind === 'method' && s.name === methodName && s.parent_id === classSymbol.id,
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
      const parentClass = resolveClassRef(
        ref,
        classSymbol,
        fileUseMap,
        fileNamespaceMap,
        byFqn,
        byName,
      );
      if (!parentClass) continue;
      const found = findMethodInClassHierarchy(
        methodName,
        parentClass,
        byFqn,
        byName,
        symbolsByFile,
        fileUseMap,
        fileNamespaceMap,
        visited,
      );
      if (found) return found;
    }
  } catch {
    /* ignore */
  }

  return null;
}

/**
 * Build per-file map: file_id → Map<shortName, FQN>
 * Reads from php_imports edges stored in pendingImports state.
 */
function buildFileUseMap(state: PipelineState): Map<number, Map<string, string>> {
  const result = new Map<number, Map<string, string>>();

  // Query from file-level import edges already resolved
  const rows = state.store.db
    .prepare(`
    SELECT n_src.ref_id as source_file_id, e.metadata
    FROM edges e
    JOIN edge_types et ON e.edge_type_id = et.id
    JOIN nodes n_src ON e.source_node_id = n_src.id
    JOIN files f ON n_src.ref_id = f.id AND n_src.node_type = 'file'
    WHERE et.name = 'imports' AND f.language = 'php' AND e.metadata IS NOT NULL
  `)
    .all() as Array<{ source_file_id: number; metadata: string | null }>;

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
    } catch {
      /* ignore */
    }
  }

  return result;
}
