/**
 * TRA-1780 — pipeline-level removal purge for file-anchored electron
 * cross-file edges.
 *
 * The problem (review finding on PR #1313): a cross-file IPC edge is
 * anchored in the file that still contains its construct. Removing the
 * counterpart — the `ipcMain.handle` while the renderer still invokes, or
 * the `ipcRenderer.on` while the pusher still sends — leaves the edge with
 * its source in an UNCHANGED file, so:
 *   1. incremental persist deletes outgoing edges of changed files only;
 *   2. the fast symbol path skips edge deletion entirely when the removal
 *      leaves the symbol table structurally identical (top-level
 *      `ipcMain.handle` / `ipcRenderer.on` calls own no symbol).
 * The stale edge survives scoped runs and, via the same fast path,
 * `indexAll(true)` alike.
 *
 * Design (verification-based tombstones, no on-disk change): instead of
 * persisting tombstone rows (which would need a schema migration), this
 * pass re-derives ground truth from the same inputs the full scan uses —
 * current file contents through the plugin's own `scanChannelRoles`, in the
 * same `getAllFiles()` order with the same last-wins pick — and deletes
 * every cross-file edge whose precondition no longer holds:
 *   - invoke/send edge: source file must still invoke/send the channel AND
 *     the target must still be the picked handler/listener;
 *   - push edge: source file must still push the channel, the target
 *     renderer must still listen to it, AND the source must still be the
 *     picked pusher.
 * When the precondition fails only because the pick moved (a second
 * provider took over the channel), the replacement edge is re-emitted
 * through the plugin's own emitters, so the result is row-identical to a
 * full scan. No MCP tool contract and no on-disk schema changes: this pass
 * only deletes rows and inserts rows the full scan would insert.
 *
 * Scope: with a ChangeScope, only edges touching a changed file (either
 * side) plus edges for channels a changed file newly provides (winner
 * takeover without touching the old edge's endpoints) are verified.
 * Without a scope (forced/verification full pass) every electron cross-file
 * edge is verified. Runs with no electron edges exit after one indexed
 * SELECT; zero-change runs never reach here (resolveAllEdges short-circuits
 * before the resolver stages).
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../logger.js';
import type { ChangeScope, RawEdge } from '../../plugin-api/types.js';
import type { FileSymbol } from '../plugins/integration/_shared/regex-edges.js';
import {
  emitInvokeToHandler,
  emitPushToRenderer,
  emitSendToListener,
  scanChannelRoles,
  type FileChannelRoles,
} from '../plugins/integration/tooling/electron/index.js';
import type { PipelineState } from '../pipeline-state.js';

type CrossFileKind = 'electron_ipc_invoke' | 'electron_ipc_send' | 'electron_webcontents_send';

const CROSS_FILE_TYPES: readonly CrossFileKind[] = [
  'electron_ipc_invoke',
  'electron_ipc_send',
  'electron_webcontents_send',
];

/** Virtual (self-loop, text-matched) edge types per provider/source role. */
const VIRTUAL_TYPES = [
  'electron_ipc_handle',
  'electron_ipc_main_on',
  'electron_webcontents_send',
  'electron_ipc_invoke',
  'electron_ipc_send',
  'electron_ipc_on',
] as const;

interface CrossFileEdge {
  id: number;
  edgeType: CrossFileKind;
  channel: string;
  srcFile: string;
  tgtFile: string;
}

interface FileEntry {
  id: number;
  path: string;
  language: string | null;
}

interface FileView {
  entry: FileEntry;
  source: string;
  roles: FileChannelRoles;
  symbols: FileSymbol[];
}

function emptyRoles(): FileChannelRoles {
  return { handles: [], listens: [], pushes: [], invokes: [], sends: [], ons: [] };
}

export interface ElectronPurgeResult {
  /** Stale cross-file edges deleted. */
  purged: number;
  /** Replacement edges emitted for moved picks. */
  replaced: number;
}

/**
 * Delete stale electron cross-file edges for `state`/`scope`, emitting
 * replacements through `storeEdges` when the channel pick moved to another
 * live provider. See the module header for the full design.
 */
export function purgeStaleElectronEdges(
  state: PipelineState,
  scope: ChangeScope | undefined,
  storeEdges: (edges: RawEdge[]) => void,
): ElectronPurgeResult {
  const nothing: ElectronPurgeResult = { purged: 0, replaced: 0 };
  const candidates = loadCrossFileEdges(state);
  if (candidates.length === 0) return nothing;

  const views = new Map<string, FileView | null>();
  const viewOf = (relPath: string): FileView | null => {
    let v = views.get(relPath);
    if (v !== undefined) return v;
    v = loadFileView(state, relPath);
    views.set(relPath, v);
    return v;
  };

  let relevant: CrossFileEdge[];
  if (scope === undefined) {
    relevant = candidates;
  } else {
    const changedPaths = new Set<string>();
    if (scope.changedFileIds.size > 0) {
      for (const row of state.store.getFilesByIds(Array.from(scope.changedFileIds)).values()) {
        changedPaths.add(row.path);
      }
    }
    // Channels a changed file newly provides: a winner takeover re-targets
    // edges whose NEITHER endpoint changed (old winner + renderer both
    // untouched), so endpoint filtering alone would miss them.
    const provided = new Set<string>();
    for (const p of changedPaths) {
      const v = viewOf(p);
      if (!v) continue;
      for (const c of v.roles.handles) provided.add(`handle:${c}`);
      for (const c of v.roles.listens) provided.add(`listen:${c}`);
      for (const c of v.roles.pushes) provided.add(`push:${c}`);
    }
    relevant = candidates.filter(
      (e) =>
        changedPaths.has(e.srcFile) ||
        changedPaths.has(e.tgtFile) ||
        provided.has(providerKey(e.edgeType, e.channel)),
    );
    if (relevant.length === 0) return nothing;
  }

  // Provider supersets per kind: files owning a virtual edge of that kind
  // (a file providing ANY channel of the kind owns such a row — the row is
  // per (source node, edge type), so the channel in its metadata is NOT a
  // reliable per-channel index; exact roles come from the content scan).
  const kindFiles = loadKindFiles(state);
  const order = new Map<string, number>();
  state.store.getAllFiles().forEach((f, i) => order.set(f.path, i));

  const pickCache = new Map<string, { fileId: number; path: string } | undefined>();
  const pick = (kind: 'handle' | 'listen' | 'push', channel: string) => {
    const key = `${kind}:${channel}`;
    let out = pickCache.get(key);
    if (out !== undefined) return out;
    const pool = kindFiles.get(kind) ?? new Set<string>();
    let best: { fileId: number; path: string } | undefined;
    let bestIdx = -1;
    for (const p of pool) {
      const v = viewOf(p);
      if (!v) continue;
      const roles =
        kind === 'handle' ? v.roles.handles : kind === 'listen' ? v.roles.listens : v.roles.pushes;
      if (!roles.includes(channel)) continue;
      const idx = order.get(p) ?? -1;
      if (idx >= bestIdx) {
        best = { fileId: v.entry.id, path: p };
        bestIdx = idx;
      }
    }
    pickCache.set(key, best);
    return best;
  };

  const staleIds: number[] = [];
  const replacements: RawEdge[] = [];

  for (const e of relevant) {
    const srcView = viewOf(e.srcFile);
    const tgtView = viewOf(e.tgtFile);
    const srcRoles = srcView?.roles ?? emptyRoles();
    const tgtRoles = tgtView?.roles ?? emptyRoles();

    if (e.edgeType === 'electron_ipc_invoke' || e.edgeType === 'electron_ipc_send') {
      const sourceKind = e.edgeType === 'electron_ipc_invoke' ? 'invoke' : 'send';
      const pickKind = e.edgeType === 'electron_ipc_invoke' ? 'handle' : 'listen';
      const srcHas = (sourceKind === 'invoke' ? srcRoles.invokes : srcRoles.sends).includes(
        e.channel,
      );
      const winner = pick(pickKind, e.channel);
      if (srcHas && winner?.path === e.tgtFile) continue;
      staleIds.push(e.id);
      if (srcHas && winner && srcView) {
        const before = replacements.length;
        if (e.edgeType === 'electron_ipc_invoke') {
          emitInvokeToHandler(
            { id: srcView.entry.id, path: srcView.entry.path, language: 'typescript' },
            srcView.source,
            srcView.symbols,
            e.channel,
            winner,
            replacements,
          );
        } else {
          emitSendToListener(
            { id: srcView.entry.id, path: srcView.entry.path, language: 'typescript' },
            srcView.source,
            srcView.symbols,
            e.channel,
            winner,
            replacements,
          );
        }
        if (replacements.length === before) {
          logger.debug(
            { channel: e.channel, src: e.srcFile },
            'electron purge: winner exists but source has no match to re-anchor',
          );
        }
      }
    } else {
      // electron_webcontents_send: source is the pusher, target the renderer.
      const srcPushes = srcRoles.pushes.includes(e.channel);
      const tgtListens = tgtRoles.ons.includes(e.channel);
      const winner = pick('push', e.channel);
      if (srcPushes && tgtListens && winner?.path === e.srcFile) continue;
      staleIds.push(e.id);
      if (tgtListens && winner && tgtView) {
        const pusherView = viewOf(winner.path);
        if (pusherView) {
          emitPushToRenderer(
            { id: pusherView.entry.id, path: pusherView.entry.path, language: 'typescript' },
            pusherView.source,
            pusherView.symbols,
            { id: tgtView.entry.id, path: tgtView.entry.path, language: 'typescript' },
            e.channel,
            replacements,
          );
        }
      }
    }
  }

  if (staleIds.length === 0) return nothing;
  deleteEdgesById(state, staleIds);
  if (replacements.length > 0) storeEdges(replacements);
  return { purged: staleIds.length, replaced: replacements.length };
}

/** providerKey maps a cross-file edge type to the provider role key of its channel. */
function providerKey(edgeType: CrossFileKind, channel: string): string {
  if (edgeType === 'electron_ipc_invoke') return `handle:${channel}`;
  if (edgeType === 'electron_ipc_send') return `listen:${channel}`;
  return `push:${channel}`;
}

/** Load every electron cross-file edge (both modes verify a subset of these). */
function loadCrossFileEdges(state: PipelineState): CrossFileEdge[] {
  const placeholders = CROSS_FILE_TYPES.map(() => '?').join(',');
  const rows = state.store.db
    .prepare(
      `SELECT e.id, et.name AS edge_type, e.metadata
       FROM edges e JOIN edge_types et ON et.id = e.edge_type_id
       WHERE et.name IN (${placeholders})`,
    )
    .all(...CROSS_FILE_TYPES) as Array<{
    id: number;
    edge_type: string;
    metadata: string | null;
  }>;
  const out: CrossFileEdge[] = [];
  for (const r of rows) {
    if (!r.metadata) continue;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(r.metadata) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      m.resolution !== 'cross_file' ||
      typeof m.channel !== 'string' ||
      typeof m.file !== 'string' ||
      typeof m.targetFile !== 'string'
    ) {
      continue;
    }
    out.push({
      id: r.id,
      edgeType: r.edge_type as CrossFileKind,
      channel: m.channel,
      srcFile: m.file,
      tgtFile: m.targetFile,
    });
  }
  return out;
}

/**
 * Distinct files owning a virtual edge of each provider kind. The channel
 * inside a virtual row's metadata is first-insert-wins (rows dedup by
 * source node + edge type), so this is only a scan superset — exact
 * per-channel roles always come from `scanChannelRoles` on content.
 */
function loadKindFiles(state: PipelineState): Map<'handle' | 'listen' | 'push', Set<string>> {
  const out = new Map<'handle' | 'listen' | 'push', Set<string>>([
    ['handle', new Set()],
    ['listen', new Set()],
    ['push', new Set()],
  ]);
  const byType = new Map<string, 'handle' | 'listen' | 'push'>([
    ['electron_ipc_handle', 'handle'],
    ['electron_ipc_main_on', 'listen'],
    ['electron_webcontents_send', 'push'],
  ]);
  const placeholders = VIRTUAL_TYPES.map(() => '?').join(',');
  const rows = state.store.db
    .prepare(
      `SELECT et.name AS edge_type, e.metadata
       FROM edges e JOIN edge_types et ON et.id = e.edge_type_id
       WHERE et.name IN (${placeholders})`,
    )
    .all(...VIRTUAL_TYPES) as Array<{ edge_type: string; metadata: string | null }>;
  for (const r of rows) {
    const kind = byType.get(r.edge_type);
    if (!kind || !r.metadata) continue;
    try {
      const m = JSON.parse(r.metadata) as Record<string, unknown>;
      if (typeof m.file === 'string') out.get(kind)!.add(m.file);
    } catch {
      continue;
    }
  }
  return out;
}

/** Current content + roles + symbols for one indexed file (null when unavailable). */
function loadFileView(state: PipelineState, relPath: string): FileView | null {
  const row = state.store.getFile(relPath);
  if (!row) return null;
  if (row.language !== 'typescript' && row.language !== 'javascript') return null;
  let source: string;
  try {
    source = fs.readFileSync(path.resolve(state.rootPath, relPath), 'utf-8');
  } catch {
    return null;
  }
  const entry: FileEntry = { id: row.id, path: row.path, language: row.language };
  const symbols: FileSymbol[] = state.store.getSymbolsByFile(row.id).map((s) => ({
    id: s.id,
    symbolId: s.symbol_id,
    name: s.name,
    kind: s.kind,
    lineStart: s.line_start,
    lineEnd: s.line_end,
  }));
  return { entry, source, roles: scanChannelRoles(source), symbols };
}

function deleteEdgesById(state: PipelineState, ids: number[]): void {
  const CHUNK = 900;
  const stmt = (ph: string) => `DELETE FROM edges WHERE id IN (${ph})`;
  state.store.db.transaction(() => {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      state.store.db.prepare(stmt(chunk.map(() => '?').join(','))).run(...chunk);
    }
  })();
  if (ids.length > 0) {
    logger.info({ purged: ids.length }, 'Purged stale electron cross-file edges (TRA-1780)');
  }
}
