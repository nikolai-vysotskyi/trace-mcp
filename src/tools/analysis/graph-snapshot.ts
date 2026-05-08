/**
 * Graph snapshot + diff over time.
 *
 * CRG v2.3.2 added a graph-diff tool — compare two snapshots, surface
 * new/removed nodes/edges and community changes. Our compare_branches
 * does git-diff-driven symbol comparison; what's missing is a way to
 * track *graph evolution* over time without git as the axis. Useful
 * questions this answers:
 *
 *   - Did our last refactor reduce circular imports? Compare cycle count.
 *   - Is the public surface stable? Compare exported-symbol count.
 *   - Did community structure shift? Compare top community labels.
 *   - Are we accruing dead code? Compare exported-but-unimported count.
 *
 * Storage is a single `named_graph_snapshots` table, one row per named
 * snapshot, with a JSON `summary` blob so adding new metrics later
 * doesn't require another migration.
 */
import type Database from 'better-sqlite3';
import type { Store } from '../../db/store.js';

export interface SnapshotSummary {
  /** Counts that move slowly. */
  files: number;
  symbols: number;
  /** Symbols partitioned by kind — class/function/method/etc. */
  symbols_by_kind: Record<string, number>;
  /** Edges partitioned by edge_type. */
  edges_by_type: Record<string, number>;
  /** Files with the highest in-degree (rough PageRank proxy without recompute). */
  top_files: Array<{ file: string; in_degree: number }>;
  /** Communities, if previously detected. Empty array otherwise. */
  communities: Array<{ id: number; label: string; file_count: number }>;
  /** Total exported symbols (post-method exclusion). */
  exported_symbols: number;
}

export interface SnapshotRow {
  id: number;
  name: string;
  captured_at: string;
  summary: SnapshotSummary;
}

export interface SnapshotDiff {
  base: { name: string; captured_at: string };
  head: { name: string; captured_at: string };
  files: { added: number; removed: number; net: number };
  symbols: { added: number; removed: number; net: number };
  symbols_by_kind: Record<string, { base: number; head: number; delta: number }>;
  edges_by_type: Record<string, { base: number; head: number; delta: number }>;
  exported_symbols: { base: number; head: number; delta: number };
  communities: {
    added: string[];
    removed: string[];
  };
  top_files: {
    rose: Array<{ file: string; from: number; to: number }>;
    fell: Array<{ file: string; from: number; to: number }>;
  };
}

/** Idempotent — the table is created lazily so we don't need a schema migration. */
function ensureTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS named_graph_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      captured_at TEXT NOT NULL,
      summary     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_named_graph_snapshots_name ON named_graph_snapshots(name);
  `);
}

// ── Capture ──────────────────────────────────────────────────────────────

interface CountRow {
  k: string;
  cnt: number;
}

interface InDegreeRow {
  file: string;
  in_degree: number;
}

interface CommunityRow {
  id: number;
  label: string;
  file_count: number;
}

export function captureSnapshot(store: Store, name: string): SnapshotRow {
  ensureTable(store.db);

  const stats = store.getStats();
  const symKindRows = store.db
    .prepare('SELECT kind AS k, COUNT(*) AS cnt FROM symbols GROUP BY kind')
    .all() as CountRow[];
  const edgeTypeRows = store.db
    .prepare(`
    SELECT et.name AS k, COUNT(*) AS cnt
    FROM edges e
    JOIN edge_types et ON e.edge_type_id = et.id
    GROUP BY et.name
  `)
    .all() as CountRow[];

  // In-degree top files — cheaper than running PageRank inline.
  const topRows = store.db
    .prepare(`
    SELECT f.path AS file, COUNT(*) AS in_degree
    FROM edges e
    JOIN nodes n ON n.id = e.target_node_id
    LEFT JOIN files f ON n.node_type = 'file' AND n.ref_id = f.id
    LEFT JOIN symbols s ON n.node_type = 'symbol' AND n.ref_id = s.id
    LEFT JOIN files sf ON s.file_id = sf.id
    WHERE COALESCE(f.path, sf.path) IS NOT NULL
    GROUP BY COALESCE(f.path, sf.path)
    ORDER BY in_degree DESC
    LIMIT 20
  `)
    .all() as InDegreeRow[];

  // Communities — empty list when never detected.
  let communities: Array<{ id: number; label: string; file_count: number }> = [];
  try {
    communities = store.db
      .prepare('SELECT id, label, file_count FROM communities ORDER BY file_count DESC LIMIT 30')
      .all() as CommunityRow[];
  } catch {
    /* communities table absent — leave empty */
  }

  const exportedRow = store.db
    .prepare(`
    SELECT COUNT(*) AS cnt
    FROM symbols
    WHERE json_extract(metadata, '$.exported') = 1
      AND kind != 'method'
  `)
    .get() as { cnt: number };

  const summary: SnapshotSummary = {
    files: stats.totalFiles,
    symbols: stats.totalSymbols,
    symbols_by_kind: Object.fromEntries(symKindRows.map((r) => [r.k, r.cnt])),
    edges_by_type: Object.fromEntries(edgeTypeRows.map((r) => [r.k, r.cnt])),
    top_files: topRows,
    communities,
    exported_symbols: exportedRow.cnt,
  };

  const capturedAt = new Date().toISOString();
  store.db
    .prepare(`
    INSERT OR REPLACE INTO named_graph_snapshots (name, captured_at, summary)
    VALUES (?, ?, ?)
  `)
    .run(name, capturedAt, JSON.stringify(summary));

  const row = store.db.prepare('SELECT id FROM named_graph_snapshots WHERE name = ?').get(name) as {
    id: number;
  };
  return { id: row.id, name, captured_at: capturedAt, summary };
}

// ── Listing ──────────────────────────────────────────────────────────────

export function listSnapshots(store: Store): SnapshotRow[] {
  ensureTable(store.db);
  const rows = store.db
    .prepare(
      'SELECT id, name, captured_at, summary FROM named_graph_snapshots ORDER BY captured_at DESC',
    )
    .all() as Array<{ id: number; name: string; captured_at: string; summary: string }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    captured_at: r.captured_at,
    summary: JSON.parse(r.summary) as SnapshotSummary,
  }));
}

export function deleteSnapshot(store: Store, name: string): boolean {
  ensureTable(store.db);
  const r = store.db.prepare('DELETE FROM named_graph_snapshots WHERE name = ?').run(name);
  return r.changes > 0;
}

// ── Diff ─────────────────────────────────────────────────────────────────

function loadSnapshot(store: Store, name: string): SnapshotRow | null {
  ensureTable(store.db);
  const row = store.db
    .prepare('SELECT id, name, captured_at, summary FROM named_graph_snapshots WHERE name = ?')
    .get(name) as { id: number; name: string; captured_at: string; summary: string } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    captured_at: row.captured_at,
    summary: JSON.parse(row.summary) as SnapshotSummary,
  };
}

export function diffSnapshots(
  store: Store,
  baseName: string,
  headName: string,
): SnapshotDiff | null {
  const base = loadSnapshot(store, baseName);
  const head = loadSnapshot(store, headName);
  if (!base || !head) return null;

  const filesNet = head.summary.files - base.summary.files;
  const symbolsNet = head.summary.symbols - base.summary.symbols;

  // For "added" / "removed" we don't track per-file diffs in summary, so
  // approximate: positive net contributes to added, negative to removed.
  // Real per-file diffing would require storing the full file list, which
  // we deliberately don't to keep snapshots cheap.
  const filesAdded = filesNet > 0 ? filesNet : 0;
  const filesRemoved = filesNet < 0 ? -filesNet : 0;
  const symbolsAdded = symbolsNet > 0 ? symbolsNet : 0;
  const symbolsRemoved = symbolsNet < 0 ? -symbolsNet : 0;

  const symbols_by_kind: SnapshotDiff['symbols_by_kind'] = {};
  const allKinds = new Set([
    ...Object.keys(base.summary.symbols_by_kind),
    ...Object.keys(head.summary.symbols_by_kind),
  ]);
  for (const k of allKinds) {
    const b = base.summary.symbols_by_kind[k] ?? 0;
    const h = head.summary.symbols_by_kind[k] ?? 0;
    symbols_by_kind[k] = { base: b, head: h, delta: h - b };
  }

  const edges_by_type: SnapshotDiff['edges_by_type'] = {};
  const allTypes = new Set([
    ...Object.keys(base.summary.edges_by_type),
    ...Object.keys(head.summary.edges_by_type),
  ]);
  for (const t of allTypes) {
    const b = base.summary.edges_by_type[t] ?? 0;
    const h = head.summary.edges_by_type[t] ?? 0;
    edges_by_type[t] = { base: b, head: h, delta: h - b };
  }

  const baseCommunities = new Set(base.summary.communities.map((c) => c.label));
  const headCommunities = new Set(head.summary.communities.map((c) => c.label));
  const addedCommunities = [...headCommunities].filter((l) => !baseCommunities.has(l));
  const removedCommunities = [...baseCommunities].filter((l) => !headCommunities.has(l));

  const baseFileMap = new Map(base.summary.top_files.map((f) => [f.file, f.in_degree]));
  const headFileMap = new Map(head.summary.top_files.map((f) => [f.file, f.in_degree]));
  const allFiles = new Set([...baseFileMap.keys(), ...headFileMap.keys()]);
  const rose: Array<{ file: string; from: number; to: number }> = [];
  const fell: Array<{ file: string; from: number; to: number }> = [];
  for (const f of allFiles) {
    const b = baseFileMap.get(f) ?? 0;
    const h = headFileMap.get(f) ?? 0;
    if (h > b) rose.push({ file: f, from: b, to: h });
    else if (h < b) fell.push({ file: f, from: b, to: h });
  }
  rose.sort((a, b) => b.to - b.from - (a.to - a.from));
  fell.sort((a, b) => a.to - a.from - (b.to - b.from));

  return {
    base: { name: base.name, captured_at: base.captured_at },
    head: { name: head.name, captured_at: head.captured_at },
    files: { added: filesAdded, removed: filesRemoved, net: filesNet },
    symbols: { added: symbolsAdded, removed: symbolsRemoved, net: symbolsNet },
    symbols_by_kind,
    edges_by_type,
    exported_symbols: {
      base: base.summary.exported_symbols,
      head: head.summary.exported_symbols,
      delta: head.summary.exported_symbols - base.summary.exported_symbols,
    },
    communities: { added: addedCommunities, removed: removedCommunities },
    top_files: { rose: rose.slice(0, 10), fell: fell.slice(0, 10) },
  };
}
