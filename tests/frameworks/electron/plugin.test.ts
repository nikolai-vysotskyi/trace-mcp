import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ElectronPlugin } from '../../../src/indexer/plugins/integration/tooling/electron/index.js';
import type { ProjectContext, ResolveContext } from '../../../src/plugin-api/types.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/electron-app');

function extractFile(relativePath: string) {
  const plugin = new ElectronPlugin();
  const content = fs.readFileSync(path.join(FIXTURE, relativePath));
  return plugin.extractNodes(relativePath, content, 'typescript')._unsafeUnwrap();
}

function edgesOfType(data: ReturnType<typeof extractFile>, type: string) {
  return data.edges!.filter((e) => e.edgeType === type);
}

/** Build a minimal ResolveContext from fixture files */
function buildResolveContext(filePaths: string[]): ResolveContext {
  const files = filePaths.map((p, i) => ({
    id: i + 1,
    path: p,
    language: 'typescript' as string | null,
  }));
  const fileContents = new Map<string, string>();
  for (const p of filePaths) {
    fileContents.set(p, fs.readFileSync(path.join(FIXTURE, p), 'utf-8'));
  }
  return {
    rootPath: FIXTURE,
    getAllFiles: () => files,
    getSymbolsByFile: () => [],
    getSymbolByFqn: () => undefined,
    getNodeId: () => undefined,
    createNodeIfNeeded: () => 0,
    readFile: (relPath: string) => fileContents.get(relPath),
  };
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
        'electron_ipc_handle', 'electron_ipc_main_on',
        'electron_ipc_invoke', 'electron_ipc_send', 'electron_ipc_send_sync', 'electron_ipc_on',
        'electron_webcontents_send', 'electron_preload_api', 'electron_browser_window',
        'electron_utility_fork', 'electron_parent_port', 'electron_message_channel',
        'electron_protocol_handle', 'electron_deprecated',
      ]) {
        expect(names).toContain(expected);
      }
    });
  });

  // ── Main process — index.ts ───────────────────────────────────

  describe('main process — index.ts', () => {
    const data = extractFile('src/main/index.ts');

    it('sets frameworkRole to electron_main', () => {
      expect(data.frameworkRole).toBe('electron_main');
    });

    it('extracts ipcMain.handle channels', () => {
      const edges = edgesOfType(data, 'electron_ipc_handle').filter(
        (e) => (e.metadata as Record<string, string>).variant === 'handle',
      );
      expect(edges).toHaveLength(3);
      const channels = edges.map((e) => (e.metadata as Record<string, string>).channel);
      expect(channels).toEqual(expect.arrayContaining(['select-folder', 'open-file', 'get-app-version']));
    });

    it('extracts ipcMain.handleOnce', () => {
      const edges = edgesOfType(data, 'electron_ipc_handle').filter(
        (e) => (e.metadata as Record<string, string>).variant === 'handleOnce',
      );
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).channel).toBe('get-initial-config');
    });

    it('extracts ipcMain.on', () => {
      const edges = edgesOfType(data, 'electron_ipc_main_on').filter(
        (e) => (e.metadata as Record<string, string>).variant === 'on',
      );
      expect(edges).toHaveLength(2);
      expect(edges.map((e) => (e.metadata as Record<string, string>).channel))
        .toEqual(expect.arrayContaining(['log-event', 'request-data']));
    });

    it('extracts ipcMain.once', () => {
      const edges = edgesOfType(data, 'electron_ipc_main_on').filter(
        (e) => (e.metadata as Record<string, string>).variant === 'once',
      );
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).channel).toBe('init-complete');
    });

    it('extracts webContents.send (main→renderer push)', () => {
      const edges = edgesOfType(data, 'electron_webcontents_send');
      const channels = edges.map((e) => (e.metadata as Record<string, string>).channel);
      expect(channels).toContain('update-available');
      expect(channels).toContain('download-progress');
    });

    it('extracts event.sender.send (reply pattern)', () => {
      const edges = edgesOfType(data, 'electron_webcontents_send');
      expect(edges.map((e) => (e.metadata as Record<string, string>).channel)).toContain('data-response');
    });

    it('extracts BrowserWindow', () => {
      const edges = edgesOfType(data, 'electron_browser_window');
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).type).toBe('BrowserWindow');
    });

    it('detects Menu usage', () => {
      expect(data.metadata?.hasMenu).toBe(true);
    });

    it('extracts protocol.handle', () => {
      const edges = edgesOfType(data, 'electron_protocol_handle');
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).scheme).toBe('app');
    });
  });

  // ── Preload — preload.ts ──────────────────────────────────────

  describe('preload — preload.ts', () => {
    const data = extractFile('src/main/preload.ts');

    it('sets frameworkRole to electron_preload', () => {
      expect(data.frameworkRole).toBe('electron_preload');
    });

    it('extracts contextBridge.exposeInMainWorld', () => {
      const edges = edgesOfType(data, 'electron_preload_api');
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).apiName).toBe('electronAPI');
    });

    it('extracts ipcRenderer.invoke channels', () => {
      const edges = edgesOfType(data, 'electron_ipc_invoke');
      expect(edges).toHaveLength(3);
      expect(edges.map((e) => (e.metadata as Record<string, string>).channel))
        .toEqual(expect.arrayContaining(['select-folder', 'open-file', 'get-app-version']));
    });

    it('extracts ipcRenderer.send', () => {
      const edges = edgesOfType(data, 'electron_ipc_send');
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).channel).toBe('log-event');
    });

    it('extracts ipcRenderer.sendSync with warning', () => {
      const edges = edgesOfType(data, 'electron_ipc_send_sync');
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).channel).toBe('get-config-sync');
      expect(data.warnings).toBeDefined();
      expect(data.warnings!.some((w) => w.includes('sendSync'))).toBe(true);
    });

    it('extracts ipcRenderer.on channels', () => {
      const edges = edgesOfType(data, 'electron_ipc_on');
      expect(edges.map((e) => (e.metadata as Record<string, string>).channel))
        .toEqual(expect.arrayContaining(['update-available', 'download-progress', 'data-response']));
    });
  });

  // ── Utility process — worker.ts ───────────────────────────────

  describe('utility process — worker.ts', () => {
    const data = extractFile('src/main/worker.ts');

    it('sets frameworkRole to electron_utility', () => {
      expect(data.frameworkRole).toBe('electron_utility');
    });

    it('extracts parentPort communication (sends + receives)', () => {
      const edges = edgesOfType(data, 'electron_parent_port');
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, unknown>).sends).toBe(true);
      expect((edges[0].metadata as Record<string, unknown>).receives).toBe(true);
    });
  });

  // ── Renderer — api.ts ─────────────────────────────────────────

  describe('renderer — api.ts', () => {
    const data = extractFile('src/renderer/api.ts');

    it('sets frameworkRole to electron_renderer', () => {
      expect(data.frameworkRole).toBe('electron_renderer');
    });

    it('extracts ipcRenderer.invoke channels', () => {
      const edges = edgesOfType(data, 'electron_ipc_invoke');
      expect(edges).toHaveLength(2);
      expect(edges.map((e) => (e.metadata as Record<string, string>).channel))
        .toEqual(expect.arrayContaining(['select-folder', 'open-file']));
    });

    it('extracts ipcRenderer.send', () => {
      const edges = edgesOfType(data, 'electron_ipc_send');
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).channel).toBe('log-event');
    });

    it('extracts ipcRenderer.on (for main→renderer push)', () => {
      const edges = edgesOfType(data, 'electron_ipc_on');
      expect(edges).toHaveLength(2);
      expect(edges.map((e) => (e.metadata as Record<string, string>).channel))
        .toEqual(expect.arrayContaining(['update-available', 'data-response']));
    });
  });

  // ── resolveEdges() — cross-file IPC resolution ────────────────

  describe('resolveEdges()', () => {
    const ctx = buildResolveContext([
      'src/main/index.ts',
      'src/main/preload.ts',
      'src/renderer/api.ts',
    ]);
    const result = plugin.resolveEdges(ctx);

    it('returns ok', () => {
      expect(result.isOk()).toBe(true);
    });

    const edges = result._unsafeUnwrap();

    it('resolves renderer invoke → main handle (preload)', () => {
      const invokeEdges = edges.filter(
        (e) => e.edgeType === 'electron_ipc_invoke' && e.source === 'src/main/preload.ts',
      );
      expect(invokeEdges.length).toBeGreaterThanOrEqual(2);
      // All should point to main/index.ts where the handlers are
      for (const edge of invokeEdges) {
        expect(edge.target).toBe('src/main/index.ts');
        expect(edge.resolution).toBe('ast_resolved');
      }
    });

    it('resolves renderer invoke → main handle (renderer/api.ts)', () => {
      const invokeEdges = edges.filter(
        (e) => e.edgeType === 'electron_ipc_invoke' && e.source === 'src/renderer/api.ts',
      );
      expect(invokeEdges.length).toBeGreaterThanOrEqual(2);
      for (const edge of invokeEdges) {
        expect(edge.target).toBe('src/main/index.ts');
      }
      const channels = invokeEdges.map((e) => (e.metadata as Record<string, string>).channel);
      expect(channels).toContain('select-folder');
      expect(channels).toContain('open-file');
    });

    it('resolves renderer send → main on', () => {
      const sendEdges = edges.filter(
        (e) => e.edgeType === 'electron_ipc_send' && (e.metadata as Record<string, string>).channel === 'log-event',
      );
      expect(sendEdges.length).toBeGreaterThanOrEqual(1);
      expect(sendEdges[0].target).toBe('src/main/index.ts');
    });

    it('resolves main webContents.send → renderer on (push direction)', () => {
      const pushEdges = edges.filter(
        (e) => e.edgeType === 'electron_webcontents_send' && e.source === 'src/main/index.ts',
      );
      expect(pushEdges.length).toBeGreaterThanOrEqual(1);
      const channels = pushEdges.map((e) => (e.metadata as Record<string, string>).channel);
      expect(channels).toContain('update-available');
      // Target should be a renderer file
      for (const edge of pushEdges) {
        expect(['src/main/preload.ts', 'src/renderer/api.ts']).toContain(edge.target);
      }
    });

    it('resolves event.sender.send → renderer on (data-response)', () => {
      const dataEdges = edges.filter(
        (e) => e.edgeType === 'electron_webcontents_send' &&
          (e.metadata as Record<string, string>).channel === 'data-response',
      );
      expect(dataEdges.length).toBeGreaterThanOrEqual(1);
      expect(dataEdges[0].source).toBe('src/main/index.ts');
    });
  });

  // ── Deprecated APIs (inline) ──────────────────────────────────

  describe('deprecated APIs', () => {
    it('flags BrowserView as deprecated with warning', () => {
      const source = `import { BrowserView } from 'electron';\nconst v = new BrowserView({});`;
      const data = plugin.extractNodes('legacy.ts', Buffer.from(source), 'typescript')._unsafeUnwrap();
      const deprecated = edgesOfType(data, 'electron_deprecated');
      expect(deprecated).toHaveLength(1);
      expect((deprecated[0].metadata as Record<string, string>).api).toBe('BrowserView');
      expect(data.warnings![0]).toContain('deprecated');
    });

    it('flags ipcRenderer.sendTo as removed with warning', () => {
      const source = `import { ipcRenderer } from 'electron';\nipcRenderer.sendTo(2, 'ch', 'data');`;
      const data = plugin.extractNodes('old.ts', Buffer.from(source), 'typescript')._unsafeUnwrap();
      const deprecated = edgesOfType(data, 'electron_deprecated');
      expect(deprecated).toHaveLength(1);
      expect((deprecated[0].metadata as Record<string, string>).api).toBe('ipcRenderer.sendTo');
      expect(data.warnings![0]).toContain('removed');
    });
  });

  // ── Modern APIs (inline) ──────────────────────────────────────

  describe('modern APIs', () => {
    it('detects MessageChannelMain', () => {
      const source = `import { MessageChannelMain } from 'electron';\nconst { port1, port2 } = new MessageChannelMain();`;
      const data = plugin.extractNodes('ports.ts', Buffer.from(source), 'typescript')._unsafeUnwrap();
      expect(edgesOfType(data, 'electron_message_channel')).toHaveLength(1);
    });

    it('detects WebContentsView + BaseWindow', () => {
      const source = `import { WebContentsView, BaseWindow } from 'electron';
const win = new BaseWindow({ width: 800 });
const view = new WebContentsView();`;
      const data = plugin.extractNodes('modern.ts', Buffer.from(source), 'typescript')._unsafeUnwrap();
      const types = edgesOfType(data, 'electron_browser_window').map(
        (e) => (e.metadata as Record<string, string>).type,
      );
      expect(types).toContain('WebContentsView');
      expect(types).toContain('BaseWindow');
    });

    it('detects utilityProcess.fork with file reference', () => {
      const source = `import { utilityProcess } from 'electron';\nconst child = utilityProcess.fork('./worker.js');`;
      const data = plugin.extractNodes('main.ts', Buffer.from(source), 'typescript')._unsafeUnwrap();
      const edges = edgesOfType(data, 'electron_utility_fork');
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).modulePath).toBe('./worker.js');
    });

    it('detects webContents.postMessage', () => {
      const source = `import { BrowserWindow } from 'electron';
const win = new BrowserWindow({});
win.webContents.postMessage('port-transfer', null, [port1]);`;
      const data = plugin.extractNodes('ports-main.ts', Buffer.from(source), 'typescript')._unsafeUnwrap();
      const edges = edgesOfType(data, 'electron_webcontents_send');
      expect(edges.map((e) => (e.metadata as Record<string, string>).channel)).toContain('port-transfer');
    });

    it('detects ipcRenderer.postMessage', () => {
      const source = `import { ipcRenderer } from 'electron';
ipcRenderer.postMessage('port-reply', null, [port1]);`;
      const data = plugin.extractNodes('renderer-port.ts', Buffer.from(source), 'typescript')._unsafeUnwrap();
      const edges = edgesOfType(data, 'electron_ipc_send');
      expect(edges).toHaveLength(1);
      expect((edges[0].metadata as Record<string, string>).variant).toBe('postMessage');
    });

    it('detects autoUpdater usage', () => {
      const source = `import { autoUpdater } from 'electron';
autoUpdater.setFeedURL({ url: 'https://example.com' });
autoUpdater.checkForUpdates();`;
      const data = plugin.extractNodes('updater.ts', Buffer.from(source), 'typescript')._unsafeUnwrap();
      expect(data.metadata?.hasAutoUpdater).toBe(true);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('ignores non-js/ts files', () => {
      const data = plugin.extractNodes('style.css', Buffer.from(''), 'css')._unsafeUnwrap();
      expect(data.symbols).toEqual([]);
    });

    it('ignores ts without electron import', () => {
      const source = 'import React from "react";\nexport const App = () => null;';
      const data = plugin.extractNodes('app.tsx', Buffer.from(source), 'typescript')._unsafeUnwrap();
      expect(data.edges).toBeUndefined();
    });

    it('detects parentPort without electron import (utility process)', () => {
      const source = `process.parentPort.on('message', (e) => {});
process.parentPort.postMessage({ done: true });`;
      const data = plugin.extractNodes('worker.ts', Buffer.from(source), 'typescript')._unsafeUnwrap();
      expect(data.frameworkRole).toBe('electron_utility');
      expect(edgesOfType(data, 'electron_parent_port')).toHaveLength(1);
    });
  });
});
