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
 *
 * Edge model (Pass 2 / resolveEdges):
 *   - `extractNodes` only tags file `frameworkRole` + `metadata` (hasMenu/hasAutoUpdater)
 *     and surfaces migration warnings. It never emits edges, because at Pass 1 there
 *     is no file id or symbol table — an edge without a resolvable source/target is
 *     silently dropped by the edge resolver.
 *   - `resolveEdges` owns all edge emission. Every edge's SOURCE is the enclosing
 *     symbol (`sourceNodeType: 'symbol'`) when one exists, else the file node
 *     (`sourceNodeType: 'file'`). TARGETS are either real files (cross-file IPC
 *     renderer↔main via `targetNodeType: 'file'`) or virtual `electron-*::<name>`
 *     symbol ids for non-code targets (channels, schemes, preload APIs, window
 *     classes, deprecated APIs) — mirroring the `s3-bucket::<name>` convention.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok } from 'neverthrow';
import type { TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { type FileSymbol, findEnclosingSymbol, lineOfIndex } from '../../_shared/regex-edges.js';

// ── regex patterns ──────────────────────────────────────────────

// Main process IPC
const IPC_MAIN_HANDLE_RE = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
const IPC_MAIN_HANDLE_ONCE_RE = /ipcMain\.handleOnce\(\s*['"]([^'"]+)['"]/g;
const IPC_MAIN_ON_RE = /ipcMain\.on\(\s*['"]([^'"]+)['"]/g;
const IPC_MAIN_ONCE_RE = /ipcMain\.once\(\s*['"]([^'"]+)['"]/g;

// Renderer IPC
const IPC_RENDERER_INVOKE_RE = /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_SEND_RE = /ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_SEND_SYNC_RE = /ipcRenderer\.sendSync\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_SEND_TO_HOST_RE = /ipcRenderer\.sendToHost\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_ON_RE = /ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_ONCE_RE = /ipcRenderer\.once\(\s*['"]([^'"]+)['"]/g;
const IPC_RENDERER_POST_MSG_RE = /ipcRenderer\.postMessage\(\s*['"]([^'"]+)['"]/g;

// Deprecated: ipcRenderer.sendTo (removed Electron 28)
const IPC_RENDERER_SEND_TO_RE = /ipcRenderer\.sendTo\s*\(/g;

// Main → Renderer push
const WEBCONTENTS_SEND_RE = /\.webContents\.send\(\s*['"]([^'"]+)['"]/g;
const EVENT_SENDER_SEND_RE = /event\.sender\.send\(\s*['"]([^'"]+)['"]/g;
const WEBCONTENTS_POST_MSG_RE = /\.webContents\.postMessage\(\s*['"]([^'"]+)['"]/g;
const SENDER_FRAME_POST_MSG_RE = /event\.senderFrame\.postMessage\(\s*['"]([^'"]+)['"]/g;

// Frame-scoped IPC
const CONTENTS_IPC_ON_RE = /\.ipc\.on\(\s*['"]([^'"]+)['"]/g;
const CONTENTS_IPC_HANDLE_RE = /\.ipc\.handle\(\s*['"]([^'"]+)['"]/g;

// Context bridge
const CONTEXT_BRIDGE_RE = /contextBridge\.exposeInMainWorld\(\s*['"]([^'"]+)['"]/g;
const CONTEXT_BRIDGE_ISOLATED_RE = /contextBridge\.exposeInIsolatedWorld\s*\(/g;

// Window/View construction
const BROWSER_WINDOW_RE = /new\s+BrowserWindow\s*\(/g;
const WEB_CONTENTS_VIEW_RE = /new\s+WebContentsView\s*\(/g;
const BASE_WINDOW_RE = /new\s+BaseWindow\s*\(/g;
const BROWSER_VIEW_RE = /new\s+BrowserView\s*\(/g; // deprecated v30
const TRAY_RE = /new\s+Tray\s*\(/;

// Utility process
const UTILITY_FORK_RE = /utilityProcess\.fork\s*\(\s*(?:['"]([^'"]+)['"]|(\w+))/g;
const PARENT_PORT_POST_RE = /process\.parentPort\.postMessage\s*\(/;
const PARENT_PORT_ON_RE = /process\.parentPort\.on\(\s*['"]message['"]/;
const PARENT_PORT_ANY_RE = /process\.parentPort\.(?:postMessage|on)\s*\(/g;

// MessageChannel
const MESSAGE_CHANNEL_RE = /new\s+MessageChannelMain\s*\(/g;

// Protocol
const PROTOCOL_HANDLE_RE = /protocol\.handle\(\s*['"]([^'"]+)['"]/g;

// Menu
const MENU_BUILD_RE = /Menu\.buildFromTemplate\s*\(/;
const MENU_SET_APP_RE = /Menu\.setApplicationMenu\s*\(/;

// AutoUpdater
const AUTO_UPDATER_RE = /autoUpdater\.(setFeedURL|checkForUpdates|quitAndInstall|on)\s*\(/;

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

/** A resolved file entry from the ResolveContext. */
interface ResolvedFile {
  id: number;
  path: string;
  language: string | null;
}

/**
 * Build the resolver-recognized SOURCE fields for an edge anchored at
 * `matchIndex` inside `source`. Prefers the innermost enclosing symbol; falls
 * back to the file node so top-level `ipcMain.handle('ch', ...)` calls (which
 * have no enclosing symbol) still produce a resolvable edge.
 */
function edgeSource(
  file: ResolvedFile,
  symbols: FileSymbol[],
  source: string,
  matchIndex: number,
): { fields: Pick<RawEdge, 'sourceNodeType' | 'sourceRefId'>; line: number } {
  const line = lineOfIndex(source, matchIndex);
  const encl = findEnclosingSymbol(symbols, line);
  if (encl) {
    return { fields: { sourceNodeType: 'symbol', sourceRefId: encl.id }, line };
  }
  return { fields: { sourceNodeType: 'file', sourceRefId: file.id }, line };
}

/**
 * Iterate every match of a global regex whose capture group 1 is a channel/name
 * literal, invoking `emit` with the captured name and the byte index of the match.
 */
function forEachNamedMatch(
  source: string,
  re: RegExp,
  emit: (name: string, index: number) => void,
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1] != null) emit(m[1], m.index);
    // Guard against zero-length matches causing an infinite loop.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

/** Iterate every match of a global regex with no meaningful capture, by index. */
function forEachMatch(source: string, re: RegExp, emit: (index: number) => void): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    emit(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

// ── plugin ──────────────────────────────────────────────────────

export class ElectronPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'electron',
    version: '2.1.0',
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
        {
          name: 'electron_ipc_handle',
          category: 'electron',
          description: 'Main process IPC handler (ipcMain.handle/handleOnce)',
        },
        {
          name: 'electron_ipc_main_on',
          category: 'electron',
          description: 'Main process IPC listener (ipcMain.on/once)',
        },
        // Renderer IPC
        {
          name: 'electron_ipc_invoke',
          category: 'electron',
          description: 'Renderer invokes IPC channel (ipcRenderer.invoke)',
        },
        {
          name: 'electron_ipc_send',
          category: 'electron',
          description: 'Renderer sends IPC message (ipcRenderer.send/sendSync)',
        },
        {
          name: 'electron_ipc_send_sync',
          category: 'electron',
          description: 'Renderer synchronous IPC (ipcRenderer.sendSync)',
        },
        {
          name: 'electron_ipc_on',
          category: 'electron',
          description: 'Renderer listens to IPC channel (ipcRenderer.on/once)',
        },
        // Main→Renderer
        {
          name: 'electron_webcontents_send',
          category: 'electron',
          description: 'Main pushes to renderer (webContents.send/postMessage)',
        },
        // Preload
        {
          name: 'electron_preload_api',
          category: 'electron',
          description: 'Preload exposes API via contextBridge',
        },
        // Structure
        {
          name: 'electron_browser_window',
          category: 'electron',
          description: 'Creates a BrowserWindow/BaseWindow/WebContentsView',
        },
        // Utility process
        {
          name: 'electron_utility_fork',
          category: 'electron',
          description: 'Forks a utility process (file reference)',
        },
        {
          name: 'electron_parent_port',
          category: 'electron',
          description: 'Utility process ↔ parent communication',
        },
        // MessageChannel
        {
          name: 'electron_message_channel',
          category: 'electron',
          description: 'MessageChannelMain creation (port-based IPC)',
        },
        // Protocol
        {
          name: 'electron_protocol_handle',
          category: 'electron',
          description: 'Custom protocol handler (protocol.handle)',
        },
        // Deprecated
        {
          name: 'electron_deprecated',
          category: 'electron',
          description: 'Deprecated API usage (BrowserView, sendTo, etc.)',
        },
      ],
    };
  }

  /**
   * Pass 1: tag the file's `frameworkRole` and structural metadata. No edges are
   * emitted here — edge sources need file ids and the symbol table, which are only
   * available in Pass 2 (resolveEdges). See the module header for the rationale.
   */
  extractNodes(
    _filePath: string,
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

    const result: FileParseResult = { status: 'ok', symbols: [] };
    const warnings: string[] = [];

    // ── frameworkRole classification ──
    const mainIpc =
      extractChannels(source, IPC_MAIN_HANDLE_RE).length +
      extractChannels(source, IPC_MAIN_HANDLE_ONCE_RE).length +
      extractChannels(source, IPC_MAIN_ON_RE).length +
      extractChannels(source, IPC_MAIN_ONCE_RE).length;

    // `.test()` on a global regex mutates its lastIndex; use fresh non-global
    // copies so the shared module-level patterns stay stateless here.
    const hasPreload =
      new RegExp(CONTEXT_BRIDGE_RE.source).test(source) ||
      new RegExp(CONTEXT_BRIDGE_ISOLATED_RE.source).test(source);

    const hasRendererIpc =
      extractChannels(source, IPC_RENDERER_INVOKE_RE).length +
        extractChannels(source, IPC_RENDERER_SEND_RE).length +
        extractChannels(source, IPC_RENDERER_SEND_SYNC_RE).length +
        extractChannels(source, IPC_RENDERER_SEND_TO_HOST_RE).length +
        extractChannels(source, IPC_RENDERER_POST_MSG_RE).length +
        extractChannels(source, IPC_RENDERER_ON_RE).length +
        extractChannels(source, IPC_RENDERER_ONCE_RE).length >
      0;

    const hasUtility = PARENT_PORT_POST_RE.test(source) || PARENT_PORT_ON_RE.test(source);

    const hasMainStructure =
      new RegExp(BROWSER_WINDOW_RE.source).test(source) ||
      new RegExp(WEB_CONTENTS_VIEW_RE.source).test(source) ||
      new RegExp(BASE_WINDOW_RE.source).test(source) ||
      new RegExp(BROWSER_VIEW_RE.source).test(source) ||
      TRAY_RE.test(source) ||
      new RegExp(PROTOCOL_HANDLE_RE.source).test(source) ||
      extractChannels(source, WEBCONTENTS_SEND_RE).length +
        extractChannels(source, EVENT_SENDER_SEND_RE).length +
        extractChannels(source, WEBCONTENTS_POST_MSG_RE).length +
        extractChannels(source, SENDER_FRAME_POST_MSG_RE).length >
        0 ||
      MENU_BUILD_RE.test(source) ||
      MENU_SET_APP_RE.test(source) ||
      AUTO_UPDATER_RE.test(source);

    if (hasUtility) {
      result.frameworkRole = 'electron_utility';
    } else if (hasPreload) {
      result.frameworkRole = 'electron_preload';
    } else if (mainIpc > 0 || hasMainStructure) {
      result.frameworkRole = 'electron_main';
    } else if (hasRendererIpc) {
      result.frameworkRole = 'electron_renderer';
    }

    // ── structural metadata ──
    if (MENU_BUILD_RE.test(source) || MENU_SET_APP_RE.test(source)) {
      result.metadata = { ...result.metadata, hasMenu: true };
    }
    if (AUTO_UPDATER_RE.test(source)) {
      result.metadata = { ...result.metadata, hasAutoUpdater: true };
    }

    // ── migration warnings ──
    for (const channel of extractChannels(source, IPC_RENDERER_SEND_SYNC_RE)) {
      warnings.push(
        `sendSync('${channel}') blocks renderer — consider ipcRenderer.invoke() instead`,
      );
    }
    if (new RegExp(BROWSER_VIEW_RE.source).test(source)) {
      warnings.push('BrowserView is deprecated since Electron 30 — migrate to WebContentsView');
    }
    if (new RegExp(IPC_RENDERER_SEND_TO_RE.source).test(source)) {
      warnings.push('ipcRenderer.sendTo was removed in Electron 28 — use MessageChannel instead');
    }

    if (warnings.length > 0) {
      result.warnings = warnings;
    }

    return ok(result);
  }

  /**
   * Pass 2: emit all electron edges. Every edge carries a resolver-recognized
   * source (enclosing symbol, else file node) and target (virtual `electron-*::`
   * symbol id for non-code targets, or a real file node for cross-file IPC).
   */
  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    // Maps: channel → file that handles/listens/pushes (main process endpoints).
    const mainHandlers = new Map<string, { fileId: number; path: string }>();
    const mainListeners = new Map<string, { fileId: number; path: string }>();
    const mainPushers = new Map<string, { fileId: number; path: string }>();

    const files = ctx.getAllFiles();

    // First pass: collect all main-process IPC endpoints for cross-file resolution.
    for (const file of files) {
      if (!file.language || !['typescript', 'javascript'].includes(file.language)) continue;
      const source = ctx.readFile(file.path);
      if (!source || !ELECTRON_IMPORT_RE.test(source)) continue;

      for (const channel of [
        ...extractChannels(source, IPC_MAIN_HANDLE_RE),
        ...extractChannels(source, IPC_MAIN_HANDLE_ONCE_RE),
      ]) {
        mainHandlers.set(channel, { fileId: file.id, path: file.path });
      }
      for (const channel of [
        ...extractChannels(source, IPC_MAIN_ON_RE),
        ...extractChannels(source, IPC_MAIN_ONCE_RE),
      ]) {
        mainListeners.set(channel, { fileId: file.id, path: file.path });
      }
      for (const channel of [
        ...extractChannels(source, WEBCONTENTS_SEND_RE),
        ...extractChannels(source, EVENT_SENDER_SEND_RE),
      ]) {
        mainPushers.set(channel, { fileId: file.id, path: file.path });
      }
    }

    // Second pass: emit per-file edges (source-anchored) + cross-file IPC edges.
    for (const file of files) {
      if (!file.language || !['typescript', 'javascript'].includes(file.language)) continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      const hasElectronImport = ELECTRON_IMPORT_RE.test(source);
      const hasParentPort = PARENT_PORT_USAGE_RE.test(source);
      if (!hasElectronImport && !hasParentPort) continue;

      const symbols = ctx.getSymbolsByFile(file.id) as FileSymbol[];

      // Emit an edge anchored at `matchIndex`, with SOURCE = enclosing symbol or
      // file node, and TARGET = the given virtual symbol id.
      const emitVirtual = (
        matchIndex: number,
        edgeType: string,
        targetSymbolId: string,
        extraMeta: Record<string, unknown>,
      ) => {
        const { fields, line } = edgeSource(file, symbols, source, matchIndex);
        edges.push({
          edgeType,
          ...fields,
          targetSymbolId,
          metadata: { ...extraMeta, line, file: file.path },
          resolution: 'text_matched',
        });
      };

      if (hasElectronImport) {
        // ── Main process: ipcMain.handle / handleOnce / on / once ──
        forEachNamedMatch(source, IPC_MAIN_HANDLE_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_handle', `electron-channel::${channel}`, {
            channel,
            variant: 'handle',
          }),
        );
        forEachNamedMatch(source, IPC_MAIN_HANDLE_ONCE_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_handle', `electron-channel::${channel}`, {
            channel,
            variant: 'handleOnce',
          }),
        );
        forEachNamedMatch(source, IPC_MAIN_ON_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_main_on', `electron-channel::${channel}`, {
            channel,
            variant: 'on',
          }),
        );
        forEachNamedMatch(source, IPC_MAIN_ONCE_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_main_on', `electron-channel::${channel}`, {
            channel,
            variant: 'once',
          }),
        );

        // ── Frame-scoped IPC (.ipc.on / .ipc.handle) ──
        forEachNamedMatch(source, CONTENTS_IPC_ON_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_main_on', `electron-channel::${channel}`, {
            channel,
            variant: 'frame_scoped',
          }),
        );
        forEachNamedMatch(source, CONTENTS_IPC_HANDLE_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_handle', `electron-channel::${channel}`, {
            channel,
            variant: 'frame_scoped',
          }),
        );

        // ── Main → Renderer push: webContents.send / event.sender.send / postMessage ──
        forEachNamedMatch(source, WEBCONTENTS_SEND_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_webcontents_send', `electron-channel::${channel}`, {
            channel,
          }),
        );
        forEachNamedMatch(source, EVENT_SENDER_SEND_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_webcontents_send', `electron-channel::${channel}`, {
            channel,
          }),
        );
        forEachNamedMatch(source, WEBCONTENTS_POST_MSG_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_webcontents_send', `electron-channel::${channel}`, {
            channel,
          }),
        );
        forEachNamedMatch(source, SENDER_FRAME_POST_MSG_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_webcontents_send', `electron-channel::${channel}`, {
            channel,
          }),
        );

        // ── Renderer IPC: invoke / send / sendSync / sendToHost / postMessage / on / once ──
        forEachNamedMatch(source, IPC_RENDERER_INVOKE_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_invoke', `electron-channel::${channel}`, { channel }),
        );
        forEachNamedMatch(source, IPC_RENDERER_SEND_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_send', `electron-channel::${channel}`, { channel }),
        );
        forEachNamedMatch(source, IPC_RENDERER_SEND_SYNC_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_send_sync', `electron-channel::${channel}`, { channel }),
        );
        forEachNamedMatch(source, IPC_RENDERER_SEND_TO_HOST_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_send', `electron-channel::${channel}`, {
            channel,
            variant: 'sendToHost',
          }),
        );
        forEachNamedMatch(source, IPC_RENDERER_POST_MSG_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_send', `electron-channel::${channel}`, {
            channel,
            variant: 'postMessage',
          }),
        );
        forEachNamedMatch(source, IPC_RENDERER_ON_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_on', `electron-channel::${channel}`, { channel }),
        );
        forEachNamedMatch(source, IPC_RENDERER_ONCE_RE, (channel, idx) =>
          emitVirtual(idx, 'electron_ipc_on', `electron-channel::${channel}`, { channel }),
        );

        // ── Preload: contextBridge.exposeInMainWorld ──
        forEachNamedMatch(source, CONTEXT_BRIDGE_RE, (apiName, idx) =>
          emitVirtual(idx, 'electron_preload_api', `electron-preload::${apiName}`, { apiName }),
        );
        forEachMatch(source, CONTEXT_BRIDGE_ISOLATED_RE, (idx) =>
          emitVirtual(idx, 'electron_preload_api', 'electron-preload::isolatedWorld', {
            variant: 'isolatedWorld',
          }),
        );

        // ── Window / View construction ──
        forEachMatch(source, BROWSER_WINDOW_RE, (idx) =>
          emitVirtual(idx, 'electron_browser_window', 'electron-window::BrowserWindow', {
            type: 'BrowserWindow',
          }),
        );
        forEachMatch(source, WEB_CONTENTS_VIEW_RE, (idx) =>
          emitVirtual(idx, 'electron_browser_window', 'electron-window::WebContentsView', {
            type: 'WebContentsView',
          }),
        );
        forEachMatch(source, BASE_WINDOW_RE, (idx) =>
          emitVirtual(idx, 'electron_browser_window', 'electron-window::BaseWindow', {
            type: 'BaseWindow',
          }),
        );

        // ── Deprecated: BrowserView ──
        forEachMatch(source, BROWSER_VIEW_RE, (idx) =>
          emitVirtual(idx, 'electron_deprecated', 'electron-deprecated::BrowserView', {
            api: 'BrowserView',
            message: 'Deprecated in Electron 30 — use WebContentsView',
          }),
        );

        // ── Deprecated: ipcRenderer.sendTo ──
        forEachMatch(source, IPC_RENDERER_SEND_TO_RE, (idx) =>
          emitVirtual(idx, 'electron_deprecated', 'electron-deprecated::ipcRenderer.sendTo', {
            api: 'ipcRenderer.sendTo',
            message: 'Removed in Electron 28 — use MessageChannel',
          }),
        );

        // ── Utility process fork ──
        forEachMatch(source, UTILITY_FORK_RE, (idx) => {
          // Re-match this occurrence to capture the module path (group 1 literal
          // or group 2 identifier).
          const tail = source.slice(idx);
          const local = new RegExp(UTILITY_FORK_RE.source).exec(tail);
          const modulePath = local ? (local[1] ?? local[2]) : undefined;
          emitVirtual(idx, 'electron_utility_fork', `electron-module::${modulePath ?? 'unknown'}`, {
            modulePath,
          });
        });

        // ── MessageChannelMain ──
        forEachMatch(source, MESSAGE_CHANNEL_RE, (idx) =>
          emitVirtual(idx, 'electron_message_channel', 'electron-channel::MessageChannelMain', {}),
        );

        // ── Protocol handlers ──
        forEachNamedMatch(source, PROTOCOL_HANDLE_RE, (scheme, idx) =>
          emitVirtual(idx, 'electron_protocol_handle', `electron-protocol::${scheme}`, { scheme }),
        );
      }

      // ── Parent port (inside utility process; may lack electron import) ──
      if (PARENT_PORT_POST_RE.test(source) || PARENT_PORT_ON_RE.test(source)) {
        const first = new RegExp(PARENT_PORT_ANY_RE.source).exec(source);
        const idx = first ? first.index : 0;
        emitVirtual(idx, 'electron_parent_port', 'electron-channel::parentPort', {
          sends: PARENT_PORT_POST_RE.test(source),
          receives: PARENT_PORT_ON_RE.test(source),
        });
      }

      // ── Cross-file IPC resolution (source symbol/file → real target file) ──
      if (hasElectronImport) {
        // Renderer invoke → main handle
        forEachNamedMatch(source, IPC_RENDERER_INVOKE_RE, (channel, idx) => {
          const handler = mainHandlers.get(channel);
          if (!handler) return;
          const { fields, line } = edgeSource(file, symbols, source, idx);
          edges.push({
            edgeType: 'electron_ipc_invoke',
            ...fields,
            targetNodeType: 'file',
            targetRefId: handler.fileId,
            metadata: {
              channel,
              resolution: 'cross_file',
              line,
              file: file.path,
              targetFile: handler.path,
            },
            resolution: 'ast_resolved',
          });
        });

        // Renderer send / sendSync → main on
        for (const re of [IPC_RENDERER_SEND_RE, IPC_RENDERER_SEND_SYNC_RE]) {
          forEachNamedMatch(source, re, (channel, idx) => {
            const listener = mainListeners.get(channel);
            if (!listener) return;
            const { fields, line } = edgeSource(file, symbols, source, idx);
            edges.push({
              edgeType: 'electron_ipc_send',
              ...fields,
              targetNodeType: 'file',
              targetRefId: listener.fileId,
              metadata: {
                channel,
                resolution: 'cross_file',
                line,
                file: file.path,
                targetFile: listener.path,
              },
              resolution: 'ast_resolved',
            });
          });
        }

        // Renderer on/once ← main webContents.send (reverse: main pushes to renderer).
        // Source anchored in the PUSHER file, target = this renderer file.
        for (const re of [IPC_RENDERER_ON_RE, IPC_RENDERER_ONCE_RE]) {
          forEachNamedMatch(source, re, (channel) => {
            const pusher = mainPushers.get(channel);
            if (!pusher) return;
            // Anchor the source at the pusher's webContents.send match line.
            const pusherSource = ctx.readFile(pusher.path);
            const pusherSymbols = ctx.getSymbolsByFile(pusher.fileId) as FileSymbol[];
            let srcFields: Pick<RawEdge, 'sourceNodeType' | 'sourceRefId'> = {
              sourceNodeType: 'file',
              sourceRefId: pusher.fileId,
            };
            let srcLine: number | undefined;
            if (pusherSource) {
              const pushRe = new RegExp(
                `\\.webContents\\.send\\(\\s*['"]${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
              );
              const pm = pushRe.exec(pusherSource);
              if (pm) {
                const pusherFile: ResolvedFile = {
                  id: pusher.fileId,
                  path: pusher.path,
                  language: 'typescript',
                };
                const s = edgeSource(pusherFile, pusherSymbols, pusherSource, pm.index);
                srcFields = s.fields;
                srcLine = s.line;
              }
            }
            edges.push({
              edgeType: 'electron_webcontents_send',
              ...srcFields,
              targetNodeType: 'file',
              targetRefId: file.id,
              metadata: {
                channel,
                resolution: 'cross_file',
                line: srcLine,
                file: pusher.path,
                targetFile: file.path,
              },
              resolution: 'ast_resolved',
            });
          });
        }
      }
    }

    return ok(edges);
  }
}
