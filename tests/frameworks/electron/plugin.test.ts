import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ElectronPlugin } from '../../../src/indexer/plugins/integration/tooling/electron/index.js';
import type { RawEdge, ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/electron-app');

function extractFile(relativePath: string) {
  const plugin = new ElectronPlugin();
  const content = fs.readFileSync(path.join(FIXTURE, relativePath));
  return plugin.extractNodes(relativePath, content, 'typescript')._unsafeUnwrap();
}

function edgesOfType(edges: RawEdge[], type: string) {
  return edges.filter((e) => e.edgeType === type);
}

function metaOf(e: RawEdge): Record<string, unknown> {
  return (e.metadata ?? {}) as Record<string, unknown>;
}

/**
 * Build a minimal ResolveContext from fixture files.
 *
 * `getSymbolsByFile` returns [] here, so every edge's source falls back to the
 * file node (`sourceNodeType: 'file'`). Cross-file resolution still works
 * because it keys on file ids, not symbols. The full symbol-anchored path is
 * exercised end-to-end in tests/integration/electron-e2e.test.ts.
 */
function buildResolveContext(filePaths: string[]): {
  ctx: ResolveContext;
  idByPath: Map<string, number>;
} {
  const idByPath = new Map<string, number>();
  const files = filePaths.map((p, i) => {
    idByPath.set(p, i + 1);
    return { id: i + 1, path: p, language: 'typescript' as string | null };
  });
  const fileContents = new Map<string, string>();
  for (const p of filePaths) {
    fileContents.set(p, fs.readFileSync(path.join(FIXTURE, p), 'utf-8'));
  }
  const ctx: ResolveContext = {
    rootPath: FIXTURE,
    getAllFiles: () => files,
    getSymbolsByFile: () => [],
    getSymbolByFqn: () => undefined,
    getNodeId: () => undefined,
    createNodeIfNeeded: () => 0,
    readFile: (relPath: string) => fileContents.get(relPath),
  };
  return { ctx, idByPath };
}

function resolveAll(filePaths: string[]): { edges: RawEdge[]; idByPath: Map<string, number> } {
  const plugin = new ElectronPlugin();
  const { ctx, idByPath } = buildResolveContext(filePaths);
  const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
  return { edges, idByPath };
}

/** Per-file edges from resolveEdges when only one file is in the context. */
function resolveSingle(relativePath: string): RawEdge[] {
  return resolveAll([relativePath]).edges;
}

describe('ElectronPlugin', () => {
  const plugin = new ElectronPlugin();

  // ── detect() ──────────────────────────────────────────────────

  describe('detect()', () => {
    it('returns true via packageJson dependencies', () => {
      const ctx = {
        rootPath: FIXTURE,
        packageJson: { dependencies: { electron: '^28.0.0' } },
        configFiles: [],
      } as ProjectContext;
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true via devDependencies', () => {
      const ctx = {
        rootPath: FIXTURE,
        packageJson: { devDependencies: { electron: '^28.0.0' } },
        configFiles: [],
      } as ProjectContext;
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false without electron', () => {
      const ctx = {
        rootPath: '/nonexistent',
        packageJson: { dependencies: { react: '^18.0.0' } },
        configFiles: [],
      } as ProjectContext;
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('detects from disk fallback', () => {
      const ctx = { rootPath: FIXTURE, configFiles: [] } as ProjectContext;
      expect(plugin.detect(ctx)).toBe(true);
    });
  });

  // ── registerSchema() ──────────────────────────────────────────

  describe('registerSchema()', () => {
    it('returns all 14 edge types', () => {
      const names = plugin.registerSchema().edgeTypes!.map((e) => e.name);
      expect(names).toHaveLength(14);
      for (const expected of [
        'electron_ipc_handle',
        'electron_ipc_main_on',
        'electron_ipc_invoke',
        'electron_ipc_send',
        'electron_ipc_send_sync',
        'electron_ipc_on',
        'electron_webcontents_send',
        'electron_preload_api',
        'electron_browser_window',
        'electron_utility_fork',
        'electron_parent_port',
        'electron_message_channel',
        'electron_protocol_handle',
        'electron_deprecated',
      ]) {
        expect(names).toContain(expected);
      }
    });
  });

  // ── extractNodes() — Pass 1 tags roles + metadata only, no edges ──

  describe('extractNodes() — roles & metadata', () => {
    it('does not emit edges in Pass 1 (edges belong to resolveEdges)', () => {
      const data = extractFile('src/main/index.ts');
      expect(data.edges).toBeUndefined();
    });

    it('tags main process index.ts as electron_main with Menu metadata', () => {
      const data = extractFile('src/main/index.ts');
      expect(data.frameworkRole).toBe('electron_main');
      expect(data.metadata?.hasMenu).toBe(true);
    });

    it('tags preload.ts as electron_preload and warns on sendSync', () => {
      const data = extractFile('src/main/preload.ts');
      expect(data.frameworkRole).toBe('electron_preload');
      expect(data.warnings?.some((w) => w.includes('sendSync'))).toBe(true);
    });

    it('tags worker.ts as electron_utility', () => {
      const data = extractFile('src/main/worker.ts');
      expect(data.frameworkRole).toBe('electron_utility');
    });

    it('tags renderer/api.ts as electron_renderer', () => {
      const data = extractFile('src/renderer/api.ts');
      expect(data.frameworkRole).toBe('electron_renderer');
    });

    it('ignores non-js/ts files', () => {
      const data = plugin.extractNodes('style.css', Buffer.from(''), 'css')._unsafeUnwrap();
      expect(data.symbols).toEqual([]);
    });

    it('ignores ts without electron import', () => {
      const source = 'import React from "react";\nexport const App = () => null;';
      const data = plugin
        .extractNodes('app.tsx', Buffer.from(source), 'typescript')
        ._unsafeUnwrap();
      expect(data.frameworkRole).toBeUndefined();
    });
  });

  // ── resolveEdges() — main process index.ts (per-file, virtual targets) ──

  describe('resolveEdges() — main process index.ts', () => {
    const edges = resolveSingle('src/main/index.ts');

    it('emits ipcMain.handle channels to virtual channel targets', () => {
      const handles = edgesOfType(edges, 'electron_ipc_handle').filter(
        (e) => metaOf(e).variant === 'handle',
      );
      const channels = handles.map((e) => metaOf(e).channel);
      expect(channels).toEqual(
        expect.arrayContaining(['select-folder', 'open-file', 'get-app-version']),
      );
      for (const e of handles) {
        expect(e.targetSymbolId).toBe(`electron-channel::${metaOf(e).channel}`);
        expect(e.sourceNodeType).toBe('file'); // no symbol table in this ctx
        expect(e.sourceRefId).toBe(1);
      }
    });

    it('emits ipcMain.handleOnce', () => {
      const once = edgesOfType(edges, 'electron_ipc_handle').filter(
        (e) => metaOf(e).variant === 'handleOnce',
      );
      expect(once).toHaveLength(1);
      expect(metaOf(once[0]).channel).toBe('get-initial-config');
    });

    it('emits ipcMain.on / once', () => {
      const on = edgesOfType(edges, 'electron_ipc_main_on');
      const channels = on.map((e) => metaOf(e).channel);
      expect(channels).toEqual(
        expect.arrayContaining(['log-event', 'request-data', 'init-complete']),
      );
    });

    it('emits webContents.send and event.sender.send push channels', () => {
      const push = edgesOfType(edges, 'electron_webcontents_send');
      const channels = push.map((e) => metaOf(e).channel);
      expect(channels).toEqual(
        expect.arrayContaining(['update-available', 'download-progress', 'data-response']),
      );
    });

    it('emits BrowserWindow construction', () => {
      const win = edgesOfType(edges, 'electron_browser_window');
      expect(win).toHaveLength(1);
      expect(metaOf(win[0]).type).toBe('BrowserWindow');
      expect(win[0].targetSymbolId).toBe('electron-window::BrowserWindow');
    });

    it('emits protocol.handle', () => {
      const proto = edgesOfType(edges, 'electron_protocol_handle');
      expect(proto).toHaveLength(1);
      expect(metaOf(proto[0]).scheme).toBe('app');
      expect(proto[0].targetSymbolId).toBe('electron-protocol::app');
    });
  });

  // ── resolveEdges() — preload.ts ───────────────────────────────

  describe('resolveEdges() — preload.ts', () => {
    const edges = resolveSingle('src/main/preload.ts');

    it('emits contextBridge.exposeInMainWorld', () => {
      const api = edgesOfType(edges, 'electron_preload_api');
      expect(api).toHaveLength(1);
      expect(metaOf(api[0]).apiName).toBe('electronAPI');
      expect(api[0].targetSymbolId).toBe('electron-preload::electronAPI');
    });

    it('emits ipcRenderer.invoke channels', () => {
      const invoke = edgesOfType(edges, 'electron_ipc_invoke');
      const channels = invoke.map((e) => metaOf(e).channel);
      expect(channels).toEqual(
        expect.arrayContaining(['select-folder', 'open-file', 'get-app-version']),
      );
    });

    it('emits ipcRenderer.sendSync', () => {
      const sync = edgesOfType(edges, 'electron_ipc_send_sync');
      expect(sync).toHaveLength(1);
      expect(metaOf(sync[0]).channel).toBe('get-config-sync');
    });

    it('emits ipcRenderer.on/once channels', () => {
      const on = edgesOfType(edges, 'electron_ipc_on');
      const channels = on.map((e) => metaOf(e).channel);
      expect(channels).toEqual(
        expect.arrayContaining(['update-available', 'download-progress', 'data-response']),
      );
    });
  });

  // ── resolveEdges() — utility worker.ts ────────────────────────

  describe('resolveEdges() — worker.ts', () => {
    it('emits parentPort communication (sends + receives)', () => {
      const edges = resolveSingle('src/main/worker.ts');
      const pp = edgesOfType(edges, 'electron_parent_port');
      expect(pp).toHaveLength(1);
      expect(metaOf(pp[0]).sends).toBe(true);
      expect(metaOf(pp[0]).receives).toBe(true);
    });
  });

  // ── resolveEdges() — cross-file IPC resolution ────────────────

  describe('resolveEdges() — cross-file IPC', () => {
    const { edges, idByPath } = resolveAll([
      'src/main/index.ts',
      'src/main/preload.ts',
      'src/renderer/api.ts',
    ]);
    const mainId = idByPath.get('src/main/index.ts')!;

    it('resolves renderer invoke → main handle file (target node = file)', () => {
      const invoke = edges.filter(
        (e) => e.edgeType === 'electron_ipc_invoke' && metaOf(e).resolution === 'cross_file',
      );
      expect(invoke.length).toBeGreaterThanOrEqual(2);
      for (const e of invoke) {
        expect(e.targetNodeType).toBe('file');
        expect(e.targetRefId).toBe(mainId);
        expect(metaOf(e).targetFile).toBe('src/main/index.ts');
        expect(e.resolution).toBe('ast_resolved');
      }
      const channels = invoke.map((e) => metaOf(e).channel);
      expect(channels).toContain('select-folder');
      expect(channels).toContain('open-file');
    });

    it('resolves renderer send → main on file', () => {
      const send = edges.filter(
        (e) => e.edgeType === 'electron_ipc_send' && metaOf(e).resolution === 'cross_file',
      );
      expect(send.length).toBeGreaterThanOrEqual(1);
      for (const e of send) {
        expect(e.targetNodeType).toBe('file');
        expect(metaOf(e).targetFile).toBe('src/main/index.ts');
      }
    });

    it('resolves main webContents.send → renderer on file (push direction)', () => {
      const push = edges.filter(
        (e) => e.edgeType === 'electron_webcontents_send' && metaOf(e).resolution === 'cross_file',
      );
      expect(push.length).toBeGreaterThanOrEqual(1);
      for (const e of push) {
        expect(e.targetNodeType).toBe('file');
        expect(metaOf(e).file).toBe('src/main/index.ts');
        expect(['src/main/preload.ts', 'src/renderer/api.ts']).toContain(metaOf(e).targetFile);
      }
      expect(push.map((e) => metaOf(e).channel)).toContain('update-available');
    });
  });

  // ── Deprecated / modern APIs (inline via resolveEdges) ────────

  function resolveInline(source: string): RawEdge[] {
    const plugin = new ElectronPlugin();
    const ctx: ResolveContext = {
      rootPath: FIXTURE,
      getAllFiles: () => [{ id: 1, path: 'inline.ts', language: 'typescript' }],
      getSymbolsByFile: () => [],
      getSymbolByFqn: () => undefined,
      getNodeId: () => undefined,
      createNodeIfNeeded: () => 0,
      readFile: () => source,
    };
    return plugin.resolveEdges(ctx)._unsafeUnwrap();
  }

  describe('deprecated APIs', () => {
    it('flags BrowserView as deprecated (edge + warning)', () => {
      const source = `import { BrowserView } from 'electron';\nconst v = new BrowserView({});`;
      const edges = resolveInline(source);
      const deprecated = edgesOfType(edges, 'electron_deprecated');
      expect(deprecated).toHaveLength(1);
      expect(metaOf(deprecated[0]).api).toBe('BrowserView');
      expect(deprecated[0].targetSymbolId).toBe('electron-deprecated::BrowserView');

      const warnData = plugin
        .extractNodes('legacy.ts', Buffer.from(source), 'typescript')
        ._unsafeUnwrap();
      expect(warnData.warnings![0]).toContain('deprecated');
    });

    it('flags ipcRenderer.sendTo as removed (edge + warning)', () => {
      const source = `import { ipcRenderer } from 'electron';\nipcRenderer.sendTo(2, 'ch', 'data');`;
      const edges = resolveInline(source);
      const deprecated = edgesOfType(edges, 'electron_deprecated');
      expect(deprecated).toHaveLength(1);
      expect(metaOf(deprecated[0]).api).toBe('ipcRenderer.sendTo');

      const warnData = plugin
        .extractNodes('old.ts', Buffer.from(source), 'typescript')
        ._unsafeUnwrap();
      expect(warnData.warnings![0]).toContain('removed');
    });
  });

  describe('modern APIs', () => {
    it('detects MessageChannelMain', () => {
      const source = `import { MessageChannelMain } from 'electron';\nconst { port1, port2 } = new MessageChannelMain();`;
      expect(edgesOfType(resolveInline(source), 'electron_message_channel')).toHaveLength(1);
    });

    it('detects WebContentsView + BaseWindow', () => {
      const source = `import { WebContentsView, BaseWindow } from 'electron';
const win = new BaseWindow({ width: 800 });
const view = new WebContentsView();`;
      const types = edgesOfType(resolveInline(source), 'electron_browser_window').map(
        (e) => metaOf(e).type,
      );
      expect(types).toContain('WebContentsView');
      expect(types).toContain('BaseWindow');
    });

    it('detects utilityProcess.fork with file reference', () => {
      const source = `import { utilityProcess } from 'electron';\nconst child = utilityProcess.fork('./worker.js');`;
      const edges = edgesOfType(resolveInline(source), 'electron_utility_fork');
      expect(edges).toHaveLength(1);
      expect(metaOf(edges[0]).modulePath).toBe('./worker.js');
      expect(edges[0].targetSymbolId).toBe('electron-module::./worker.js');
    });

    it('detects webContents.postMessage', () => {
      const source = `import { BrowserWindow } from 'electron';
const win = new BrowserWindow({});
win.webContents.postMessage('port-transfer', null, [port1]);`;
      const channels = edgesOfType(resolveInline(source), 'electron_webcontents_send').map(
        (e) => metaOf(e).channel,
      );
      expect(channels).toContain('port-transfer');
    });

    it('detects ipcRenderer.postMessage', () => {
      const source = `import { ipcRenderer } from 'electron';
ipcRenderer.postMessage('port-reply', null, [port1]);`;
      const edges = edgesOfType(resolveInline(source), 'electron_ipc_send');
      expect(edges).toHaveLength(1);
      expect(metaOf(edges[0]).variant).toBe('postMessage');
    });

    it('detects autoUpdater usage (metadata)', () => {
      const source = `import { autoUpdater } from 'electron';
autoUpdater.setFeedURL({ url: 'https://example.com' });
autoUpdater.checkForUpdates();`;
      const data = plugin
        .extractNodes('updater.ts', Buffer.from(source), 'typescript')
        ._unsafeUnwrap();
      expect(data.metadata?.hasAutoUpdater).toBe(true);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('detects parentPort without electron import (utility process)', () => {
      const source = `process.parentPort.on('message', (e) => {});
process.parentPort.postMessage({ done: true });`;
      const data = plugin
        .extractNodes('worker.ts', Buffer.from(source), 'typescript')
        ._unsafeUnwrap();
      expect(data.frameworkRole).toBe('electron_utility');

      const ctx: ResolveContext = {
        rootPath: FIXTURE,
        getAllFiles: () => [{ id: 1, path: 'worker.ts', language: 'typescript' }],
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => source,
      };
      const edges = plugin.resolveEdges(ctx)._unsafeUnwrap();
      expect(edgesOfType(edges, 'electron_parent_port')).toHaveLength(1);
    });
  });
});
