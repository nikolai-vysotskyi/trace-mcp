/**
 * TRA-1780 — removal parity for the electron Pass-2 plugin.
 *
 * Companion to electron-scoped-parity.test.ts (TRA-1729, add-direction):
 * removing a handler / listener must delete the file-anchored cross-file
 * edge in a scoped run AND in a forced full reindex, identically.
 *
 * Covers the review finding on PR #1313: the edge source lives in the
 * UNCHANGED file, so outgoing-only cleanup on the changed file never
 * touches it, and the fast symbol path skips edge deletion entirely when
 * the removal leaves the symbol table structurally identical (top-level
 * `ipcMain.handle` / `ipcRenderer.on` calls own no symbol).
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

function removeText(rel: string, text: string): void {
  const abs = path.join(tmpRoot, rel);
  const before = fs.readFileSync(abs, 'utf-8');
  expect(before).toContain(text);
  fs.writeFileSync(abs, before.replace(text, ''));
}

function findEdge(keys: string[], edgeType: string, channel: string, resolution: string): string[] {
  return keys.filter(
    (k) =>
      k.startsWith(`${edgeType}|`) &&
      k.includes(`"channel":"${channel}"`) &&
      k.includes(`"resolution":"${resolution}"`),
  );
}

const HANDLE_CHANNEL = 'tomb-late-channel';
const PUSH_CHANNEL = 'tomb-fresh-push';

const HANDLE_BLOCK = `\nipcMain.handle('${HANDLE_CHANNEL}', async () => {\n  return 'late';\n});\n`;
const INVOKE_BLOCK = `\nexport async function tombLateCall() {\n  return ipcRenderer.invoke('${HANDLE_CHANNEL}');\n}\n`;
const ON_BLOCK = `\nexport function tombOnFreshPush(cb: (d: unknown) => void) {\n  ipcRenderer.on('${PUSH_CHANNEL}', (_e, d) => cb(d));\n}\n`;
const PUSH_BLOCK = `\nfunction tombPushFresh() {\n  if (mainWindow) {\n    mainWindow.webContents.send('${PUSH_CHANNEL}', 1);\n  }\n}\n`;

describe('Electron removal parity (TRA-1780)', () => {
  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-removal-'));
    fs.cpSync(FIXTURE_SRC, tmpRoot, { recursive: true });
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new ElectronPlugin());
    pipeline = new IndexingPipeline(store, registry, makeConfig(), tmpRoot);
    await pipeline.indexAll();
  });

  it('removing a handler deletes the cross-file invoke edge (scoped == full)', async () => {
    append('src/renderer/api.ts', INVOKE_BLOCK);
    await pipeline.indexFiles(['src/renderer/api.ts']);

    append('src/main/index.ts', HANDLE_BLOCK);
    await pipeline.indexFiles(['src/main/index.ts']);
    let keys = loadElectronEdgeSet(store);
    expect(findEdge(keys, 'electron_ipc_invoke', HANDLE_CHANNEL, 'cross_file')).toHaveLength(1);

    // Remove the handler; the renderer (edge source) is unchanged.
    removeText('src/main/index.ts', HANDLE_BLOCK);
    const r = await pipeline.indexFiles(['src/main/index.ts']);
    expect(r.indexed).toBe(1);

    keys = loadElectronEdgeSet(store);
    expect(findEdge(keys, 'electron_ipc_invoke', HANDLE_CHANNEL, 'cross_file')).toHaveLength(0);

    const scopedKeys = keys;
    await pipeline.indexAll(true);
    expect(loadElectronEdgeSet(store)).toEqual(scopedKeys);
  });

  it('removing a renderer listener deletes the pusher-anchored edge (scoped == full)', async () => {
    append('src/renderer/api.ts', ON_BLOCK);
    await pipeline.indexFiles(['src/renderer/api.ts']);
    append('src/main/index.ts', PUSH_BLOCK);
    await pipeline.indexFiles(['src/main/index.ts']);
    let keys = loadElectronEdgeSet(store);
    expect(findEdge(keys, 'electron_webcontents_send', PUSH_CHANNEL, 'cross_file')).toHaveLength(1);

    // Remove the listener; the pusher (edge source) is unchanged.
    removeText('src/renderer/api.ts', ON_BLOCK);
    const r = await pipeline.indexFiles(['src/renderer/api.ts']);
    expect(r.indexed).toBe(1);

    keys = loadElectronEdgeSet(store);
    expect(findEdge(keys, 'electron_webcontents_send', PUSH_CHANNEL, 'cross_file')).toHaveLength(0);

    // The scoped path engaged (not silent full-scan fallback).
    expect(__getElectronPassStats().scoped).toBeGreaterThanOrEqual(2);

    const scopedKeys = keys;
    await pipeline.indexAll(true);
    expect(loadElectronEdgeSet(store)).toEqual(scopedKeys);
  });

  it('removing the winning handler re-targets to the surviving provider (scoped == full)', async () => {
    const channel = 'tomb-take-channel';
    append(
      'src/renderer/api.ts',
      `\nexport async function tombTakeCall() {\n  return ipcRenderer.invoke('${channel}');\n}\n`,
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'src/main/tomb-aaa.ts'),
      `import { ipcMain } from 'electron';\nipcMain.handle('${channel}', async () => 'aaa');\n`,
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'src/main/tomb-zzz.ts'),
      `import { ipcMain } from 'electron';\nipcMain.handle('${channel}', async () => 'zzz');\n`,
    );
    await pipeline.indexFiles([
      'src/renderer/api.ts',
      'src/main/tomb-aaa.ts',
      'src/main/tomb-zzz.ts',
    ]);
    let keys = loadElectronEdgeSet(store);
    let found = findEdge(keys, 'electron_ipc_invoke', channel, 'cross_file');
    expect(found).toHaveLength(1);
    // Last in file order wins.
    expect(found[0]).toContain('targetFile":"src/main/tomb-zzz.ts');

    // Remove the winner; the renderer and the surviving provider are unchanged.
    fs.writeFileSync(
      path.join(tmpRoot, 'src/main/tomb-zzz.ts'),
      `import { ipcMain } from 'electron';\n// handler removed\n`,
    );
    await pipeline.indexFiles(['src/main/tomb-zzz.ts']);
    keys = loadElectronEdgeSet(store);
    found = findEdge(keys, 'electron_ipc_invoke', channel, 'cross_file');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('targetFile":"src/main/tomb-aaa.ts');

    const scopedKeys = keys;
    await pipeline.indexAll(true);
    expect(loadElectronEdgeSet(store)).toEqual(scopedKeys);
  });
});
