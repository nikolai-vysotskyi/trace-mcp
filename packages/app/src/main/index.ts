import { app, ipcMain, dialog, shell, nativeImage } from 'electron';
import { execFile, spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { t } from './i18n';
import { registerAppMenu } from './menu';
import { ACCESSORY_APP, createTray, restoreAppearance, showMenuWindow } from './tray';
import {
  hasPendingUpdate as hasPendingUpdateImpl,
  trySpawnApplyHelper as trySpawnApplyHelperImpl,
} from './apply-pending-helper';
import { updateChannelFor } from './update-channel';

// Exactly one update mechanism per platform — see update-channel.ts for why
// macOS cannot use electron-updater and Windows can. Every update code path
// below branches on this constant and nothing else.
const UPDATE_CHANNEL = updateChannelFor(process.platform);

// SharedArrayBuffer needed for cosmos.gl workers. GPU compositing + Skia
// renderer are kept ON — disabling them forces a per-frame CPU readback of
// the WebGL canvas (proportional to CSS pixels), which tanked graph FPS
// from 60 to ~20 on full-window views. Re-enable the defensive flags only
// if GPU process crashes resurface.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// A development or capture run must not become the active application: launching
// a regular app activates it, and macOS follows that to the app's Space, pulling
// whoever is at the keyboard out of what they were in. Accessory policy keeps the
// process out of the Dock and out of ⌘-Tab — and it is set here, before `ready`,
// because by the time the first window exists the activation has already
// happened (TRA-403). A shipped build is never accessory; see window-mode.ts.
// Guarded on darwin because `setActivationPolicy` is a macOS-only method — it
// does not exist on the Windows/Linux `app` object, and since TRA-407 made
// ACCESSORY_APP true for *every* unpackaged build, an unguarded call would
// throw on the first line of every `electron .` run off macOS.
if (ACCESSORY_APP && process.platform === 'darwin') app.setActivationPolicy('accessory');

// Prevent multiple instances. If a second launch happens, bring the existing
// window forward instead of letting the new process die silently.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMenuWindow();
  });
}

app.name = 'trace-mcp';

const dockIconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');

// IPC: folder picker
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: t('menu:selectProjectRoot'),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// IPC: open file in default editor
ipcMain.handle('open-in-editor', async (_event, filePath: string) => {
  await shell.openPath(filePath);
});

// IPC: open URL in the user's default external browser. Using shell.openExternal
// (instead of window.open in the renderer) keeps users out of an Electron-spawned
// in-app window where they aren't logged into GitHub and would otherwise be
// asked to authenticate again.
ipcMain.handle('open-external', async (_event, url: string) => {
  if (typeof url !== 'string') return { ok: false, error: 'invalid url' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) urls allowed' };
  await shell.openExternal(url);
  return { ok: true };
});

// IPC: detect installed IDEs (macOS-first; Windows/Linux return []).
// Scans /Applications and ~/Applications for well-known IDE .app bundles.
ipcMain.handle('detect-ide-apps', async () => {
  if (process.platform !== 'darwin') return [];
  const candidates: { id: string; name: string; bundles: string[] }[] = [
    { id: 'cursor', name: 'Cursor', bundles: ['Cursor.app'] },
    {
      id: 'vscode',
      name: 'VS Code',
      bundles: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'],
    },
    { id: 'zed', name: 'Zed', bundles: ['Zed.app'] },
    { id: 'phpstorm', name: 'PhpStorm', bundles: ['PhpStorm.app'] },
    { id: 'webstorm', name: 'WebStorm', bundles: ['WebStorm.app'] },
    {
      id: 'pycharm',
      name: 'PyCharm',
      bundles: [
        'PyCharm.app',
        'PyCharm Professional Edition.app',
        'PyCharm CE.app',
        'PyCharm Community Edition.app',
      ],
    },
    {
      id: 'intellij',
      name: 'IntelliJ IDEA',
      bundles: [
        'IntelliJ IDEA.app',
        'IntelliJ IDEA Ultimate.app',
        'IntelliJ IDEA CE.app',
        'IntelliJ IDEA Community Edition.app',
      ],
    },
    { id: 'goland', name: 'GoLand', bundles: ['GoLand.app'] },
    { id: 'rubymine', name: 'RubyMine', bundles: ['RubyMine.app'] },
    { id: 'rider', name: 'Rider', bundles: ['Rider.app'] },
    { id: 'clion', name: 'CLion', bundles: ['CLion.app'] },
    { id: 'fleet', name: 'Fleet', bundles: ['Fleet.app'] },
  ];
  const roots = [
    '/Applications',
    path.join(os.homedir(), 'Applications'),
    path.join(os.homedir(), 'Applications', 'JetBrains Toolbox'),
  ];
  const installed: { id: string; name: string; bundlePath: string }[] = [];
  for (const c of candidates) {
    for (const b of c.bundles) {
      let found: string | null = null;
      for (const r of roots) {
        const p = path.join(r, b);
        if (fs.existsSync(p)) {
          found = p;
          break;
        }
      }
      if (found) {
        installed.push({ id: c.id, name: c.name, bundlePath: found });
        break;
      }
    }
  }
  return installed;
});

// IPC: open a specific file in a chosen IDE via `open -a <bundle> <file>`.
ipcMain.handle('open-in-ide', async (_event, bundlePath: string, filePath: string) => {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'open-in-ide currently supported on macOS only' };
  }
  return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const child = spawn('open', ['-a', bundlePath, filePath], { detached: true, stdio: 'ignore' });
    let settled = false;
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: err.message });
      }
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        resolve(code === 0 ? { ok: true } : { ok: false, error: `open exited with code ${code}` });
      }
    });
    child.unref();
  });
});

import { restartDaemon } from './daemon-lifecycle';
import { isPlausibleInstallPath } from './install-path';
import {
  deleteModel as ollamaDelete,
  listInstalled as ollamaListInstalled,
  listRunning as ollamaListRunning,
  startDaemon as ollamaStart,
  getStatus as ollamaStatus,
  stopDaemon as ollamaStop,
  unloadModel as ollamaUnload,
} from './ollama-control';
import {
  computeUpdateOutcome,
  findStaleRoots,
  type GlobalInstall,
  isStuckOnVersion,
  readAppUpdateState,
  readLauncherCliPath,
  scanGlobalInstalls,
  shouldAttemptRepair,
  staleRootInUse,
  type UpdateOutcome,
  writeAppUpdateState,
} from './update-state';

// IPC: restart daemon (kill old, create plist if needed, start new via launchd)
ipcMain.handle('restart-daemon', async () => {
  return restartDaemon();
});

// IPC: trace-mcp guard control (status read + per-project mode toggle + bypass).
// Status JSON is written by the trace-mcp server (src/server/heartbeat.ts).
// Mode is persisted in <projectRoot>/.trace-mcp/guard-mode and read by the hook.
ipcMain.handle('guard:status', async (_e, projectRoot: string) => {
  const { getGuardStatus } = await import('./guard-control.js');
  return getGuardStatus(projectRoot);
});
ipcMain.handle('guard:set-mode', async (_e, projectRoot: string, mode: string) => {
  const { setGuardMode } = await import('./guard-control.js');
  if (mode !== 'strict' && mode !== 'coach' && mode !== 'off') {
    return { ok: false, error: `invalid mode: ${mode}` };
  }
  try {
    setGuardMode(projectRoot, mode);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});
ipcMain.handle('guard:install-status', async () => {
  const { checkInstallStatus } = await import('./guard-control.js');
  return checkInstallStatus();
});
ipcMain.handle('guard:install', async () => {
  const { installHook, resolveHookSourceScript } = await import('./guard-control.js');
  const sourceScript = resolveHookSourceScript();
  if (!sourceScript) {
    return {
      ok: false,
      error:
        'Could not locate the trace-mcp guard hook script. Install the CLI (npm install -g trace-mcp) or set TRACE_MCP_HOOK_SCRIPT to its absolute path.',
    };
  }
  return installHook({ sourceScript });
});
ipcMain.handle('guard:uninstall', async () => {
  const { uninstallHook } = await import('./guard-control.js');
  return uninstallHook();
});
ipcMain.handle('guard:check-cli-version', async () => {
  const { checkCliVersion } = await import('./guard-control.js');
  return checkCliVersion();
});
ipcMain.handle('guard:initialize', async (_e, projectRoot: string) => {
  const { initializeGuard } = await import('./guard-control.js');
  try {
    return initializeGuard(projectRoot);
  } catch (e) {
    return { initialized: false, error: e instanceof Error ? e.message : String(e) };
  }
});
ipcMain.handle('guard:set-bypass', async (_e, projectRoot: string, minutes: number) => {
  const { setBypass } = await import('./guard-control.js');
  try {
    setBypass(projectRoot, minutes);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// IPC: Ollama control surface — HTTP status + model listing + daemon lifecycle.
// baseUrl is always passed from the renderer because users can repoint Ollama
// to a remote host in settings; we don't assume localhost here.
ipcMain.handle('ollama:status', async (_e, baseUrl?: string) => ollamaStatus(baseUrl));
ipcMain.handle('ollama:list-installed', async (_e, baseUrl?: string) =>
  ollamaListInstalled(baseUrl),
);
ipcMain.handle('ollama:list-running', async (_e, baseUrl?: string) => ollamaListRunning(baseUrl));
ipcMain.handle('ollama:unload', async (_e, name: string, baseUrl?: string) =>
  ollamaUnload(name, baseUrl),
);
ipcMain.handle('ollama:delete', async (_e, name: string, baseUrl?: string) =>
  ollamaDelete(name, baseUrl),
);
ipcMain.handle('ollama:start', async (_e, baseUrl?: string) => ollamaStart(baseUrl));
ipcMain.handle('ollama:stop', async (_e, baseUrl?: string) => ollamaStop(baseUrl));

// IPC: detect which MCP clients have trace-mcp configured
ipcMain.handle('detect-mcp-clients', async () => {
  const home = os.homedir();
  const platform = process.platform;

  type ClientName =
    | 'claude-code'
    | 'claw-code'
    | 'claude-desktop'
    | 'cursor'
    | 'windsurf'
    | 'continue'
    | 'junie'
    | 'jetbrains-ai'
    | 'codex';
  interface DetectedClient {
    name: ClientName;
    configPath: string;
    hasTraceMcp: boolean;
  }
  const clients: DetectedClient[] = [];

  const checkJson = (name: ClientName, configPath: string) => {
    if (!fs.existsSync(configPath)) return;
    try {
      const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const hasTraceMcp = !!content?.mcpServers?.['trace-mcp'];
      clients.push({ name, configPath, hasTraceMcp });
    } catch {
      clients.push({ name, configPath, hasTraceMcp: false });
    }
  };

  // Claude Code
  checkJson('claude-code', path.join(home, '.claude.json'));
  checkJson('claude-code', path.join(home, '.claude', 'settings.json'));

  // Claw Code
  checkJson('claw-code', path.join(home, '.claw', 'settings.json'));

  // Claude Desktop
  if (platform === 'darwin') {
    checkJson(
      'claude-desktop',
      path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    checkJson('claude-desktop', path.join(appData, 'Claude', 'claude_desktop_config.json'));
  }

  // Cursor
  checkJson('cursor', path.join(home, '.cursor', 'mcp.json'));

  // Windsurf
  checkJson('windsurf', path.join(home, '.windsurf', 'mcp.json'));

  // Continue
  checkJson('continue', path.join(home, '.continue', 'mcpServers', 'mcp.json'));

  // Junie
  checkJson('junie', path.join(home, '.junie', 'mcp', 'mcp.json'));

  // JetBrains AI Assistant
  {
    const jbConfigBase =
      platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'JetBrains')
        : platform === 'win32'
          ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'JetBrains')
          : path.join(home, '.config', 'JetBrains');
    if (fs.existsSync(jbConfigBase)) {
      try {
        const dirs = fs.readdirSync(jbConfigBase);
        for (const dir of dirs) {
          const mcpXml = path.join(jbConfigBase, dir, 'options', 'mcpServer.xml');
          if (fs.existsSync(mcpXml)) {
            clients.push({ name: 'jetbrains-ai', configPath: mcpXml, hasTraceMcp: false });
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Codex
  {
    const checkToml = (name: ClientName, tomlPath: string) => {
      if (!fs.existsSync(tomlPath)) return;
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        const hasTraceMcp = /\[mcp_servers\s*\.\s*["']?trace-mcp["']?\s*\]/.test(content);
        clients.push({ name, configPath: tomlPath, hasTraceMcp });
      } catch {
        clients.push({ name, configPath: tomlPath, hasTraceMcp: false });
      }
    };
    checkToml('codex', path.join(home, '.codex', 'config.toml'));
  }

  return clients;
});

// IPC: report the per-client config status (missing | up_to_date | stale | ...)
// produced by the CLI's `clients status --json` command. The renderer uses
// this to swap "Install" → "Update" when a managed field on disk drifts
// from what `trace-mcp init` would write today (e.g. an old entry is missing
// the `alwaysLoad` flag we now write for Claude Code).
ipcMain.handle('get-mcp-client-statuses', async (_event, scope: string = 'global') => {
  return new Promise<{
    ok: boolean;
    error?: string;
    statuses?: Array<{
      client: string;
      configPath: string | null;
      status: 'missing' | 'up_to_date' | 'stale' | 'unmanageable' | 'unknown';
      staleReason?: string;
    }>;
  }>((resolve) => {
    execFile(
      'trace-mcp',
      ['clients', 'status', '--json', '--scope', scope === 'project' ? 'project' : 'global'],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve({ ok: true, statuses: parsed.statuses ?? [] });
        } catch (e) {
          resolve({ ok: false, error: `Failed to parse CLI output: ${(e as Error).message}` });
        }
      },
    );
  });
});

// IPC: configure trace-mcp for a specific MCP client
// level: 'base' (CLAUDE.md only), 'standard' (+ hooks), 'max' (+ hooks + tweakcc)
ipcMain.handle(
  'configure-mcp-client',
  async (_event, clientName: string, level: string = 'base') => {
    // JetBrains AI uses IDE-internal XML config — cannot be configured from CLI
    if (clientName === 'jetbrains-ai') {
      return { ok: false, error: 'JetBrains AI Assistant must be configured manually in the IDE.' };
    }

    // Compose CLI flags based on enforcement level
    const flags = [`--mcp-client ${clientName}`, '--yes'];

    if (level === 'base') {
      flags.push('--skip-hooks');
    }
    // 'standard' and 'max' both install hooks (no --skip-hooks)
    // 'max' also installs tweakcc, but that's handled automatically by init
    // when no --skip-hooks is passed and tweakcc prompts are available

    // Non-Claude clients don't use hooks/tweakcc, always skip
    const claudeClients = new Set(['claude-code', 'claw-code', 'claude-desktop']);
    if (!claudeClients.has(clientName)) {
      flags.push('--skip-hooks');
    }

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      // Use execFile to avoid shell interpretation: flags like project paths
      // could contain whitespace or special chars and must not be evaluated.
      execFile(
        'trace-mcp',
        ['init', ...flags],
        {
          timeout: 30_000,
        },
        (error) => {
          if (error) {
            resolve({ ok: false, error: error.message });
          } else {
            resolve({ ok: true });
          }
        },
      );
    });
  },
);

// IPC: check for app update.
// Primary source is the npm registry (no auth, no practical rate limit — the package
// is published via release-please at the same time as the GitHub release). GitHub
// Releases API is used as a fallback only (60 req/hr unauthenticated, per IP).
const updateCache: {
  etag?: string;
  lastBody?: string;
  lastChecked?: number;
  rateLimitedUntil?: number;
} = {};

function cmpSemver(a: string, b: string): number {
  // Returns 1 if a > b, -1 if a < b, 0 if equal. Pre-release suffix (-rc.1) sorts lower.
  const norm = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-');
    return { parts: main.split('.').map((n) => Number(n) || 0), pre: pre || '' };
  };
  const A = norm(a);
  const B = norm(b);
  for (let i = 0; i < Math.max(A.parts.length, B.parts.length); i++) {
    const x = A.parts[i] || 0;
    const y = B.parts[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1; // 1.2.3 > 1.2.3-rc.1
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

function fetchLatestFromNpm(): Promise<{ status: number; version?: string }> {
  return new Promise((resolve, reject) => {
    const https = require('node:https') as typeof import('node:https');
    const req = https.get(
      'https://registry.npmjs.org/trace-mcp/latest',
      { timeout: 10000, headers: { 'User-Agent': 'trace-mcp', Accept: 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200 || !data) {
            resolve({ status: res.statusCode ?? 0 });
            return;
          }
          try {
            const version = String(JSON.parse(data).version || '').replace(/^v/, '');
            resolve({ status: 200, version: version || undefined });
          } catch {
            resolve({ status: res.statusCode ?? 0 });
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

const OFFLINE_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

function toUpdateErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code && OFFLINE_ERROR_CODES.has(code)) return 'offline';
  if ((err as Error)?.message === 'timeout') return 'offline';
  return (err as Error)?.message || 'unknown error';
}

function fetchLatestRelease(): Promise<{
  status: number;
  body?: string;
  etag?: string;
  resetAt?: number;
}> {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const headers: Record<string, string> = {
      'User-Agent': 'trace-mcp',
      Accept: 'application/vnd.github.v3+json',
    };
    if (updateCache.etag) headers['If-None-Match'] = updateCache.etag;

    const req = https.get(
      'https://api.github.com/repos/nikolai-vysotskyi/trace-mcp/releases/latest',
      { timeout: 10000, headers },
      (res: import('node:http').IncomingMessage) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          // Follow once.
          https
            .get(
              res.headers.location,
              { timeout: 10000, headers },
              (res2: import('node:http').IncomingMessage) => {
                let d = '';
                res2.on('data', (c: string) => {
                  d += c;
                });
                res2.on('end', () =>
                  resolve({ status: res2.statusCode ?? 0, body: d, etag: res2.headers.etag as string | undefined }),
                );
              },
            )
            .on('error', reject);
          return;
        }
        const remaining = Number(res.headers['x-ratelimit-remaining']);
        const resetAt = Number(res.headers['x-ratelimit-reset']) * 1000 || undefined;
        if (res.statusCode === 304) {
          resolve({ status: 304, etag: res.headers.etag, resetAt });
          return;
        }
        if (res.statusCode === 403 && remaining === 0) {
          resolve({ status: 403, resetAt });
          return;
        }
        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            etag: res.headers.etag as string | undefined,
            resetAt,
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

// --- Windows: electron-updater ---------------------------------------------
//
// NSIS + `latest.yml` on the GitHub release. Loaded lazily and only on the
// electron-updater channel so macOS never pulls the module in at all — the
// two mechanisms must never both be live in one process.
let winUpdateDownloaded = false;

async function getAutoUpdater() {
  if (UPDATE_CHANNEL !== 'electron-updater') {
    throw new Error(`electron-updater is not the update channel on ${process.platform}`);
  }
  const { autoUpdater } = await import('electron-updater');
  // Download only when the user asks: the renderer's Update button drives the
  // whole flow, so a silent background download would fight the UI's state.
  autoUpdater.autoDownload = false;
  // A downloaded update still installs if the user quits instead of pressing
  // Restart — same self-healing property the macOS before-quit hook gives us.
  autoUpdater.autoInstallOnAppQuit = true;
  return autoUpdater;
}

ipcMain.handle('check-for-update', async () => {
  const result = await checkForUpdate();
  // Divergence between global roots exists independently of whether an update
  // is available, so it rides along with every check rather than only after an
  // install. Empty on the normal single-root machine. `npm root -g` is folded
  // in because the user's own npm may own a root the static scan never guesses.
  const { configRoot, binRoot } = await resolveNpmRoots();
  const staleRoots = staleRootClientsUse(configRoot, binRoot);
  return staleRoots.length > 0 ? { ...result, staleRoots } : result;
});

async function checkForUpdate() {
  const now = Date.now();
  const current = app.getVersion().replace(/^v/, '');

  if (UPDATE_CHANNEL === 'electron-updater') {
    try {
      const updater = await getAutoUpdater();
      const result = await updater.checkForUpdates();
      const latest = result?.updateInfo?.version?.replace(/^v/, '');
      if (!latest) return { available: false, current, lastChecked: now };
      return { available: cmpSemver(latest, current) > 0, current, latest, lastChecked: now };
    } catch (err) {
      appendUpdateLog({
        event: 'check-for-update:electron-updater-failed',
        error: (err as Error)?.message ?? String(err),
      });
      return { available: false, current, lastChecked: now, error: toUpdateErrorMessage(err) };
    }
  }

  // Read the persisted "I tried npm-only" marker once. If the user already
  // clicked Update for exactly this (bundle, latest) pair and nothing on
  // disk has moved, we suppress the banner — clicking Update again will
  // produce the same npm-only outcome. The marker self-clears when the
  // registry advances or the bundle is manually reinstalled.
  const appUpdateState = readAppUpdateState();
  const suppressIfStuck = (latest: string | undefined) => {
    if (!latest) return false;
    return isStuckOnVersion(current, latest, appUpdateState, cmpSemver);
  };

  // Try npm registry first — unauthenticated, no practical rate limit.
  try {
    const npm = await fetchLatestFromNpm();
    if (npm.status === 200 && npm.version) {
      updateCache.lastChecked = now;
      const available = cmpSemver(npm.version, current) > 0;
      if (available && suppressIfStuck(npm.version)) {
        return { available: false, current, latest: npm.version, lastChecked: now, stuck: true };
      }
      return { available, current, latest: npm.version, lastChecked: now };
    }
  } catch {
    // Fall through to GitHub fallback below.
  }

  // Honour rate-limit reset time before hitting GitHub again.
  if (updateCache.rateLimitedUntil && now < updateCache.rateLimitedUntil) {
    const waitS = Math.ceil((updateCache.rateLimitedUntil - now) / 1000);
    return {
      available: false,
      current,
      lastChecked: updateCache.lastChecked,
      error: `rate limited (${waitS}s)`,
    };
  }

  try {
    const res = await fetchLatestRelease();

    if (res.status === 304 && updateCache.lastBody) {
      updateCache.lastChecked = now;
      const release = JSON.parse(updateCache.lastBody);
      const latest = String(release.tag_name || '').replace(/^v/, '');
      const available = Boolean(latest) && cmpSemver(latest, current) > 0;
      if (available && suppressIfStuck(latest)) {
        return { available: false, current, latest, lastChecked: now, stuck: true };
      }
      return { available, current, latest, lastChecked: now };
    }

    if (res.status === 403) {
      updateCache.rateLimitedUntil = res.resetAt || now + 60_000;
      return {
        available: false,
        current,
        lastChecked: updateCache.lastChecked,
        error: 'GitHub rate limit hit',
      };
    }

    if (res.status !== 200 || !res.body) {
      return {
        available: false,
        current,
        lastChecked: updateCache.lastChecked,
        error: `HTTP ${res.status}`,
      };
    }

    if (res.etag) updateCache.etag = res.etag;
    updateCache.lastBody = res.body;
    updateCache.lastChecked = now;

    const release = JSON.parse(res.body);
    if (!release.tag_name)
      return { available: false, current, lastChecked: now, error: 'no release tag' };

    const latest = String(release.tag_name).replace(/^v/, '');
    const available = cmpSemver(latest, current) > 0;
    if (available && suppressIfStuck(latest)) {
      return { available: false, current, latest, lastChecked: now, stuck: true };
    }
    return { available, current, latest, lastChecked: now };
  } catch (err) {
    return {
      available: false,
      current,
      lastChecked: updateCache.lastChecked,
      error: toUpdateErrorMessage(err),
    };
  }
}

// IPC: apply update (runs npm update -g trace-mcp, which triggers postinstall → app update)

// Resolve npm binary path. GUI-launched Electron inherits a minimal env
// from launchd / Finder — process.env.PATH does not include nvm/Herd
// versions of npm. We scan the filesystem for known Node managers and
// system layouts; this covers the vast majority of macOS/Linux setups
// without invoking a subshell (which would otherwise be needed to source
// .zshrc / .bashrc).
let cachedNpmBin: string | null | undefined;
function npmBinCandidates(): string[] {
  const home = os.homedir();
  const guesses: string[] = [
    // Homebrew (Apple Silicon and Intel)
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    // Linux system
    '/usr/bin/npm',
    // nvm convenience symlink
    path.join(home, '.nvm/current/bin/npm'),
    // Volta
    path.join(home, '.volta/bin/npm'),
    // pnpm-managed Node
    path.join(home, '.local/share/pnpm/npm'),
  ];
  // Scan latest version directories of common Node managers.
  const versionedBases = [
    // nvm
    path.join(home, '.nvm/versions/node'),
    // Herd
    path.join(home, 'Library/Application Support/Herd/config/nvm/versions/node'),
    // fnm
    path.join(home, 'Library/Application Support/fnm/node-versions'),
    path.join(home, '.local/share/fnm/node-versions'),
    // asdf
    path.join(home, '.asdf/installs/nodejs'),
  ];
  for (const base of versionedBases) {
    try {
      const versions = fs.readdirSync(base).sort().reverse();
      for (const v of versions) {
        guesses.push(path.join(base, v, 'bin', 'npm'));
        // asdf layout: <base>/<version>/.npm/bin/npm doesn't exist; skip.
      }
    } catch {
      /* dir absent — skip */
    }
  }
  return guesses;
}

/**
 * `<prefix>/lib/node_modules` for every global npm root we know how to find —
 * not just the one the resolved npm binary owns.
 *
 * Most come from `npmBinCandidates()`, but a runtime can ship a global root
 * whose npm binary we never look for (nothing resolves `npm` to it, so it was
 * never a candidate) and still be the root some client's PATH lands on. Those
 * are listed separately below.
 */
function globalRootCandidates(): string[] {
  const home = os.homedir();
  return [
    ...npmBinCandidates().map((npm) =>
      path.resolve(path.dirname(npm), '..', 'lib', 'node_modules'),
    ),
    // Bundled Node runtimes and prefix-style installs whose bin dir we do not
    // scan for npm, but which still hold their own global node_modules.
    path.join(home, '.hermes/node/lib/node_modules'),
    path.join(home, '.local/lib/node_modules'),
    '/usr/lib/node_modules',
  ];
}

/**
 * Global roots stuck on an older trace-mcp than the newest one on this machine.
 * `extraRoots` lets callers fold in a root we learned about at runtime (e.g.
 * `npm root -g`) that the static candidate scan would miss.
 */
function staleGlobalRoots(...extraRoots: (string | null | undefined)[]): GlobalInstall[] {
  return findStaleRoots(
    scanGlobalInstalls([...globalRootCandidates(), ...extraRoots]),
    cmpSemver,
  );
}

/**
 * The stale root MCP clients actually run out of, or null. A stale root nothing
 * resolves to changes nothing for the user, so it is not reported (TRA-377).
 */
function staleRootClientsUse(...extraRoots: (string | null | undefined)[]): GlobalInstall[] {
  const inUse = staleRootInUse(staleGlobalRoots(...extraRoots), readLauncherCliPath());
  return inUse ? [inUse] : [];
}

async function resolveNpmBin(): Promise<string | null> {
  if (cachedNpmBin !== undefined) return cachedNpmBin;
  const guesses = npmBinCandidates();
  // Prefer a node version that already has `trace-mcp` installed: when nvm
  // hosts multiple versions (e.g. v22 and v24) and only v22 has the global
  // package, picking the latest version's npm would install into a sibling
  // tree the user's PATH never resolves to — making the "successful" update
  // invisible. Sort npm candidates so any whose sibling `lib/node_modules/
  // trace-mcp` exists comes first.
  const hasTraceMcp = (npm: string): boolean => {
    try {
      // bin/npm → ../lib/node_modules/trace-mcp
      const root = path.resolve(path.dirname(npm), '..', 'lib', 'node_modules', 'trace-mcp');
      return fs.existsSync(root);
    } catch {
      return false;
    }
  };
  guesses.sort((a, b) => Number(hasTraceMcp(b)) - Number(hasTraceMcp(a)));
  for (const g of guesses) {
    if (fs.existsSync(g)) {
      cachedNpmBin = g;
      appendUpdateLog({ event: 'resolve-npm:scan-found', npmBin: g, hasTraceMcp: hasTraceMcp(g) });
      return g;
    }
  }
  appendUpdateLog({ event: 'resolve-npm:not-found', scanned: guesses });
  cachedNpmBin = null;
  return null;
}

// PATH that lets `env node` (used by npm postinstall shebangs) succeed: the
// dir containing the resolved npm binary always also contains `node`, so we
// prepend it. Without this, GUI-launched Electron's PATH is essentially just
// `/usr/bin:/bin` and shebanged scripts fail with `env: node: No such file
// or directory` even when npm itself runs.
function buildSpawnEnv(npmBin: string): NodeJS.ProcessEnv {
  const binDir = path.dirname(npmBin);
  const existingPath = process.env.PATH ?? '';
  return {
    ...process.env,
    PATH: existingPath ? `${binDir}${path.delimiter}${existingPath}` : binDir,
  };
}

/**
 * Global roots, in the order we trust them.
 *
 * `npm root -g` answers from npm's *config* (`prefix`, `.npmrc`, `NPM_CONFIG_*`),
 * which on a machine with several Node managers can point at a tree the binary
 * we invoke never writes to — one user had three different global roots, and
 * `readInstalledVersion` was reading a version from a root the install never
 * touched (TRA-357). So we also derive the root structurally from the invoked
 * binary (`bin/npm` → `../lib/node_modules`) and log any disagreement.
 */
async function resolveNpmRoots(): Promise<{ configRoot: string | null; binRoot: string | null }> {
  const npmBin = await resolveNpmBin();
  const configRoot = await resolveNpmRoot();
  const binRoot = npmBin
    ? path.resolve(path.dirname(npmBin), '..', 'lib', 'node_modules')
    : null;
  if (configRoot && binRoot && path.resolve(configRoot) !== binRoot) {
    appendUpdateLog({ event: 'npm-root:mismatch', npmBin, configRoot, binRoot });
  }
  return { configRoot, binRoot };
}

// `npm root -g` is a subprocess, and the 10-minute update poll now asks for it
// too. It is a fixed property of the resolved npm binary, so resolve it once.
let cachedNpmRoot: string | null | undefined;
async function resolveNpmRoot(): Promise<string | null> {
  if (cachedNpmRoot !== undefined) return cachedNpmRoot;
  const npmBin = await resolveNpmBin();
  if (!npmBin) {
    cachedNpmRoot = null;
    return null;
  }
  cachedNpmRoot = await new Promise<string | null>((resolve) => {
    // execFile bypasses shell parsing — npmBin is a filesystem path that
    // could in theory contain a space or quote.
    execFile(
      npmBin,
      ['root', '-g'],
      { encoding: 'utf-8', timeout: 30_000, env: buildSpawnEnv(npmBin) },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const line = (stdout ?? '').trim().split('\n').pop()?.trim() ?? '';
        resolve(line || null);
      },
    );
  });
  return cachedNpmRoot;
}

function forceRemove(p: string): boolean {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error(`[trace-mcp] failed to remove ${p}:`, err);
    return false;
  }
}

// Remove any `.trace-mcp-<rand>` scratch directories npm left behind from a
// prior interrupted install — they cause ENOTEMPTY on the next rename-swap.
function cleanStaleScratchDirs(npmRoot: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(npmRoot);
  } catch (err) {
    console.error(`[trace-mcp] cleanStaleScratchDirs: readdir ${npmRoot} failed:`, err);
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith('.trace-mcp-')) forceRemove(path.join(npmRoot, entry));
  }
}

// Extract the rename source/dest from npm's failure output. Works for both
// `npm error` (v10+) and the legacy `npm ERR!` prefix.
function parseNpmRenamePaths(stderr: string): { src?: string; dest?: string } {
  const src = stderr.match(/^npm (?:error|ERR!) path (.+)$/m)?.[1]?.trim();
  const dest = stderr.match(/^npm (?:error|ERR!) dest (.+)$/m)?.[1]?.trim();
  return { src, dest };
}

// Update flow uses ~/.trace-mcp/update.log for full audit trail — every
// `apply-update` attempt records command, exit code, full stdout/stderr. The
// renderer only sees a short summary, so the log is the place to look when a
// user reports "Update failed".
const UPDATE_LOG = path.join(os.homedir(), '.trace-mcp', 'update.log');

function appendUpdateLog(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(UPDATE_LOG), { recursive: true });
    fs.appendFileSync(
      UPDATE_LOG,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch {
    /* logging must never break the update */
  }
}

// --- Bundle self-location ---------------------------------------------------
//
// The updater scripts (postinstall-app.mjs, apply-pending-update.mjs) used to
// hard-code `~/Applications` and silently no-op for users whose .app lived in
// `/Applications` — the more common drag-install target. We now have a shared
// `scripts/locate-app.mjs` helper with a marker-file → mdfind → known-dirs
// chain, but it cannot be imported here directly (this file is compiled by
// tsc with `rootDir: src/main`, and scripts/ lives outside that root). So we
// reimplement the writer inline. Constants below intentionally mirror the
// helper's so a single grep across the repo finds all producers + consumers.

const APP_BUNDLE_ID = 'com.trace-mcp.app';
const APP_LOCATION_MARKER = path.join(
  os.homedir(),
  '.trace-mcp',
  'app-location.json',
);

/**
 * Walk up from `process.execPath` to the enclosing `.app` directory. Returns
 * null in development (electron's own Electron.app is not our bundle) and on
 * non-darwin. Caller is expected to fall back to the legacy `~/Applications`
 * convention only when this returns null AND we're forced into the packaged
 * code path — otherwise the legacy guess is the bug we're fixing.
 */
function deriveBundlePath(): string | null {
  if (process.platform !== 'darwin') return null;
  // `isPackaged` only rejects `dev:electron`. An electron-builder output under
  // `release/mac-arm64/` IS packaged, so a locally built bundle passed this
  // gate and got recorded as the install location (TRA-357) — the plausibility
  // filter below is what actually rejects it.
  if (!app.isPackaged) return null;
  let dir = path.dirname(process.execPath);
  for (let i = 0; i < 10 && dir && dir !== '/'; i++) {
    if (dir.endsWith('.app')) return isPlausibleInstallPath(dir) ? dir : null;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Persist the running bundle's path so the next npm-side postinstall picks
 * the right `INSTALL_DIR`. Written every startup (cheap, ~150 bytes) so a
 * user who moves the .app between launches self-heals on first run. Atomic
 * via rename — concurrent readers never see a half-written file.
 */
function writeAppLocationMarker(bundlePath: string): void {
  try {
    fs.mkdirSync(path.dirname(APP_LOCATION_MARKER), { recursive: true });
    const payload = {
      appPath: bundlePath,
      bundleId: APP_BUNDLE_ID,
      version: app.getVersion().replace(/^v/, ''),
      writtenAt: Date.now(),
    };
    const tmp = `${APP_LOCATION_MARKER}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, APP_LOCATION_MARKER);
    appendUpdateLog({ event: 'app-location:written', appPath: bundlePath });
  } catch (err) {
    appendUpdateLog({
      event: 'app-location:write-failed',
      error: (err as Error)?.message ?? String(err),
    });
  }
}

function readAppLocationMarker(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(APP_LOCATION_MARKER, 'utf-8'));
    return typeof parsed?.appPath === 'string' ? parsed.appPath : null;
  } catch {
    return null;
  }
}

function readVersionFromRoot(npmRoot: string | null): string | undefined {
  if (!npmRoot) return undefined;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(npmRoot, 'trace-mcp', 'package.json'), 'utf-8'),
    );
    const v = String(pkg.version || '').replace(/^v/, '');
    return v || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The version that actually landed on disk. Reads the config-reported root
 * first (that is where `npm install -g` writes), falling back to the root
 * derived from the invoked binary; disagreements are logged rather than
 * silently picked, because they mean the user's PATH may resolve to a
 * different trace-mcp than the one we just installed.
 */
function readInstalledVersion(roots: {
  configRoot: string | null;
  binRoot: string | null;
}): string | undefined {
  const fromConfig = readVersionFromRoot(roots.configRoot);
  const fromBin = readVersionFromRoot(roots.binRoot);
  if (fromConfig && fromBin && fromConfig !== fromBin) {
    appendUpdateLog({
      event: 'npm-root:version-mismatch',
      configRoot: roots.configRoot,
      configVersion: fromConfig,
      binRoot: roots.binRoot,
      binVersion: fromBin,
    });
  }
  return fromConfig ?? fromBin;
}

/**
 * Self-heal a bundle that the npm update could not replace.
 *
 * The only code path that downloads and stages the `.app` zip is the npm
 * package's own postinstall. When it runs during `npm install -g` it can fail
 * to find the real install (a poisoned location marker, an unwritable install
 * dir) and exits silently — the user's evidence for TRA-357 was five
 * consecutive `npm-only` outcomes across three major versions with
 * `pending:false` every time, and nothing ever retried.
 *
 * So we retry, deliberately: discard a marker that points at a build tree,
 * re-record the running bundle, check the install directory is writable, then
 * run the postinstall again out-of-band. Returns true when a swap-ready zip is
 * staged afterwards.
 */
let repairInFlight: Promise<boolean> | null = null;

async function repairStaleBundle(reason: string, roots?: {
  configRoot: string | null;
  binRoot: string | null;
}): Promise<boolean> {
  if (repairInFlight) return repairInFlight;
  repairInFlight = (async () => {
    try {
      if (process.platform !== 'darwin' || !app.isPackaged) return false;
      if (hasPendingUpdate()) return true;

      const resolved = roots ?? (await resolveNpmRoots());
      const installed = readInstalledVersion(resolved);
      const running = app.getVersion().replace(/^v/, '');
      if (!shouldAttemptRepair(installed, running, false, cmpSemver)) return false;

      // A marker pointing into a build tree makes the postinstall stage its
      // zip next to a throwaway bundle. Drop it and re-record the truth: the
      // bundle this process is running from.
      const marker = readAppLocationMarker();
      if (marker && !isPlausibleInstallPath(marker)) {
        try {
          fs.unlinkSync(APP_LOCATION_MARKER);
          appendUpdateLog({ event: 'app-location:discarded', appPath: marker });
        } catch {
          /* best-effort */
        }
      }
      if (BUNDLE_PATH) writeAppLocationMarker(BUNDLE_PATH);

      let writable = true;
      try {
        fs.accessSync(INSTALL_DIR, fs.constants.W_OK);
      } catch {
        writable = false;
      }
      if (!writable) {
        appendUpdateLog({ event: 'repair-bundle:not-writable', reason, installDir: INSTALL_DIR });
        return false;
      }

      const postinstall = resolved.configRoot
        ? path.join(resolved.configRoot, 'trace-mcp', 'scripts', 'postinstall-app.mjs')
        : null;
      const fallback = resolved.binRoot
        ? path.join(resolved.binRoot, 'trace-mcp', 'scripts', 'postinstall-app.mjs')
        : null;
      const script = [postinstall, fallback].find((p) => p && fs.existsSync(p)) ?? null;
      if (!script) {
        appendUpdateLog({ event: 'repair-bundle:no-postinstall', reason, roots: resolved });
        return false;
      }

      appendUpdateLog({ event: 'repair-bundle:start', reason, script, installed, running });
      await new Promise<void>((resolve) => {
        // ELECTRON_RUN_AS_NODE turns our own binary into a plain Node runtime,
        // so the helper runs without depending on a `node` being on PATH.
        execFile(
          process.execPath,
          [script],
          {
            encoding: 'utf-8',
            timeout: 600_000,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          },
          (err, stdout, stderr) => {
            appendUpdateLog({
              event: 'repair-bundle:postinstall-done',
              errMessage: err?.message ?? null,
              stdout: (stdout ?? '').slice(-2000),
              stderr: (stderr ?? '').slice(-2000),
            });
            resolve();
          },
        );
      });

      const staged = hasPendingUpdate();
      appendUpdateLog({ event: 'repair-bundle:result', reason, staged });
      if (staged) {
        // The half-update is over — stop suppressing the banner.
        const state = readAppUpdateState();
        if (state.lastNpmOnlyAttempt) {
          delete state.lastNpmOnlyAttempt;
          writeAppUpdateState(state);
        }
      }
      return staged;
    } catch (err) {
      appendUpdateLog({
        event: 'repair-bundle:error',
        reason,
        error: (err as Error)?.message ?? String(err),
      });
      return false;
    } finally {
      repairInFlight = null;
    }
  })();
  return repairInFlight;
}

ipcMain.handle('apply-update', async () => {
  if (UPDATE_CHANNEL === 'electron-updater') {
    // No npm involvement at all on Windows: electron-updater downloads the
    // NSIS installer described by latest.yml and runs it on quit/restart.
    try {
      const updater = await getAutoUpdater();
      // downloadUpdate() requires a check in this same process first.
      const check = await updater.checkForUpdates();
      const version = check?.updateInfo?.version?.replace(/^v/, '');
      await updater.downloadUpdate();
      winUpdateDownloaded = true;
      appendUpdateLog({ event: 'apply-update:electron-updater-downloaded', version });
      return { ok: true, pending: true, outcome: 'bundle-pending' as UpdateOutcome, version };
    } catch (err) {
      const summary = (err as Error)?.message ?? String(err);
      appendUpdateLog({ event: 'apply-update:electron-updater-failed', summary });
      return { ok: false, error: `${summary}\n\nFull log: ${UPDATE_LOG}` };
    }
  }

  // `install --force` is the robust swap: it replaces the package directory
  // wholesale rather than relying on `update`'s rename dance, which breaks when
  // the prior install left trace-mcp in a partially-extracted state.
  const npmBin = await resolveNpmBin();
  if (!npmBin) {
    const msg = `Could not locate \`npm\`. Looked in: SHELL profile, /opt/homebrew, /usr/local, nvm, Herd. Install Node/npm or add it to your login shell PATH.`;
    appendUpdateLog({ event: 'apply-update:no-npm' });
    return { ok: false, error: `${msg}\n\nFull log: ${UPDATE_LOG}` };
  }
  // Execute the resolved npm binary directly with execFile (no shell) so we
  // don't depend on PATH and avoid command-line injection if npmBin contains
  // unusual characters.
  const npmArgs = ['install', '-g', 'trace-mcp@latest', '--force'];

  const npmRoots = await resolveNpmRoots();
  const npmRoot = npmRoots.configRoot;
  if (npmRoot) cleanStaleScratchDirs(npmRoot);

  const spawnEnv = buildSpawnEnv(npmBin);
  const runOnce = () =>
    new Promise<{ err?: Error; stderr: string; stdout: string; code?: number; signal?: string }>(
      (resolve) => {
        const child = execFile(
          npmBin,
          npmArgs,
          { encoding: 'utf-8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024, env: spawnEnv },
          (err, stdout, stderr) => {
            resolve({
              err: err ?? undefined,
              stderr: stderr ?? '',
              stdout: stdout ?? '',
              code: child.exitCode ?? undefined,
              signal: child.signalCode ?? undefined,
            });
          },
        );
      },
    );

  appendUpdateLog({
    event: 'apply-update:start',
    cmd: `${npmBin} ${npmArgs.join(' ')}`,
    npmBin,
    npmRoot,
    shell: process.env.SHELL ?? null,
  });
  let result = await runOnce();
  appendUpdateLog({
    event: 'apply-update:attempt-1',
    code: result.code,
    signal: result.signal,
    errMessage: result.err?.message ?? null,
    stderr: result.stderr,
    stdout: result.stdout,
  });

  // ENOTEMPTY means the main `trace-mcp` dir or its scratch twin is in a
  // corrupt half-extracted state from a prior interrupted install. Parse the
  // rename paths directly from npm's error and nuke them before retrying —
  // this path works even when resolveNpmRoot() came back null (e.g. a
  // GUI-launched Electron whose login shell didn't put npm on PATH).
  const haystack = `${result.err?.message ?? ''}\n${result.stderr}`;
  if (result.err && /ENOTEMPTY/.test(haystack)) {
    const { src, dest } = parseNpmRenamePaths(haystack);
    const recoveredRoot = npmRoot ?? (src ? path.dirname(src) : dest ? path.dirname(dest) : null);
    appendUpdateLog({
      event: 'apply-update:enotempty-recovery',
      npmRoot,
      src,
      dest,
      recoveredRoot,
    });
    if (recoveredRoot) cleanStaleScratchDirs(recoveredRoot);
    if (src) forceRemove(src);
    if (dest) forceRemove(dest);
    if (recoveredRoot) forceRemove(path.join(recoveredRoot, 'trace-mcp'));
    result = await runOnce();
    appendUpdateLog({
      event: 'apply-update:attempt-2',
      code: result.code,
      signal: result.signal,
      errMessage: result.err?.message ?? null,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }

  if (result.err) {
    // Surface the most useful line from npm: prefer `npm error code`/
    // `npm error path` lines, fall back to the last few stderr lines. Always
    // tell the user where the full log lives.
    const stderrLines = result.stderr.trim().split('\n');
    const npmErrorLine = stderrLines.find((l) => /^npm (error|ERR!)/.test(l));
    const tail = stderrLines.slice(-5).join(' ').slice(-360);
    const summary = npmErrorLine || tail || result.err.message;
    appendUpdateLog({ event: 'apply-update:fail', summary });
    return {
      ok: false,
      error: `${summary}\n\nFull log: ${UPDATE_LOG}`,
    };
  }
  const installedVersion = readInstalledVersion(npmRoots);
  const running = app.getVersion().replace(/^v/, '');
  let outcome: UpdateOutcome = computeUpdateOutcome(
    installedVersion,
    running,
    hasPendingUpdate(),
    cmpSemver,
  );

  // The CLI moved but the bundle did not. Before telling the user that, try to
  // stage the bundle swap ourselves — the npm-side postinstall may have missed
  // the real install location entirely (TRA-357).
  if (outcome === 'npm-only' && (await repairStaleBundle('apply-update', npmRoots))) {
    outcome = 'bundle-pending';
  }

  const pending = outcome === 'bundle-pending';

  if (outcome === 'npm-only' && installedVersion) {
    // The CLI moved but the Electron bundle did not — npm install can't
    // swap /Applications/trace-mcp.app. Record the attempt so
    // check-for-update stops re-asking until the registry advances past
    // this target or the user manually reinstalls the .app.
    const state = readAppUpdateState();
    const previous = state.lastNpmOnlyAttempt;
    const repeat = previous?.bundle === running ? (previous.attempts ?? 1) + 1 : 1;
    state.lastNpmOnlyAttempt = {
      bundle: running,
      target: installedVersion,
      at: Date.now(),
      attempts: repeat,
    };
    writeAppUpdateState(state);
    appendUpdateLog({
      event: 'apply-update:npm-only-unresolved',
      bundle: running,
      target: installedVersion,
      attempts: repeat,
      installDir: INSTALL_DIR,
    });
  }

  // `npm install -g` writes into exactly one global root. On a machine with
  // several (nvm + Herd + a bundled runtime), the rest keep whatever version
  // they last received — and nothing else here would ever say so. The log keeps
  // every stale root (they are all useful when diagnosing an update); only the
  // one MCP clients actually run is worth surfacing in the UI (TRA-377).
  const allStaleRoots = staleGlobalRoots(npmRoot, npmRoots.binRoot);
  const staleRoots = staleRootInUse(allStaleRoots, readLauncherCliPath());

  appendUpdateLog({
    event: 'apply-update:ok',
    outcome,
    pending,
    installedVersion: installedVersion ?? null,
    runningVersion: running,
    staleRoots: allStaleRoots,
  });
  return {
    ok: true,
    pending,
    outcome,
    version: pending ? installedVersion : undefined,
    ...(staleRoots ? { staleRoots: [staleRoots] } : {}),
  };
});

// Pending update plumbing — postinstall stages a verified zip next to the
// installed .app so the swap can be deferred until exit. The install dir is
// derived from the running bundle (`process.execPath`-walked-to-.app) instead
// of the previously-hardcoded `~/Applications`, which silently missed users
// with the .app dragged into `/Applications`. Dev-mode falls back to
// `~/Applications` — the pending flow is unreachable there anyway because
// extraResources are only present in packaged builds.
const BUNDLE_PATH = deriveBundlePath();
const INSTALL_DIR = BUNDLE_PATH
  ? path.dirname(BUNDLE_PATH)
  : path.join(os.homedir(), 'Applications');
const PENDING_ZIP = path.join(INSTALL_DIR, '.trace-mcp-pending.zip');
const PENDING_VERSION = path.join(INSTALL_DIR, '.trace-mcp-pending-version');
// Bundled via electron-builder `extraResources` in production; falls back to the
// repo-root scripts dir when running from `npm run dev:electron`.
const APPLY_HELPER = app.isPackaged
  ? path.join(process.resourcesPath, 'scripts', 'apply-pending-update.mjs')
  : path.join(__dirname, '..', '..', '..', '..', 'scripts', 'apply-pending-update.mjs');

function hasPendingUpdate(): boolean {
  if (UPDATE_CHANNEL !== 'zip-staged') return false;
  return hasPendingUpdateImpl({ pendingZip: PENDING_ZIP, pendingVersion: PENDING_VERSION });
}

const PENDING_CHECKSUM = path.join(INSTALL_DIR, '.trace-mcp-pending.sha256');

function clearPendingFiles(): void {
  for (const p of [PENDING_ZIP, PENDING_CHECKSUM, PENDING_VERSION]) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
}

ipcMain.handle('check-pending-update', () => {
  // Windows: the pending state is whatever electron-updater has downloaded.
  if (UPDATE_CHANNEL === 'electron-updater') {
    return { pending: winUpdateDownloaded };
  }
  // Only the zip-staged path can actually swap the Electron bundle on
  // restart. The previous "npm-install path" branch claimed pending=true
  // whenever the on-disk package was ahead of the running process, but
  // relaunch cannot move the .app, so it produced an "Update to restart"
  // banner that did nothing and re-armed the update cycle on next start.
  if (hasPendingUpdate()) {
    let version: string | undefined;
    try {
      version = fs.readFileSync(PENDING_VERSION, 'utf-8').trim().replace(/^v/, '');
    } catch {}
    // Drop stale pending artefacts: when the bundle has already been swapped
    // (e.g. postinstall ran while the app wasn't running) the marker files
    // stick around and produce a zombie "Restart to install" banner for a
    // version we are already on.
    const current = app.getVersion().replace(/^v/, '');
    if (!version || cmpSemver(version, current) > 0) {
      return { pending: true, version };
    }
    clearPendingFiles();
  }
  return { pending: false };
});

function trySpawnApplyHelper(): boolean {
  return trySpawnApplyHelperImpl(
    { pendingZip: PENDING_ZIP, pendingVersion: PENDING_VERSION, applyHelper: APPLY_HELPER },
    process.pid,
    UPDATE_CHANNEL,
  );
}

// IPC: restart the app. If a staged update is waiting, apply it; otherwise
// just relaunch.
ipcMain.handle('restart-app', async () => {
  // Windows: hand the exit to electron-updater, which runs the downloaded
  // NSIS installer and relaunches the new build itself.
  if (UPDATE_CHANNEL === 'electron-updater' && winUpdateDownloaded) {
    const updater = await getAutoUpdater();
    updater.quitAndInstall();
    return;
  }
  if (trySpawnApplyHelper()) {
    app.exit(0);
    return;
  }
  app.relaunch();
  app.exit(0);
});

// This is a tray app that keeps running when its window is closed, so the
// only ways users actually exit are the tray's "Quit" item and Cmd+Q — both
// call app.quit() directly, never the restart-app IPC above. Without this
// hook, a staged update sits on disk forever because nothing ever applies
// it: the bundle stays stale no matter how many times "Update" is clicked.
// Apply on any quit path too, so quitting also self-heals a stale bundle.
app.on('before-quit', () => {
  trySpawnApplyHelper();
});

app.whenReady().then(() => {
  // Refresh the bundle-location marker so the npm-side postinstall + the
  // detached apply-pending-update helper read the actual install location
  // instead of guessing `~/Applications`. Cheap (~150 byte JSON write) and
  // best-effort — failures are logged to update.log but never surface.
  if (BUNDLE_PATH) writeAppLocationMarker(BUNDLE_PATH);
  // Users already trapped by TRA-357 cannot see it — the sidebar told them
  // they were up to date while the bundle sat months behind the CLI. Nothing
  // they can click fixes that, so recovery has to happen without being asked.
  // No-ops (one cheap version comparison) unless the bundle is actually stale.
  void repairStaleBundle('startup');
  // macOS: set custom dock icon so it's ready when the window shows.
  if (process.platform === 'darwin' && fs.existsSync(dockIconPath)) {
    app.dock?.setIcon(nativeImage.createFromPath(dockIconPath));
  }
  // The application menu carries every accelerator the app answers to —
  // install it before the first window so ⌘, / ⌘R / ⌘1 work on first paint.
  registerAppMenu();
  // Before the first window: its NSVisualEffectView and its backgroundColor are
  // both read from nativeTheme at construction, so the app's Appearance choice
  // has to reach the native layer first or the window opens in the wrong one.
  restoreAppearance();
  createTray();
  // Open the main window straight away — the tray remains for background control.
  // Users who close the window still have the tray; users who quit via ⌘Q shut down.
  showMenuWindow();
});

// macOS: when the user clicks the dock icon after closing all windows, re-open.
app.on('activate', () => {
  showMenuWindow();
});

// GPU process crash recovery — log and continue (Chromium auto-restarts GPU process)
app.on('child-process-gone', (_event, details) => {
  console.error(
    `[trace-mcp] child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
  );
  // GPU process crashes are recoverable — Chromium restarts it automatically.
  // Only quit if it's a repeated crash (reason=crashed means it was killed, not clean exit).
  // For utility/network service crashes, Chromium also handles restart internally.
});

app.on('render-process-gone', (_event, _webContents, details) => {
  console.error(`[trace-mcp] renderer gone: reason=${details.reason} exitCode=${details.exitCode}`);
  // Don't quit — windows handle their own recovery via webContents.reload()
});

app.on('window-all-closed', () => {
  // Keep running in tray even if all windows are closed
});
