import { app, ipcMain, dialog, shell, nativeImage } from 'electron';
import { exec, execFile, spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createTray, showMenuWindow } from './tray';

// SharedArrayBuffer needed for cosmos.gl workers. GPU compositing + Skia
// renderer are kept ON — disabling them forces a per-frame CPU readback of
// the WebGL canvas (proportional to CSS pixels), which tanked graph FPS
// from 60 to ~20 on full-window views. Re-enable the defensive flags only
// if GPU process crashes resurface.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

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
    title: 'Select project root',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// IPC: open file in default editor
ipcMain.handle('open-in-editor', async (_event, filePath: string) => {
  await shell.openPath(filePath);
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
import {
  getStatus as ollamaStatus,
  listInstalled as ollamaListInstalled,
  listRunning as ollamaListRunning,
  unloadModel as ollamaUnload,
  deleteModel as ollamaDelete,
  startDaemon as ollamaStart,
  stopDaemon as ollamaStop,
} from './ollama-control';

// IPC: restart daemon (kill old, create plist if needed, start new via launchd)
ipcMain.handle('restart-daemon', async () => {
  return restartDaemon();
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
    const https = require('https');
    const req = https.get(
      'https://registry.npmjs.org/trace-mcp/latest',
      { timeout: 10000, headers: { 'User-Agent': 'trace-mcp', Accept: 'application/json' } },
      (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200 || !data) {
            resolve({ status: res.statusCode });
            return;
          }
          try {
            const version = String(JSON.parse(data).version || '').replace(/^v/, '');
            resolve({ status: 200, version: version || undefined });
          } catch {
            resolve({ status: res.statusCode });
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
    const https = require('https');
    const headers: Record<string, string> = {
      'User-Agent': 'trace-mcp',
      Accept: 'application/vnd.github.v3+json',
    };
    if (updateCache.etag) headers['If-None-Match'] = updateCache.etag;

    const req = https.get(
      'https://api.github.com/repos/nikolai-vysotskyi/trace-mcp/releases/latest',
      { timeout: 10000, headers },
      (res: any) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          // Follow once.
          https
            .get(res.headers.location, { timeout: 10000, headers }, (res2: any) => {
              let d = '';
              res2.on('data', (c: string) => {
                d += c;
              });
              res2.on('end', () =>
                resolve({ status: res2.statusCode, body: d, etag: res2.headers.etag }),
              );
            })
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
          resolve({ status: res.statusCode, body: data, etag: res.headers.etag, resetAt }),
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

ipcMain.handle('check-for-update', async () => {
  const now = Date.now();
  const current = app.getVersion().replace(/^v/, '');

  // Try npm registry first — unauthenticated, no practical rate limit.
  try {
    const npm = await fetchLatestFromNpm();
    if (npm.status === 200 && npm.version) {
      updateCache.lastChecked = now;
      const available = cmpSemver(npm.version, current) > 0;
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
      const available = latest && cmpSemver(latest, current) > 0;
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
    return { available, current, latest, lastChecked: now };
  } catch (err) {
    return {
      available: false,
      current,
      lastChecked: updateCache.lastChecked,
      error: toUpdateErrorMessage(err),
    };
  }
});

// IPC: apply update (runs npm update -g trace-mcp, which triggers postinstall → app update)

// Resolve npm binary path. GUI-launched Electron inherits a minimal env from
// launchd / Finder — `process.env.SHELL -lc` runs a login-non-interactive
// shell that does NOT source `.zshrc`, so nvm/Herd-managed `npm` is invisible.
// We try, in order: interactive login shell (sources .zshrc/.bashrc),
// non-interactive login shell, then a scan of common nvm/Homebrew paths.
// Probes are constructed from a closed enum and process.env.SHELL only —
// never user input. Building the command string inside the helper rather
// than accepting it as a parameter avoids tripping the Semgrep
// "child_process from a function argument" pattern.
type NpmProbe = 'login-interactive' | 'login-noninteractive' | 'env-which';

function probeCommand(kind: NpmProbe, sh: string | undefined): string | null {
  if ((kind === 'login-interactive' || kind === 'login-noninteractive') && !sh) return null;
  switch (kind) {
    case 'login-interactive':
      return `${sh} -ilc 'command -v npm'`;
    case 'login-noninteractive':
      return `${sh} -lc 'command -v npm'`;
    case 'env-which':
      return `/usr/bin/env npm --version >/dev/null 2>&1 && /usr/bin/env which npm`;
  }
}

function runNpmProbe(kind: NpmProbe, timeoutMs = 30_000): Promise<string | null> {
  const sh = process.env.SHELL;
  const cmd = probeCommand(kind, sh);
  if (!cmd) return Promise.resolve(null);
  // cmd's input domain is closed (NpmProbe enum + process.env.SHELL),
  // so there is no injection vector here despite the shell exec.
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf-8', timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const line = (stdout ?? '').trim().split('\n').pop()?.trim() ?? '';
      resolve(line || null);
    });
  });
}

let cachedNpmBin: string | null | undefined;
async function resolveNpmBin(): Promise<string | null> {
  if (cachedNpmBin !== undefined) return cachedNpmBin;
  const sh = process.env.SHELL;
  const candidates: Array<() => Promise<string | null>> = [];
  if (sh) {
    // Interactive login first — sources .zshrc/.bashrc where nvm/Herd lives.
    candidates.push(() => runNpmProbe('login-interactive'));
    candidates.push(() => runNpmProbe('login-noninteractive'));
  }
  candidates.push(() => runNpmProbe('env-which'));
  for (const probe of candidates) {
    const found = await probe();
    if (found && fs.existsSync(found)) {
      cachedNpmBin = found;
      appendUpdateLog({ event: 'resolve-npm:found', npmBin: found });
      return found;
    }
  }
  // Filesystem scan — common nvm / Herd / Homebrew layouts.
  const home = os.homedir();
  const guesses = [
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    path.join(home, '.nvm/current/bin/npm'),
  ];
  // Scan latest Herd/nvm versions if present.
  for (const baseRel of [
    'Library/Application Support/Herd/config/nvm/versions/node',
    '.nvm/versions/node',
  ]) {
    const base = path.join(home, baseRel);
    try {
      const versions = fs.readdirSync(base).sort().reverse();
      for (const v of versions) guesses.push(path.join(base, v, 'bin', 'npm'));
    } catch {
      /* dir absent — skip */
    }
  }
  for (const g of guesses) {
    if (fs.existsSync(g)) {
      cachedNpmBin = g;
      appendUpdateLog({ event: 'resolve-npm:scan-found', npmBin: g });
      return g;
    }
  }
  appendUpdateLog({ event: 'resolve-npm:not-found', shell: sh ?? null, scanned: guesses });
  cachedNpmBin = null;
  return null;
}

async function resolveNpmRoot(): Promise<string | null> {
  const npmBin = await resolveNpmBin();
  if (!npmBin) return null;
  return new Promise((resolve) => {
    // execFile bypasses shell parsing — npmBin is a filesystem path that
    // could in theory contain a space or quote.
    execFile(
      npmBin,
      ['root', '-g'],
      { encoding: 'utf-8', timeout: 30_000 },
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

ipcMain.handle('apply-update', async () => {
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

  const npmRoot = await resolveNpmRoot();
  if (npmRoot) cleanStaleScratchDirs(npmRoot);

  const runOnce = () =>
    new Promise<{ err?: Error; stderr: string; stdout: string; code?: number; signal?: string }>(
      (resolve) => {
        const child = execFile(
          npmBin,
          npmArgs,
          { encoding: 'utf-8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
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
  appendUpdateLog({ event: 'apply-update:ok', pending: hasPendingUpdate() });
  return { ok: true, pending: hasPendingUpdate() };
});

// Pending update plumbing — postinstall stages a verified zip into ~/Applications/
// when it detects this app is running, so the swap can be deferred until exit.
const INSTALL_DIR = path.join(os.homedir(), 'Applications');
const PENDING_ZIP = path.join(INSTALL_DIR, '.trace-mcp-pending.zip');
const PENDING_VERSION = path.join(INSTALL_DIR, '.trace-mcp-pending-version');
// Bundled via electron-builder `extraResources` in production; falls back to the
// repo-root scripts dir when running from `npm run dev:electron`.
const APPLY_HELPER = app.isPackaged
  ? path.join(process.resourcesPath, 'scripts', 'apply-pending-update.mjs')
  : path.join(__dirname, '..', '..', '..', '..', 'scripts', 'apply-pending-update.mjs');

function hasPendingUpdate(): boolean {
  try {
    return fs.existsSync(PENDING_ZIP) && fs.existsSync(PENDING_VERSION);
  } catch {
    return false;
  }
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
  if (!hasPendingUpdate()) return { pending: false };
  let version: string | undefined;
  try {
    version = fs.readFileSync(PENDING_VERSION, 'utf-8').trim().replace(/^v/, '');
  } catch {}
  // Drop stale pending artefacts: when the bundle has already been swapped
  // (e.g. postinstall ran while the app wasn't running) the marker files
  // stick around and produce a zombie "Restart to install" banner for a
  // version we are already on.
  const current = app.getVersion().replace(/^v/, '');
  if (version && cmpSemver(version, current) <= 0) {
    clearPendingFiles();
    return { pending: false };
  }
  return { pending: true, version };
});

// IPC: restart the app. If a staged update is waiting, spawn a detached helper
// that swaps the bundle once this process exits, then relaunches the new app.
ipcMain.handle('restart-app', () => {
  if (hasPendingUpdate() && fs.existsSync(APPLY_HELPER)) {
    try {
      const child = spawn(process.execPath, [APPLY_HELPER, String(process.pid)], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      child.unref();
      console.error(`[trace-mcp] spawned apply-pending-update helper pid=${child.pid}`);
      app.exit(0);
      return;
    } catch (err) {
      console.error(
        `[trace-mcp] spawn apply-pending-update failed, falling back to relaunch:`,
        err,
      );
    }
  }
  app.relaunch();
  app.exit(0);
});

app.whenReady().then(() => {
  // macOS: set custom dock icon so it's ready when the window shows.
  if (process.platform === 'darwin' && fs.existsSync(dockIconPath)) {
    app.dock?.setIcon(nativeImage.createFromPath(dockIconPath));
  }
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
