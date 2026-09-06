/**
 * Resolve C# `using` directive edges to the file declaring the specific type
 * a directive names (TRA-1027 — next after Ruby in the C#/Kotlin/Swift/
 * Elixir/Lua backlog `import-capable-languages.ts` names as "extract but
 * nothing consumes").
 *
 * A plain `using Acme.Store;` is deliberately left unresolved — it does not
 * mean the importing file depends on every file that happens to declare
 * `namespace Acme.Store`, it only makes unqualified names from that
 * namespace available. Two rounds of review rejected file-edges for this
 * form, for two separate reasons that both hold regardless of how many files
 * declare the namespace:
 *
 * - **Volume:** a real repo (Newtonsoft.Json) averaged 86 resolved edges per
 *   importing file when this was tried, because C# namespaces routinely span
 *   most of a codebase — nothing like Java's `import a.b.*`, where a
 *   directory-scoped package keeps the fan-out small and wildcard imports are
 *   rare in idiomatic code to begin with.
 * - **Even the single-declarer case is unsound incrementally:** resolving to
 *   the one file when a namespace has exactly one declarer looked safe in
 *   isolation, but review found it depends on the rest of the codebase in a
 *   way the incremental resolver can't track — adding a second file to that
 *   namespace elsewhere leaves the old "unique" edge stale (nothing re-checks
 *   an unrelated, unchanged file just because some other file made its
 *   namespace ambiguous), and the reverse transition never creates the edge
 *   at all without a full reindex either. The edge's existence would depend
 *   on file-count trivia elsewhere in the repo, not on anything the
 *   `using` directive itself said.
 *
 * Resolution instead only trusts forms that name a **specific type**, via the
 * `class`/`interface`/`enum`/`type` symbols the plugin already extracts, each
 * with `fqn` set to its dotted path:
 *
 *     using Acme.Store;             // → unresolved (see above)
 *     using static Acme.Store.Ids;  // → the file(s) declaring type `Acme.Store.Ids`
 *     using Alias = Acme.Store.Db;  // → the file(s) declaring type `Acme.Store.Db`
 *
 * A type FQN can legitimately map to more than one file for a `partial`
 * type — every piece is a real declaring file for it, unlike an unrelated
 * namespace fan-out, so all of them stay targets. A miss on an exact type
 * FQN falls back to trimming the last segment, recovering a nested type's
 * enclosing type (`using static Acme.Store.Outer.Inner;`). A specifier
 * matching no type (BCL, NuGet package, or a plain namespace) simply fails to
 * resolve rather than inventing a node.
 *
 * One file→file edge can be the collapsed target of more than one `using`
 * (two `using static` directives from the same importer naming two types in
 * the same file). `metadata.froms` holds the full set, not the single latest
 * specifier — review caught an earlier version that stored just one, so a
 * second specifier's revalidation silently clobbered the first's, losing the
 * edge for a type that was still validly imported. Every write here merges
 * into that set rather than replacing it wholesale.
 *
 * Incremental reindexing: a C# file's declared type identity is ordinary
 * file content, not derived from its path, so it can change (renamed, moved
 * to another file, removed) without the file moving — unlike Java/Go, where
 * the resolver never even reads the `package` statement. If only the
 * declaring file(s) get reindexed, files that import them are untouched this
 * batch and never get a chance to notice their edge is now wrong. This
 * resolver closes that gap for the files that DO get reindexed here: for
 * every C# file in `state.changedFileIds` — deliberately wider than
 * `pendingImports`, which only has an entry for a file that itself has
 * `using` directives, and a type-declaring file need not have any — each
 * incoming `imports` edge is split specifier-by-specifier against the fresh
 * type map: a specifier still resolving to this file is kept, one that
 * doesn't is relinked using the edge's own source node — the edge itself is
 * enough to notice a type moved and follow it, with no need to re-extract
 * the importer.
 *
 * Two cases still don't converge without a full reindex, and are not
 * silently "mostly working" — they simply don't happen here:
 *
 * - A specifier that was unresolved (external) when the importer was last
 *   extracted never got an edge, so there is nothing to notice if the type
 *   it names shows up later in some file that ISN'T the importer.
 * - A file *delete followed by a separate create* — the shape a real watcher
 *   uses for a rename/move, via `deleteFiles` then `indexFiles` as two
 *   distinct calls — destroys the old file's node (and every edge touching
 *   it, cascaded) before the new file's `indexFiles` call ever runs. By the
 *   time this resolver sees the create, the edge this pass depends on to
 *   relink is already gone; there is nothing left to read a source node or a
 *   specifier off of. Recovering this needs raw import facts to survive
 *   independently of the resolved edge (a durable store keyed by specifier,
 *   not by edge id) — real persistence work, and a decision about who owns
 *   it, deliberately left to a follow-up rather than bolted on here.
 *
 * A full reindex already recomputes every C# file's imports from scratch and
 * is unaffected by either limitation.
 */
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

function addTo(map: Map<string, number[]>, key: string, id: number): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(id)) list.push(id);
  } else {
    map.set(key, [id]);
  }
}

/** A desired (source, target) edge and every specifier that collapses onto it. */
interface DesiredEdge {
  sourceNodeId: number;
  targetNodeId: number;
  froms: Set<string>;
}

export function resolveCSharpImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.changedFileIds` — wider than `state.pendingImports`,
  // which only has an entry for a file that itself has `using` directives. A
  // file that only DECLARES a type (no imports of its own) still needs to be
  // in the revalidation loop below when its declaration changes.
  void _scope;
  const { store } = state;
  if (state.changedFileIds.size === 0) return;

  const changedFileIds = Array.from(state.changedFileIds);
  const fileMap = store.getFilesByIds(changedFileIds);
  const hasCSharp = changedFileIds.some((id) => fileMap.get(id)?.language === 'csharp');
  if (!hasCSharp) return;

  // Type FQN → the file(s) declaring that class/struct/record/interface/enum/delegate.
  const byType = new Map<string, number[]>();
  const rows = store.db
    .prepare(
      `SELECT s.file_id AS fileId, s.fqn AS fqn
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.language = 'csharp' AND s.fqn IS NOT NULL
         AND s.kind IN ('class', 'interface', 'enum', 'type')`,
    )
    .all() as Array<{ fileId: number; fqn: string }>;
  for (const { fileId, fqn } of rows) {
    addTo(byType, fqn, fileId);
  }
  // No early return on an empty `byType`: the last C# type in the whole
  // index can be deleted/renamed in this very batch, and an empty map is
  // exactly what should make `resolve()` treat every specifier as external —
  // skipping the revalidation pass below would instead leave a now-wrong
  // incoming edge on the file that just lost its only type.

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const nodeIds = new Map<number, number>();
  const allTargetFileIds = Array.from(byType.values()).flat().concat(changedFileIds);
  const CHUNK = 500;
  for (let i = 0; i < allTargetFileIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('file', allTargetFileIds.slice(i, i + CHUNK))) {
      nodeIds.set(k, v);
    }
  }

  const insertStmt = store.db.prepare(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, ?, 0)
     ON CONFLICT(source_node_id, target_node_id, edge_type_id)
     DO UPDATE SET metadata = excluded.metadata`,
  );
  const deleteStmt = store.db.prepare('DELETE FROM edges WHERE id = ?');

  /**
   * `using static Acme.Store.Ids` and aliased `using X = Acme.Store.Ids`
   * name a type directly. A miss trims the last segment to recover a nested
   * type's enclosing type. A plain namespace import never matches here — see
   * the file header for why that's deliberate, not a gap.
   */
  const resolve = (specifier: string): number[] => {
    const type = byType.get(specifier);
    if (type) return type;
    const cut = specifier.lastIndexOf('.');
    return (cut > 0 && byType.get(specifier.slice(0, cut))) || [];
  };

  const desired = new Map<string, DesiredEdge>();
  const addDesired = (sourceNodeId: number, targetNodeId: number, from: string): void => {
    if (sourceNodeId === targetNodeId) return;
    const key = `${sourceNodeId}:${targetNodeId}`;
    let entry = desired.get(key);
    if (!entry) {
      entry = { sourceNodeId, targetNodeId, froms: new Set() };
      desired.set(key, entry);
    }
    entry.froms.add(from);
  };

  let external = 0;
  let pruned = 0;

  store.db.transaction(() => {
    // A file's declared type identity is content, not path — it can change
    // without the file moving, and unlike the source-driven pass below,
    // importers that weren't re-extracted this batch never revisit it.
    // Re-validate every C# file's *incoming* `imports` edges here,
    // specifier by specifier: one still resolving here is kept, one that
    // doesn't is relinked using the edge's own source node — see file
    // header for what this does and doesn't converge without a full reindex.
    for (const fileId of changedFileIds) {
      if (fileMap.get(fileId)?.language !== 'csharp') continue;
      const targetNodeId = nodeIds.get(fileId);
      if (targetNodeId == null) continue;
      for (const edge of store.getIncomingEdges(targetNodeId)) {
        if (edge.edge_type_name !== 'imports' || !edge.metadata) continue;
        let froms: string[];
        try {
          const parsed = JSON.parse(edge.metadata) as { froms?: string[]; from?: string };
          froms = parsed.froms ?? (parsed.from ? [parsed.from] : []);
        } catch {
          continue;
        }
        if (froms.length === 0) continue;

        let changed = false;
        for (const from of froms) {
          const freshTargets = resolve(from);
          if (freshTargets.includes(fileId)) {
            addDesired(edge.source_node_id, targetNodeId, from);
            continue;
          }
          changed = true;
          for (const newTargetId of freshTargets) {
            const newTargetNodeId = nodeIds.get(newTargetId);
            if (newTargetNodeId == null) continue;
            addDesired(edge.source_node_id, newTargetNodeId, from);
          }
        }
        if (changed) {
          deleteStmt.run(edge.id);
          pruned++;
        }
      }
    }

    // A file whose own extraction changed carries its complete, current
    // specifier list — authoritative for every edge it's the source of.
    for (const [fileId, imports] of state.pendingImports) {
      if (fileMap.get(fileId)?.language !== 'csharp') continue;
      const sourceNodeId = nodeIds.get(fileId);
      if (sourceNodeId == null) continue;

      const seen = new Set<string>();
      for (const { from } of imports) {
        if (!from || seen.has(from)) continue;
        seen.add(from);

        const targets = resolve(from);
        if (targets.length === 0) {
          external++;
          continue;
        }
        for (const targetId of targets) {
          const targetNodeId = nodeIds.get(targetId);
          if (targetNodeId == null) continue;
          addDesired(sourceNodeId, targetNodeId, from);
        }
      }
    }

    for (const { sourceNodeId, targetNodeId, froms } of desired.values()) {
      insertStmt.run(
        sourceNodeId,
        targetNodeId,
        importsEdgeType.id,
        JSON.stringify({ froms: Array.from(froms).sort() }),
      );
    }
  })();

  if (desired.size > 0 || external > 0 || pruned > 0) {
    logger.info({ edges: desired.size, external, pruned }, 'C# import edges resolved');
  }
}
