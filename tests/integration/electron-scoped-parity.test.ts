/**
 * TRA-1729 — scoped vs full parity for the electron Pass-2 plugin.
 *
 * The scoped pass (warm channel-role cache + changed files only) must yield
 * exactly the same electron_* edge set as a forced full reindex, including
 * the hard directions: a handler added AFTER the renderer already invoked
 * its channel (counterpart anchored in an unchanged file), and a push added
 * after the renderer already listened (pusher-anchored reverse edge).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import {
  __getElectronPassStats,
  ElectronPlugin,
} from '../../src/indexer/plugins/integration/tooling/electron/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/electron-app');

let tmpRoot: string;
let store: Store;
let pipeline: IndexingPipeline;

function makeConfig(): TraceMcpConfig {
  return {
    root: tmpRoot,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    plugins: [],
  };
}

interface NormalizedEdge {
  key: string;
  meta: Record<string, unknown>;
}

/** Electron edge set with row ids normalized away (file paths + symbol ids). */
function loadElectronEdgeSet(s: Store): string[] {
  const rows = s.db
    .prepare(
      `
      SELECT et.name AS edge_type,
             e.resolved AS resolved,
             e.resolution_tier AS tier,
             e.metadata AS metadata,
             sn.node_type AS src_type,
             sf.path AS src_file,
             ss.symbol_id AS src_symbol,
             tn.node_type AS tgt_type,
             tf.path AS tgt_file,
             ts.symbol_id AS tgt_symbol
      FROM edges e
      JOIN edge_types et ON et.id = e.edge_type_id
      JOIN nodes sn ON sn.id = e.source_node_id
      LEFT JOIN files sf ON sn.node_type = 'file' AND sn.ref_id = sf.id
      LEFT JOIN symbols ss ON sn.node_type = 'symbol' AND sn.ref_id = ss.id
      JOIN nodes tn ON tn.id = e.target_node_id
      LEFT JOIN files tf ON tn.node_type = 'file' AND tn.ref_id = tf.id
      LEFT JOIN symbols ts ON tn.node_type = 'symbol' AND tn.ref_id = ts.id
      WHERE et.name LIKE 'electron\\_%' ESCAPE '\\'
    `,
    )
    .all() as Array<Record<string, unknown>>;
  return rows
    .map((r) => {
      const src = r.src_type === 'file' ? `file:${r.src_file}` : `symbol:${r.src_symbol}`;
      const tgt = r.tgt_type === 'file' ? `file:${r.tgt_file}` : `symbol:${r.tgt_symbol}`;
      const meta = r.metadata ? JSON.stringify(sortKeys(JSON.parse(r.metadata as string))) : '';
      return `${r.edge_type}|${src}|${tgt}|${r.resolved}|${r.tier}|${meta}`;
    })
    .sort();
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

function append(rel: string, text: string): void {
  fs.appendFileSync(path.join(tmpRoot, rel), text);
}

function findEdge(keys: string[], edgeType: string, channel: string, resolution: string): string[] {
  return keys.filter(
    (k) =>
      k.startsWith(`${edgeType}|`) &&
      k.includes(`"channel":"${channel}"`) &&
      k.includes(`"resolution":"${resolution}"`),
  );
}

describe('Electron scoped Pass-2 parity (TRA-1729)', () => {
  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-scope-'));
    fs.cpSync(FIXTURE_SRC, tmpRoot, { recursive: true });
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new ElectronPlugin());
    pipeline = new IndexingPipeline(store, registry, makeConfig(), tmpRoot);
    await pipeline.indexAll();
  });

  it('cold index emits the full edge set (baseline)', () => {
    expect(loadElectronEdgeSet(store).length).toBeGreaterThan(0);
  });

  it('scoped runs match a forced full reindex, all directions', async () => {
    // Run 1 — renderer invokes a channel nobody handles yet (virtual only).
    append(
      'src/renderer/api.ts',
      `\nexport async function lateCall() {\n  return ipcRenderer.invoke('late-channel');\n}\n`,
    );
    await pipeline.indexFiles(['src/renderer/api.ts']);

    // Run 2 — main starts handling it: counterpart anchored in the UNCHANGED
    // renderer file must appear without a full scan.
    append(
      'src/main/index.ts',
      `\nipcMain.handle('late-channel', async () => {\n  return 'late';\n});\n`,
    );
    await pipeline.indexFiles(['src/main/index.ts']);
    let keys = loadElectronEdgeSet(store);
    const lateInvoke = findEdge(keys, 'electron_ipc_invoke', 'late-channel', 'cross_file');
    expect(lateInvoke).toHaveLength(1);
    expect(lateInvoke[0]).toContain('targetFile":"src/main/index.ts');

    // Run 3 — renderer listens first (cached on-side), pusher arrives later.
    append(
      'src/renderer/api.ts',
      `\nexport function onFreshPush(cb: (d: unknown) => void) {\n  ipcRenderer.on('fresh-push', (_e, d) => cb(d));\n}\n`,
    );
    await pipeline.indexFiles(['src/renderer/api.ts']);
    append(
      'src/main/index.ts',
      `\nfunction pushFresh() {\n  if (mainWindow) {\n    mainWindow.webContents.send('fresh-push', 1);\n  }\n}\n`,
    );
    await pipeline.indexFiles(['src/main/index.ts']);
    keys = loadElectronEdgeSet(store);
    const push = findEdge(keys, 'electron_webcontents_send', 'fresh-push', 'cross_file');
    expect(push).toHaveLength(1);
    expect(push[0]).toContain('targetFile":"src/renderer/api.ts');

    // The scoped path engaged (not silent full-scan fallback).
    expect(__getElectronPassStats().scoped).toBeGreaterThanOrEqual(4);

    // Forced full reindex must produce the identical set.
    await pipeline.indexAll(true);
    expect(loadElectronEdgeSet(store)).toEqual(keys);
  });

  it('comment-only change to an electron file keeps the set stable', async () => {
    const before = loadElectronEdgeSet(store);
    append('src/main/index.ts', `\n// touch: no semantic change\n`);
    await pipeline.indexFiles(['src/main/index.ts']);
    expect(loadElectronEdgeSet(store)).toEqual(before);
  });
});
