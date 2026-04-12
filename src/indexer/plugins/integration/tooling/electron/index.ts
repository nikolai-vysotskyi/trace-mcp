/**
 * Electron plugin — detects Electron app structure and IPC communication:
 *
 * Main process:       ipcMain.handle/handleOnce/on/once, BrowserWindow, Tray, Menu, autoUpdater
 * Renderer process:   ipcRenderer.invoke/send/sendSync/sendToHost/on/once
 * Preload scripts:    contextBridge.exposeInMainWorld/exposeInIsolatedWorld
 * Main→Renderer push: webContents.send, event.sender.send, webContents.postMessage
 * Utility processes:  utilityProcess.fork, process.parentPort.postMessage/on
 * MessagePorts:       MessageChannelMain, port.postMessage
 * Views:              BrowserWindow, WebContentsView, BaseWindow, BrowserView (deprecated)
 * Protocols:          protocol.handle (custom schemes)
 * App lifecycle:      app.on('ready'), app.whenReady()
 * Deprecated:         ipcRenderer.sendTo (removed v28), BrowserView (deprecated v30)
 *
 * Edge types: electron_ipc_handle, electron_ipc_main_on, electron_ipc_invoke,
 * electron_ipc_send, electron_ipc_send_sync, electron_ipc_on,
 * electron_webcontents_send, electron_preload_api,
 * electron_browser_window, electron_utility_fork, electron_parent_port,
 * electron_message_channel, electron_protocol_handle, electron_deprecated.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// ── regex patterns ──────────────────────────────────────────────

// Main process IPC
const IPC_MAIN_HANDLE_RE      = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
const IPC_MAIN_HANDLE_ONCE_RE = /ipcMain\.handleOnce\(\s*['"]([^'"]+)['"]/g;
const IPC_MAIN_ON_RE          = /ipcMain\.on\(\s*['"]([^'"]+)['"]/g;
const IPC_MAIN_ONCE_RE        = /ipcMain\.once\(\s*['"]([^'"]+)['"]/g;

// Renderer IPC
const IPC_RENDERER_INVOKE_RE   = /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_SEND_RE     = /ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_SEND_SYNC_RE = /ipcRenderer\.sendSync\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_SEND_TO_HOST_RE = /ipcRenderer\.sendToHost\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_ON_RE       = /ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_ONCE_RE     = /ipcRenderer\.once\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_POST_MSG_RE = /ipcRenderer\.postMessage\(\s*['"]([^'"]+)['"]/g;

// Deprecated: ipcRenderer.sendTo (removed Electron 28)
const IPC_RENDERER_SEND_TO_RE  = /ipcRenderer\.sendTo\s*\(/;

// Main → Renderer push
const WEBCONTENTS_SEND_RE      = /\.webContents\.send\(\s*['"]([^'"]+)['"]/g;
const EVENT_SENDER_SEND_RE     = /event\.sender\.send\(\s*['"]([^'"]+)['"]/g;
const WEBCONTENTS_POST_MSG_RE  = /\.webContents\.postMessage\(\s*['"]([^'"]+)['"]/g;
const SENDER_FRAME_POST_MSG_RE = /event\.senderFrame\.postMessage\(\s*['"]([^'"]+)['"]/g;

// Frame-scoped IPC
const CONTENTS_IPC_ON_RE       = /\.ipc\.on\(\s*['"]([^'"]+)['"]/g;
const CONTENTS_IPC_HANDLE_RE   = /\.ipc\.handle\(\s*['"]([^'"]+)['"]/g;

// Context bridge
const CONTEXT_BRIDGE_RE            = /contextBridge\.exposeInMainWorld\(\s*['"]([^'"]+)['"]/g;
const CONTEXT_BRIDGE_ISOLATED_RE   = /contextBridge\.exposeInIsolatedWorld\s*\(/;

// Window/View construction (non-global — only used with .test())
const BROWSER_WINDOW_RE    = /new\s+BrowserWindow\s*\(/;
const WEB_CONTENTS_VIEW_RE = /new\s+WebContentsView\s*\(/;
const BASE_WINDOW_RE       = /new\s+BaseWindow\s*\(/;
const BROWSER_VIEW_RE      = /new\s+BrowserView\s*\(/; // deprecated v30
const TRAY_RE              = /new\s+Tray\s*\(/;

// Utility process
const UTILITY_FORK_RE      = /utilityProcess\.fork\s*\(\s*(?:['"]([^'"]+)['"]|(\w+))/g;
const PARENT_PORT_POST_RE  = /process\.parentPort\.postMessage\s*\(/;
const PARENT_PORT_ON_RE    = /process\.parentPort\.on\(\s*['"]message['"]/;

// MessageChannel
const MESSAGE_CHANNEL_RE   = /new\s+MessageChannelMain\s*\(/;

// Protocol
const PROTOCOL_HANDLE_RE   = /protocol\.handle\(\s*['"]([^'"]+)['"]/g;

// Menu
const MENU_BUILD_RE        = /Menu\.buildFromTemplate\s*\(/;
const MENU_SET_APP_RE      = /Menu\.setApplicationMenu\s*\(/;

// AutoUpdater
const AUTO_UPDATER_RE      = /autoUpdater\.(setFeedURL|checkForUpdates|quitAndInstall|on)\s*\(/;

// Electron imports
const ELECTRON_IMPORT_RE = /(?:from\s+['"]electron['"]|require\s*\(\s*['"]electron['"]\s*\))/;
const PARENT_PORT_USAGE_RE = /process\.parentPort/;

// ── helpers ─────────────────────────────────────────────────────

function extractChannels(source: string, re: RegExp): string[] {
  const channels: string[] = [];
  for (const m of source.matchAll(re)) {
    channels.push(m[1]);
  }
  return channels;
}

// ── plugin ──────────────────────────────────────────────────────

export class ElectronPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'electron',
    version: '2.0.0',
    priority: 30,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('electron' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = {
        ...(content.dependencies as Record<string, string> | undefined),
        ...(content.devDependencies as Record<string, string> | undefined),
      };
      return 'electron' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        // Main IPC
        { name: 'electron_ipc_handle',      category: 'electron', description: 'Main process IPC handler (ipcMain.handle/handleOnce)' },
        { name: 'electron_ipc_main_on',     category: 'electron', description: 'Main process IPC listener (ipcMain.on/once)' },
        // Renderer IPC
        { name: 'electron_ipc_invoke',      category: 'electron', description: 'Renderer invokes IPC channel (ipcRenderer.invoke)' },
        { name: 'electron_ipc_send',        category: 'electron', description: 'Renderer sends IPC message (ipcRenderer.send/sendSync)' },
        { name: 'electron_ipc_send_sync',   category: 'electron', description: 'Renderer synchronous IPC (ipcRenderer.sendSync)' },
        { name: 'electron_ipc_on',          category: 'electron', description: 'Renderer listens to IPC channel (ipcRenderer.on/once)' },
        // Main→Renderer
        { name: 'electron_webcontents_send', category: 'electron', description: 'Main pushes to renderer (webContents.send/postMessage)' },
        // Preload
        { name: 'electron_preload_api',     category: 'electron', description: 'Preload exposes API via contextBridge' },
        // Structure
        { name: 'electron_browser_window',  category: 'electron', description: 'Creates a BrowserWindow/BaseWindow/WebContentsView' },
        // Utility process
        { name: 'electron_utility_fork',    category: 'electron', description: 'Forks a utility process (file reference)' },
        { name: 'electron_parent_port',     category: 'electron', description: 'Utility process ↔ parent communication' },
        // MessageChannel
        { name: 'electron_message_channel', category: 'electron', description: 'MessageChannelMain creation (port-based IPC)' },
        // Protocol
        { name: 'electron_protocol_handle', category: 'electron', description: 'Custom protocol handler (protocol.handle)' },
        // Deprecated
        { name: 'electron_deprecated',      category: 'electron', description: 'Deprecated API usage (BrowserView, sendTo, etc.)' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const hasElectronImport = ELECTRON_IMPORT_RE.test(source);
    const hasParentPort = PARENT_PORT_USAGE_RE.test(source);

    if (!hasElectronImport && !hasParentPort) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const warnings: string[] = [];

    // ── Main process: ipcMain.handle/handleOnce/on/once ──
    const mainHandles = extractChannels(source, IPC_MAIN_HANDLE_RE);
    const mainHandleOnces = extractChannels(source, IPC_MAIN_HANDLE_ONCE_RE);
    const mainOns = extractChannels(source, IPC_MAIN_ON_RE);
    const mainOnces = extractChannels(source, IPC_MAIN_ONCE_RE);

    if (mainHandles.length + mainHandleOnces.length + mainOns.length + mainOnces.length > 0) {
      result.frameworkRole = 'electron_main';
      for (const channel of mainHandles) {
        result.edges!.push({
          source: filePath, target: channel,
          edgeType: 'electron_ipc_handle', metadata: { channel, variant: 'handle' },
        });
      }
      for (const channel of mainHandleOnces) {
        result.edges!.push({
          source: filePath, target: channel,
          edgeType: 'electron_ipc_handle', metadata: { channel, variant: 'handleOnce' },
        });
      }
      for (const channel of mainOns) {
        result.edges!.push({
          source: filePath, target: channel,
          edgeType: 'electron_ipc_main_on', metadata: { channel, variant: 'on' },
        });
      }
      for (const channel of mainOnces) {
        result.edges!.push({
          source: filePath, target: channel,
          edgeType: 'electron_ipc_main_on', metadata: { channel, variant: 'once' },
        });
      }
    }

    // ── Main → Renderer push: webContents.send / event.sender.send ──
    const wcSends = extractChannels(source, WEBCONTENTS_SEND_RE);
    const senderSends = extractChannels(source, EVENT_SENDER_SEND_RE);
    const wcPostMsgs = extractChannels(source, WEBCONTENTS_POST_MSG_RE);
    const senderFramePMs = extractChannels(source, SENDER_FRAME_POST_MSG_RE);

    for (const channel of [...wcSends, ...senderSends, ...wcPostMsgs, ...senderFramePMs]) {
      result.frameworkRole = result.frameworkRole ?? 'electron_main';
      result.edges!.push({
        source: filePath, target: channel,
        edgeType: 'electron_webcontents_send', metadata: { channel },
      });
    }

    // ── Frame-scoped IPC ──
    const frameOns = extractChannels(source, CONTENTS_IPC_ON_RE);
    const frameHandles = extractChannels(source, CONTENTS_IPC_HANDLE_RE);
    for (const channel of frameOns) {
      result.edges!.push({
        source: filePath, target: channel,
        edgeType: 'electron_ipc_main_on', metadata: { channel, variant: 'frame_scoped' },
      });
    }
    for (const channel of frameHandles) {
      result.edges!.push({
        source: filePath, target: channel,
        edgeType: 'electron_ipc_handle', metadata: { channel, variant: 'frame_scoped' },
      });
    }

    // ── Renderer: ipcRenderer.invoke/send/sendSync/sendToHost/on/once ──
    const rendererInvokes = extractChannels(source, IPC_RENDERER_INVOKE_RE);
    const rendererSends = extractChannels(source, IPC_RENDERER_SEND_RE);
    const rendererSendSyncs = extractChannels(source, IPC_RENDERER_SEND_SYNC_RE);
    const rendererSendToHosts = extractChannels(source, IPC_RENDERER_SEND_TO_HOST_RE);
    const rendererPostMsgs = extractChannels(source, IPC_RENDERER_POST_MSG_RE);
    const rendererOns = extractChannels(source, IPC_RENDERER_ON_RE);
    const rendererOnces = extractChannels(source, IPC_RENDERER_ONCE_RE);

    const hasRendererIpc = rendererInvokes.length + rendererSends.length + rendererSendSyncs.length +
      rendererSendToHosts.length + rendererPostMsgs.length + rendererOns.length + rendererOnces.length;

    if (hasRendererIpc > 0) {
      result.frameworkRole = result.frameworkRole ?? 'electron_renderer';

      for (const channel of rendererInvokes) {
        result.edges!.push({
          source: filePath, target: channel,
          edgeType: 'electron_ipc_invoke', metadata: { channel },
        });
      }
      for (const channel of rendererSends) {
        result.edges!.push({
          source: filePath, target: channel,
          edgeType: 'electron_ipc_send', metadata: { channel },
        });
      }
      for (const channel of rendererSendSyncs) {
        result.edges!.push({
          source: filePath, target: channel,
          edgeType: 'electron_ipc_send_sync', metadata: { channel },
        });
        warnings.push(`sendSync('${channel}') blocks renderer — consider ipcRenderer.invoke() instead`);
      }
      for (const channel of rendererSendToHosts) {
        result.edges!.push({
          source: filePath, target: channel,
          edgeType: 'electron_ipc_send', metadata: { channel, variant: 'sendToHost' },
        });
      }
      for (const channel of rendererPostMsgs) {
        result.edges!.push({
          source: filePath, target: channel,
          edgeType: 'electron_ipc_send', metadata: { channel, variant: 'postMessage' },
        });
      }
      for (const channel of [...rendererOns, ...rendererOnces]) {
        result.edges!.push({
          source: filePath, target: channel,
          edgeType: 'electron_ipc_on', metadata: { channel },
        });
      }
    }

    // ── Preload: contextBridge ──
    for (const m of source.matchAll(CONTEXT_BRIDGE_RE)) {
      result.frameworkRole = 'electron_preload';
      result.edges!.push({
        source: filePath, target: m[1],
        edgeType: 'electron_preload_api', metadata: { apiName: m[1] },
      });
    }
    if (CONTEXT_BRIDGE_ISOLATED_RE.test(source)) {
      result.frameworkRole = 'electron_preload';
      result.edges!.push({
        source: filePath, target: 'isolatedWorld',
        edgeType: 'electron_preload_api', metadata: { variant: 'isolatedWorld' },
      });
    }

    // ── Window/View construction ──
    if (BROWSER_WINDOW_RE.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'electron_main';
      result.edges!.push({
        source: filePath, target: 'BrowserWindow',
        edgeType: 'electron_browser_window', metadata: { type: 'BrowserWindow' },
      });
    }
    if (WEB_CONTENTS_VIEW_RE.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'electron_main';
      result.edges!.push({
        source: filePath, target: 'WebContentsView',
        edgeType: 'electron_browser_window', metadata: { type: 'WebContentsView' },
      });
    }
    if (BASE_WINDOW_RE.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'electron_main';
      result.edges!.push({
        source: filePath, target: 'BaseWindow',
        edgeType: 'electron_browser_window', metadata: { type: 'BaseWindow' },
      });
    }
    if (TRAY_RE.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'electron_main';
    }

    // ── Deprecated: BrowserView ──
    if (BROWSER_VIEW_RE.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'electron_main';
      result.edges!.push({
        source: filePath, target: 'BrowserView',
        edgeType: 'electron_deprecated',
        metadata: { api: 'BrowserView', message: 'Deprecated in Electron 30 — use WebContentsView' },
      });
      warnings.push('BrowserView is deprecated since Electron 30 — migrate to WebContentsView');
    }

    // ── Deprecated: ipcRenderer.sendTo ──
    if (IPC_RENDERER_SEND_TO_RE.test(source)) {
      result.edges!.push({
        source: filePath, target: 'sendTo',
        edgeType: 'electron_deprecated',
        metadata: { api: 'ipcRenderer.sendTo', message: 'Removed in Electron 28 — use MessageChannel' },
      });
      warnings.push('ipcRenderer.sendTo was removed in Electron 28 — use MessageChannel instead');
    }

    // ── Utility process ──
    for (const m of source.matchAll(UTILITY_FORK_RE)) {
      const modulePath = m[1] ?? m[2];
      result.frameworkRole = result.frameworkRole ?? 'electron_main';
      result.edges!.push({
        source: filePath, target: modulePath,
        edgeType: 'electron_utility_fork', metadata: { modulePath },
      });
    }

    // ── Parent port (inside utility process) ──
    if (PARENT_PORT_POST_RE.test(source) || PARENT_PORT_ON_RE.test(source)) {
      result.frameworkRole = 'electron_utility';
      result.edges!.push({
        source: filePath, target: 'parentPort',
        edgeType: 'electron_parent_port',
        metadata: {
          sends: PARENT_PORT_POST_RE.test(source),
          receives: PARENT_PORT_ON_RE.test(source),
        },
      });
    }

    // ── MessageChannelMain ──
    if (MESSAGE_CHANNEL_RE.test(source)) {
      result.edges!.push({
        source: filePath, target: 'MessageChannelMain',
        edgeType: 'electron_message_channel',
      });
    }

    // ── Protocol handlers ──
    for (const m of source.matchAll(PROTOCOL_HANDLE_RE)) {
      result.edges!.push({
        source: filePath, target: m[1],
        edgeType: 'electron_protocol_handle', metadata: { scheme: m[1] },
      });
    }

    // ── Menu / autoUpdater (structural metadata) ──
    if (MENU_BUILD_RE.test(source) || MENU_SET_APP_RE.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'electron_main';
      result.metadata = { ...result.metadata, hasMenu: true };
    }
    if (AUTO_UPDATER_RE.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'electron_main';
      result.metadata = { ...result.metadata, hasAutoUpdater: true };
    }

    if (warnings.length > 0) {
      result.warnings = warnings;
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    // Maps: channel → file that handles/listens
    const mainHandlers = new Map<string, { fileId: number; path: string }>();
    const mainListeners = new Map<string, { fileId: number; path: string }>();
    // Maps: channel → file that pushes from main
    const mainPushers = new Map<string, { fileId: number; path: string }>();

    const files = ctx.getAllFiles();

    // First pass: collect all main-process IPC endpoints
    for (const file of files) {
      if (!file.language || !['typescript', 'javascript'].includes(file.language)) continue;
      const source = ctx.readFile(file.path);
      if (!source || !ELECTRON_IMPORT_RE.test(source)) continue;

      for (const channel of [...extractChannels(source, IPC_MAIN_HANDLE_RE), ...extractChannels(source, IPC_MAIN_HANDLE_ONCE_RE)]) {
        mainHandlers.set(channel, { fileId: file.id, path: file.path });
      }
      for (const channel of [...extractChannels(source, IPC_MAIN_ON_RE), ...extractChannels(source, IPC_MAIN_ONCE_RE)]) {
        mainListeners.set(channel, { fileId: file.id, path: file.path });
      }
      for (const channel of [...extractChannels(source, WEBCONTENTS_SEND_RE), ...extractChannels(source, EVENT_SENDER_SEND_RE)]) {
        mainPushers.set(channel, { fileId: file.id, path: file.path });
      }
    }

    // Second pass: cross-reference renderer ↔ main
    for (const file of files) {
      if (!file.language || !['typescript', 'javascript'].includes(file.language)) continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      if (!ELECTRON_IMPORT_RE.test(source) && !PARENT_PORT_USAGE_RE.test(source)) continue;

      // Renderer invoke → main handle
      for (const channel of extractChannels(source, IPC_RENDERER_INVOKE_RE)) {
        const handler = mainHandlers.get(channel);
        if (handler) {
          edges.push({
            source: file.path, target: handler.path,
            edgeType: 'electron_ipc_invoke',
            metadata: { channel, resolution: 'cross_file' },
            resolution: 'ast_resolved',
          });
        }
      }

      // Renderer send/sendSync → main on
      for (const channel of [...extractChannels(source, IPC_RENDERER_SEND_RE), ...extractChannels(source, IPC_RENDERER_SEND_SYNC_RE)]) {
        const listener = mainListeners.get(channel);
        if (listener) {
          edges.push({
            source: file.path, target: listener.path,
            edgeType: 'electron_ipc_send',
            metadata: { channel, resolution: 'cross_file' },
            resolution: 'ast_resolved',
          });
        }
      }

      // Renderer on ← main webContents.send (reverse: main pushes to renderer)
      for (const channel of [...extractChannels(source, IPC_RENDERER_ON_RE), ...extractChannels(source, IPC_RENDERER_ONCE_RE)]) {
        const pusher = mainPushers.get(channel);
        if (pusher) {
          edges.push({
            source: pusher.path, target: file.path,
            edgeType: 'electron_webcontents_send',
            metadata: { channel, resolution: 'cross_file' },
            resolution: 'ast_resolved',
          });
        }
      }
    }

    return ok(edges);
  }
}
