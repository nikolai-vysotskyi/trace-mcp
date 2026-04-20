/**
 * Ollama control surface exposed to the renderer via IPC.
 *
 * Two concerns, intentionally kept together because they're always used as a pair:
 *   1. HTTP against the Ollama REST API (http://host:11434) — status, listing,
 *      unloading loaded models, deleting installed models.
 *   2. Process control of the Ollama daemon itself — start/stop. Ollama ships
 *      through many channels (Ollama.app on macOS, Homebrew service, systemd
 *      unit on Linux, installer service on Windows, or a bare `ollama serve`),
 *      so start/stop has several fall-through strategies and best-effort
 *      semantics. We never force-kill; we always ask politely first.
 *
 * HTTP is cheap and deterministic, process control is not — surface the
 * distinction in the returned status shape so the UI can explain failures
 * instead of silently pretending the daemon is up.
 */

import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);
const execFileP = promisify(execFile);

const DEFAULT_BASE = 'http://localhost:11434';
const HTTP_TIMEOUT_MS = 3000;

function normalizeBase(url: string | undefined): string {
  const raw = (url ?? '').trim() || DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Status ───────────────────────────────────────────────────────────

export interface OllamaStatus {
  running: boolean;
  version?: string;
  baseUrl: string;
  error?: string;
}

export async function getStatus(baseUrl?: string): Promise<OllamaStatus> {
  const base = normalizeBase(baseUrl);
  try {
    const data = await httpJson<{ version?: string }>(`${base}/api/version`);
    return { running: true, version: data.version, baseUrl: base };
  } catch (err) {
    return { running: false, baseUrl: base, error: (err as Error).message };
  }
}

// ── Listing ──────────────────────────────────────────────────────────

export interface InstalledModel {
  name: string;
  size: number;         // bytes on disk
  modified_at?: string; // ISO
  digest?: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}

export interface RunningModel {
  name: string;
  size: number;           // total bytes loaded
  size_vram: number;      // bytes in VRAM
  expires_at?: string;    // ISO — when Ollama will unload on its own
  digest?: string;
  details?: InstalledModel['details'];
}

export async function listInstalled(baseUrl?: string): Promise<{ models: InstalledModel[] }> {
  const base = normalizeBase(baseUrl);
  try {
    const data = await httpJson<{ models?: InstalledModel[] }>(`${base}/api/tags`);
    return { models: data.models ?? [] };
  } catch {
    return { models: [] };
  }
}

export async function listRunning(baseUrl?: string): Promise<{ models: RunningModel[] }> {
  const base = normalizeBase(baseUrl);
  try {
    const data = await httpJson<{ models?: RunningModel[] }>(`${base}/api/ps`);
    return { models: data.models ?? [] };
  } catch {
    return { models: [] };
  }
}

// ── Model mutations ──────────────────────────────────────────────────

/** Unload a currently-loaded model by sending a zero-token generate with keep_alive: 0.
 *  This is the documented way to force-unload without restarting Ollama. */
export async function unloadModel(name: string, baseUrl?: string): Promise<{ ok: boolean; error?: string }> {
  const base = normalizeBase(baseUrl);
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, keep_alive: 0, prompt: '' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Drain the NDJSON body so the connection isn't held open.
    await res.text().catch(() => undefined);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function deleteModel(name: string, baseUrl?: string): Promise<{ ok: boolean; error?: string }> {
  const base = normalizeBase(baseUrl);
  try {
    const res = await fetch(`${base}/api/delete`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── Process control ──────────────────────────────────────────────────

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

async function which(bin: string): Promise<string | null> {
  try {
    const cmd = isWin ? `where ${bin}` : `command -v ${bin}`;
    const { stdout } = await execP(cmd);
    const line = stdout.split(/\r?\n/).find(Boolean);
    return line ? line.trim() : null;
  } catch {
    return null;
  }
}

/** Try to start Ollama. Order of attempts:
 *    1. macOS: launch Ollama.app (if installed) — this is the canonical way
 *       most macOS users have it installed, because the .app supervises the
 *       daemon and shows the menubar icon the user expects.
 *    2. Linux with systemd: `systemctl --user start ollama` then system scope.
 *    3. Fall-through: spawn `ollama serve` detached so it survives the app quitting.
 *
 *  After any successful attempt we poll /api/version for up to ~6s to
 *  confirm — returning ok:true without a health check would be a lie. */
export async function startDaemon(baseUrl?: string): Promise<{ ok: boolean; method?: string; error?: string }> {
  const base = normalizeBase(baseUrl);

  // If it's already up, nothing to do.
  const pre = await getStatus(base);
  if (pre.running) return { ok: true, method: 'already-running' };

  const attempts: Array<() => Promise<string | null>> = [];

  if (isMac) {
    attempts.push(async () => {
      try {
        await execFileP('open', ['-ga', 'Ollama']);
        return 'macos-app';
      } catch {
        return null;
      }
    });
  }

  if (!isWin && !isMac) {
    attempts.push(async () => {
      try {
        await execFileP('systemctl', ['--user', 'start', 'ollama']);
        return 'systemd-user';
      } catch {
        return null;
      }
    });
    attempts.push(async () => {
      try {
        await execFileP('systemctl', ['start', 'ollama']);
        return 'systemd-system';
      } catch {
        return null;
      }
    });
  }

  // Last-resort: spawn the binary directly.
  attempts.push(async () => {
    const bin = await which('ollama');
    if (!bin) return null;
    try {
      const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore' });
      child.unref();
      return 'spawn-ollama-serve';
    } catch {
      return null;
    }
  });

  let method: string | null = null;
  for (const attempt of attempts) {
    method = await attempt();
    if (method) break;
  }
  if (!method) return { ok: false, error: 'Ollama not installed or no launcher available' };

  // Health-check — up to ~6s with 300ms polls.
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    const s = await getStatus(base);
    if (s.running) return { ok: true, method };
  }
  return { ok: false, method, error: `${method} attempted but daemon did not become reachable on ${base}` };
}

/** Stop Ollama. Parallel fall-through to startDaemon:
 *    1. macOS: tell Ollama.app to quit (preserves user's install state).
 *    2. Linux systemd: systemctl stop.
 *    3. Fall-through: pkill the `ollama serve` process we (or anyone else)
 *       started. SIGTERM only — never SIGKILL here. If a user really needs
 *       to force-kill they can use Activity Monitor / `kill -9`. */
export async function stopDaemon(baseUrl?: string): Promise<{ ok: boolean; method?: string; error?: string }> {
  const base = normalizeBase(baseUrl);

  const attempts: Array<() => Promise<string | null>> = [];

  if (isMac) {
    attempts.push(async () => {
      try {
        await execFileP('osascript', ['-e', 'tell application "Ollama" to quit']);
        return 'macos-app-quit';
      } catch {
        return null;
      }
    });
  }

  if (!isWin && !isMac) {
    attempts.push(async () => {
      try {
        await execFileP('systemctl', ['--user', 'stop', 'ollama']);
        return 'systemd-user';
      } catch {
        return null;
      }
    });
    attempts.push(async () => {
      try {
        await execFileP('systemctl', ['stop', 'ollama']);
        return 'systemd-system';
      } catch {
        return null;
      }
    });
  }

  // Fall-through — pkill SIGTERM. On Windows we don't try to stop via
  // taskkill because Ollama there runs as a Windows service installed by
  // its own installer; killing it is the installer's problem.
  if (!isWin) {
    attempts.push(async () => {
      try {
        await execFileP('pkill', ['-TERM', '-f', 'ollama serve']);
        return 'pkill';
      } catch {
        return null;
      }
    });
  }

  let method: string | null = null;
  for (const attempt of attempts) {
    method = await attempt();
    if (method) break;
  }
  if (!method) return { ok: false, error: 'No stop method available on this platform' };

  // Confirm it actually went down — up to ~4s.
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 250));
    const s = await getStatus(base);
    if (!s.running) return { ok: true, method };
  }
  return { ok: false, method, error: `${method} attempted but daemon still reachable on ${base}` };
}
