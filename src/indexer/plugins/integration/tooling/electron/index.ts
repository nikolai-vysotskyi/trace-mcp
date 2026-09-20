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

// ── scope-aware channel-role cache (TRA-1729) ─────────────────────────

/**
 * Cross-file IPC roles a file plays per channel. Mirrors exactly the maps the
 * full scan builds (handle/listen/push) plus the renderer-side roles needed
 * to reconcile the reverse direction when a main-side file changes:
 * cached invokers/senders let a newly-appearing handler find the renderer
 * files that already invoke its channel without re-scanning the corpus.
 */
type ElectronRole = 'handle' | 'listen' | 'push' | 'invoke' | 'send' | 'on';

interface FileChannelRoles {
  handles: string[];
  listens: string[];
  pushes: string[];
  invokes: string[];
  sends: string[];
  ons: string[];
}

interface ElectronChannelCache {
  /** role → channel → paths of files playing it (paths as seen by this ctx). */
  byChannel: Record<ElectronRole, Map<string, Set<string>>>;
  /** path → roles it contributes (for eviction when the file changes). */
  byFile: Map<string, FileChannelRoles>;
}

function emptyCache(): ElectronChannelCache {
  return {
    byChannel: {
      handle: new Map(),
      listen: new Map(),
      push: new Map(),
      invoke: new Map(),
      send: new Map(),
      on: new Map(),
    },
    byFile: new Map(),
  };
}

/** Per-process cache keyed by ctx.rootPath. Entries are paths + channel
 * strings (small); file ids are resolved per call from getAllFiles so a
 * delete+re-add (which recycles rowids) can never misattribute an edge. */
const channelRoleCache = new Map<string, ElectronChannelCache>();
const MAX_CACHED_ROOTS = 50;

function getChannelCache(rootPath: string): ElectronChannelCache | undefined {
  const hit = channelRoleCache.get(rootPath);
  if (hit) {
    // LRU refresh.
    channelRoleCache.delete(rootPath);
    channelRoleCache.set(rootPath, hit);
  }
  return hit;
}

function setChannelCache(rootPath: string, cache: ElectronChannelCache): void {
  channelRoleCache.delete(rootPath);
  channelRoleCache.set(rootPath, cache);
  while (channelRoleCache.size > MAX_CACHED_ROOTS) {
    const oldest = channelRoleCache.keys().next();
    if (oldest.done) break;
    channelRoleCache.delete(oldest.value);
  }
}

function cacheAdd(
  cache: ElectronChannelCache,
  role: ElectronRole,
  channel: string,
  p: string,
): void {
  let set = cache.byChannel[role].get(channel);
  if (!set) {
    set = new Set();
    cache.byChannel[role].set(channel, set);
  }
  set.add(p);
}

function cacheAddFileRoles(cache: ElectronChannelCache, p: string, roles: FileChannelRoles): void {
  cache.byFile.set(p, roles);
  for (const c of roles.handles) cacheAdd(cache, 'handle', c, p);
  for (const c of roles.listens) cacheAdd(cache, 'listen', c, p);
  for (const c of roles.pushes) cacheAdd(cache, 'push', c, p);
  for (const c of roles.invokes) cacheAdd(cache, 'invoke', c, p);
  for (const c of roles.sends) cacheAdd(cache, 'send', c, p);
  for (const c of roles.ons) cacheAdd(cache, 'on', c, p);
}

function cacheEvictFile(cache: ElectronChannelCache, p: string): void {
  const roles = cache.byFile.get(p);
  if (!roles) return;
  cache.byFile.delete(p);
  const drop = (role: ElectronRole, channels: string[]) => {
    for (const c of channels) {
      const set = cache.byChannel[role].get(c);
      if (!set) continue;
      set.delete(p);
      if (set.size === 0) cache.byChannel[role].delete(c);
    }
  };
  drop('handle', roles.handles);
  drop('listen', roles.listens);
  drop('push', roles.pushes);
  drop('invoke', roles.invokes);
  drop('send', roles.sends);
  drop('on', roles.ons);
}

/** Drop entries for paths no longer indexed (deleted files). The pipeline
 * deletes a removed file's rows, but the file never appears in
 * changeScope.changedFileIds, so eviction-by-change would miss it. */
function cachePruneStalePaths(cache: ElectronChannelCache, live: Set<string>): void {
  for (const p of Array.from(cache.byFile.keys())) {
    if (!live.has(p)) cacheEvictFile(cache, p);
  }
}

/**
 * Scan one file's source for the channel roles the full pass maps. Gated on
 * the electron import exactly like the full pass's first scan, so cached
 * roles equal what a full scan would map — no more, no less.
 */
function scanChannelRoles(source: string): FileChannelRoles {
  const empty: FileChannelRoles = {
    handles: [],
    listens: [],
    pushes: [],
    invokes: [],
    sends: [],
    ons: [],
  };
  if (!ELECTRON_IMPORT_RE.test(source)) return empty;
  return {
    handles: [
      ...extractChannels(source, IPC_MAIN_HANDLE_RE),
      ...extractChannels(source, IPC_MAIN_HANDLE_ONCE_RE),
    ],
    listens: [
      ...extractChannels(source, IPC_MAIN_ON_RE),
      ...extractChannels(source, IPC_MAIN_ONCE_RE),
    ],
    pushes: [
      ...extractChannels(source, WEBCONTENTS_SEND_RE),
      ...extractChannels(source, EVENT_SENDER_SEND_RE),
    ],
    invokes: extractChannels(source, IPC_RENDERER_INVOKE_RE),
    sends: [
      ...extractChannels(source, IPC_RENDERER_SEND_RE),
      ...extractChannels(source, IPC_RENDERER_SEND_SYNC_RE),
    ],
    ons: [
      ...extractChannels(source, IPC_RENDERER_ON_RE),
      ...extractChannels(source, IPC_RENDERER_ONCE_RE),
    ],
  };
}

/**
 * Last path in `order` wins — mirrors the full scan's `Map.set` overwrite
 * while iterating the same getAllFiles() array. Order is the live array, so
 * scoped and full runs pick the same file for a channel handled twice.
 */
function pickLastPath(
  paths: Set<string> | undefined,
  order: Map<string, number>,
): string | undefined {
  if (!paths || paths.size === 0) return undefined;
  let best: string | undefined;
  let bestIdx = -1;
  for (const p of paths) {
    const idx = order.get(p) ?? -1;
    if (idx >= bestIdx) {
      best = p;
      bestIdx = idx;
    }
  }
  return best;
}

function isTsJsFile(file: { language: string | null }): boolean {
  return !!file.language && ['typescript', 'javascript'].includes(file.language);
}

/**
 * Test-only pass counters (TRA-1729): how many times the full vs scoped pass
 * ran in this process. Lets the parity test prove the scoped path actually
 * engages instead of silently falling back to full scans.
 */
const passStats = { scoped: 0, full: 0 };
export function __getElectronPassStats(): { scoped: number; full: number } {
  return { ...passStats };
}

// ── plugin ──────────────────────────────────────────────────────

export class ElectronPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'electron',
    version: '2.2.0',
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
   *
   * Scope-aware (TRA-1729): when the pipeline passes a non-empty changeScope
   * and this process has a warm channel-role cache for the root, only changed
   * files are scanned — cross-file maps come from the cache instead of a full
   * corpus scan. Unchanged files' edges persist untouched in the DB (the
   * pipeline deletes outgoing edges for changed files only), so re-emitting
   * just the changed files plus their cross-file counterparts yields the same
   * edge set as a full scan. Cold cache (fresh process) falls through to the
   * full pass, which rebuilds it.
   */
  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const scope = ctx.changeScope;
    if (scope && scope.changedFileIds.size > 0) {
      const cached = getChannelCache(ctx.rootPath);
      if (cached) {
        passStats.scoped += 1;
        return ok(this.resolveEdgesScoped(ctx, scope, cached));
      }
    }
    passStats.full += 1;
    return this.resolveEdgesFull(ctx);
  }

  /** Full-corpus pass: the historical behavior, unchanged. */
  private resolveEdgesFull(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    // Maps: channel → file that handles/listens/pushes (main process endpoints).
    const mainHandlers = new Map<string, { fileId: number; path: string }>();
    const mainListeners = new Map<string, { fileId: number; path: string }>();
    const mainPushers = new Map<string, { fileId: number; path: string }>();

    const files = ctx.getAllFiles();
    const cache = emptyCache();

    // First pass: collect all main-process IPC endpoints for cross-file resolution.
    for (const file of files) {
      if (!isTsJsFile(file)) continue;
      const source = ctx.readFile(file.path);
      if (!source || !ELECTRON_IMPORT_RE.test(source)) continue;

      // Single role scan feeds both the cross-file maps and the role cache —
      // same channels, same regexes as the historical per-map extraction.
      const roles = scanChannelRoles(source);
      for (const channel of roles.handles) {
        mainHandlers.set(channel, { fileId: file.id, path: file.path });
      }
      for (const channel of roles.listens) {
        mainListeners.set(channel, { fileId: file.id, path: file.path });
      }
      for (const channel of roles.pushes) {
        mainPushers.set(channel, { fileId: file.id, path: file.path });
      }
      cacheAddFileRoles(cache, file.path, roles);
    }
    setChannelCache(ctx.rootPath, cache);

    const maps = { handlers: mainHandlers, listeners: mainListeners, pushers: mainPushers };

    // Second pass: emit per-file edges (source-anchored) + cross-file IPC edges.
    this.emitFileEdges(ctx, files, maps, edges);

    return ok(edges);
  }

  /**
   * Second-pass emission shared verbatim by the full and scoped passes:
   * per-file virtual edges plus cross-file IPC resolution through `maps`.
   */
  private emitFileEdges(
    ctx: ResolveContext,
    files: ResolvedFile[],
    maps: ElectronEndpointMaps,
    edges: RawEdge[],
  ): void {
    for (const file of files) {
      if (!isTsJsFile(file)) continue;
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
          const handler = maps.handlers.get(channel);
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
            const listener = maps.listeners.get(channel);
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
            const pusher = maps.pushers.get(channel);
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
  }

  /**
   * Scoped pass (TRA-1729): re-emit only changed files plus the cross-file
   * counterparts a full scan would newly link to them. Unchanged files are
   * never read; their edges persist in the DB.
   *
   * Three phases: (1) evict changed files' stale roles and fresh-scan them
   * into the cache; (2) emit changed files exactly like the full pass, with
   * cross-file maps resolved through the cache in live file order (last
   * wins — the same rule as the full scan's Map.set overwrite); (3) reconcile
   * counterparts anchored in unchanged files: a changed handler/listener
   * pulls in the cached renderer files invoking/sending its channels, and a
   * changed pusher links the cached renderer files listening to its channels.
   * Each reconciliation is gated on this file being the same pick the full
   * scan would make, so the emitted set matches a full scan exactly.
   */
  private resolveEdgesScoped(
    ctx: ResolveContext,
    scope: { changedFileIds: ReadonlySet<number> },
    cache: ElectronChannelCache,
  ): RawEdge[] {
    const edges: RawEdge[] = [];
    const files = ctx.getAllFiles();
    const order = new Map<string, number>();
    const byPath = new Map<string, ResolvedFile>();
    files.forEach((f, i) => {
      order.set(f.path, i);
      byPath.set(f.path, f);
    });
    cachePruneStalePaths(cache, new Set(byPath.keys()));

    const changed = files.filter((f) => scope.changedFileIds.has(f.id) && isTsJsFile(f));
    if (changed.length === 0) return edges;

    // Phase 1: evict + fresh-scan changed files into the cache.
    const fresh = new Map<string, { roles: FileChannelRoles; source: string }>();
    for (const f of changed) {
      cacheEvictFile(cache, f.path);
      const source = ctx.readFile(f.path);
      if (!source) continue;
      const roles = scanChannelRoles(source);
      cacheAddFileRoles(cache, f.path, roles);
      fresh.set(f.path, { roles, source });
    }

    // Singleton cross-file maps through the cache (last in file order wins).
    const pick = (
      role: ElectronRole,
      channel: string,
    ): { fileId: number; path: string } | undefined => {
      const p = pickLastPath(cache.byChannel[role].get(channel), order);
      if (!p) return undefined;
      const f = byPath.get(p);
      return f ? { fileId: f.id, path: p } : undefined;
    };
    const maps: ElectronEndpointMaps = {
      handlers: new Map(),
      listeners: new Map(),
      pushers: new Map(),
    };
    const fill = (role: ElectronRole, out: Map<string, { fileId: number; path: string }>): void => {
      for (const channel of cache.byChannel[role].keys()) {
        const entry = pick(role, channel);
        if (entry) out.set(channel, entry);
      }
    };
    fill('handle', maps.handlers);
    fill('listen', maps.listeners);
    fill('push', maps.pushers);

    // Phase 2: changed files emit exactly like the full pass.
    this.emitFileEdges(ctx, changed, maps, edges);

    // Phase 3: counterparts anchored in unchanged files.
    const symbolsCache = new Map<number, FileSymbol[]>();
    const symbolsOf = (fileId: number): FileSymbol[] => {
      let s = symbolsCache.get(fileId);
      if (!s) {
        s = ctx.getSymbolsByFile(fileId) as FileSymbol[];
        symbolsCache.set(fileId, s);
      }
      return s;
    };
    for (const f of changed) {
      const fr = fresh.get(f.path);
      if (!fr) continue;
      // Changed handler → cached renderer files invoking its channels.
      for (const channel of new Set(fr.roles.handles)) {
        const handler = pick('handle', channel);
        if (!handler || handler.path !== f.path) continue;
        for (const rPath of cache.byChannel.invoke.get(channel) ?? []) {
          if (rPath === f.path || fresh.has(rPath)) continue;
          const rFile = byPath.get(rPath);
          const rSource = rFile && ctx.readFile(rPath);
          if (!rFile || !rSource) continue;
          emitInvokeToHandler(ctx, rFile, rSource, symbolsOf(rFile.id), channel, handler, edges);
        }
      }
      // Changed listener → cached renderer files sending its channels.
      for (const channel of new Set(fr.roles.listens)) {
        const listener = pick('listen', channel);
        if (!listener || listener.path !== f.path) continue;
        for (const rPath of cache.byChannel.send.get(channel) ?? []) {
          if (rPath === f.path || fresh.has(rPath)) continue;
          const rFile = byPath.get(rPath);
          const rSource = rFile && ctx.readFile(rPath);
          if (!rFile || !rSource) continue;
          emitSendToListener(ctx, rFile, rSource, symbolsOf(rFile.id), channel, listener, edges);
        }
      }
      // Changed pusher → cached renderer files listening to its channels,
      // anchored at this file (its source is in hand).
      for (const channel of new Set(fr.roles.pushes)) {
        const pusher = pick('push', channel);
        if (!pusher || pusher.path !== f.path) continue;
        for (const rPath of cache.byChannel.on.get(channel) ?? []) {
          if (rPath === f.path || fresh.has(rPath)) continue;
          const rFile = byPath.get(rPath);
          if (!rFile) continue;
          emitPushToRenderer(ctx, f, fr.source, symbolsOf(f.id), rFile, channel, edges);
        }
      }
    }
    return edges;
  }
}

// ── scoped-pass reconciliation helpers (TRA-1729) ────────────────────

/** channel → { fileId, path } for the three main-process endpoint kinds. */
interface ElectronEndpointMaps {
  handlers: Map<string, { fileId: number; path: string }>;
  listeners: Map<string, { fileId: number; path: string }>;
  pushers: Map<string, { fileId: number; path: string }>;
}

function escapeChannel(channel: string): string {
  return channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Emit renderer-invoke(channel) → handler edges for one unchanged renderer
 * file, filtered to a single channel. Mirrors the full pass's invoke block
 * (same edge type, metadata, anchoring) — only the channel filter is new.
 */
function emitInvokeToHandler(
  _ctx: ResolveContext,
  rFile: ResolvedFile,
  rSource: string,
  rSymbols: FileSymbol[],
  channel: string,
  handler: { fileId: number; path: string },
  edges: RawEdge[],
): void {
  void _ctx;
  forEachNamedMatch(rSource, IPC_RENDERER_INVOKE_RE, (c, idx) => {
    if (c !== channel) return;
    const { fields, line } = edgeSource(rFile, rSymbols, rSource, idx);
    edges.push({
      edgeType: 'electron_ipc_invoke',
      ...fields,
      targetNodeType: 'file',
      targetRefId: handler.fileId,
      metadata: {
        channel,
        resolution: 'cross_file',
        line,
        file: rFile.path,
        targetFile: handler.path,
      },
      resolution: 'ast_resolved',
    });
  });
}

/**
 * Emit renderer-send/sendSync(channel) → listener edges for one unchanged
 * renderer file, filtered to a single channel. Mirrors the full pass's
 * send block.
 */
function emitSendToListener(
  _ctx: ResolveContext,
  rFile: ResolvedFile,
  rSource: string,
  rSymbols: FileSymbol[],
  channel: string,
  listener: { fileId: number; path: string },
  edges: RawEdge[],
): void {
  void _ctx;
  for (const re of [IPC_RENDERER_SEND_RE, IPC_RENDERER_SEND_SYNC_RE]) {
    forEachNamedMatch(rSource, re, (c, idx) => {
      if (c !== channel) return;
      const { fields, line } = edgeSource(rFile, rSymbols, rSource, idx);
      edges.push({
        edgeType: 'electron_ipc_send',
        ...fields,
        targetNodeType: 'file',
        targetRefId: listener.fileId,
        metadata: {
          channel,
          resolution: 'cross_file',
          line,
          file: rFile.path,
          targetFile: listener.path,
        },
        resolution: 'ast_resolved',
      });
    });
  }
}

/**
 * Emit a pusher-anchored webContents.send(channel) → renderer-file edge.
 * Mirrors the full pass's reverse block, including its anchoring quirk (the
 * line is resolved through a `.webContents.send(` re-match; pushes via other
 * APIs fall back to a file-anchored source with no line).
 */
function emitPushToRenderer(
  _ctx: ResolveContext,
  pFile: ResolvedFile,
  pSource: string,
  pSymbols: FileSymbol[],
  rFile: ResolvedFile,
  channel: string,
  edges: RawEdge[],
): void {
  void _ctx;
  let srcFields: Pick<RawEdge, 'sourceNodeType' | 'sourceRefId'> = {
    sourceNodeType: 'file',
    sourceRefId: pFile.id,
  };
  let srcLine: number | undefined;
  const pushRe = new RegExp(`\\.webContents\\.send\\(\\s*['"]${escapeChannel(channel)}['"]`);
  const pm = pushRe.exec(pSource);
  if (pm) {
    const s = edgeSource(pFile, pSymbols, pSource, pm.index);
    srcFields = s.fields;
    srcLine = s.line;
  }
  edges.push({
    edgeType: 'electron_webcontents_send',
    ...srcFields,
    targetNodeType: 'file',
    targetRefId: rFile.id,
    metadata: {
      channel,
      resolution: 'cross_file',
      line: srcLine,
      file: pFile.path,
      targetFile: rFile.path,
    },
    resolution: 'ast_resolved',
  });
}
