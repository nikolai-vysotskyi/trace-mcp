/**
 * Anonymous, opt-out active-install ping.
 *
 * Separate from the observability bridge in `index.ts`/`otlp.ts`/`langfuse.ts`:
 * that bridge exports a *user's own* spans to a backend *they* configure. This
 * module reports back to the maintainer instead — a single daily event with
 * an anonymous install id, the trace-mcp version, Node major version,
 * platform, the country its timezone belongs to, the MCP client name (e.g.
 * "claude-code"), the model that client mostly drove, how many repositories
 * are indexed, whether this run is a new install or a version change, the
 * machine's class (arch, core count, whole GB of RAM, OS version), the tool
 * preset the session ran with and how many tools it advertised, two
 * aggregate counters since the previous ping (tool calls and estimated tokens
 * saved), and two more for daemon reliability (starts, and how many of those
 * followed a run that died without shutting down). Counts and names only: no
 * IP, no project paths,
 * file names, query content, per-tool or per-project breakdown, and nothing
 * that could identify a user or their code.
 *
 * Transport is GA4's Measurement Protocol (a plain HTTP POST to a Google
 * endpoint) rather than a self-hosted collector, so there's no backend to
 * run or maintain. TRACE_MCP_GA_MEASUREMENT_ID/TRACE_MCP_GA_API_SECRET
 * override at runtime; published builds fall back to credentials baked in
 * at build time via tsup's `define` (same mechanism as PKG_VERSION_INJECTED)
 * so installs report without per-user setup. Those baked-in credentials are
 * public by design — they ship as plaintext in the published bundle, and a
 * GA4 api_secret is write-only. The counts they produce are therefore
 * unauthenticated and inflatable; see SECURITY.md "Telemetry Credentials".
 * See README "Usage telemetry" for how to opt out (TRACE_MCP_TELEMETRY=off).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger.js';
import { loadPersistentSavings } from '../savings.js';
import { topModelLastDay } from './top-model.js';
import { countryForTimezone } from './tz-country.js';
import { TELEMETRY_STATE_PATH } from '../shared/paths.js';

declare const GA_MEASUREMENT_ID_INJECTED: string;
const GA_MEASUREMENT_ID_DEFAULT =
  typeof GA_MEASUREMENT_ID_INJECTED !== 'undefined' ? GA_MEASUREMENT_ID_INJECTED : '';
declare const GA_API_SECRET_INJECTED: string;
const GA_API_SECRET_DEFAULT =
  typeof GA_API_SECRET_INJECTED !== 'undefined' ? GA_API_SECRET_INJECTED : '';

interface TelemetryState {
  installId: string;
  /** UTC calendar date (YYYY-MM-DD) of the last successfully sent ping. */
  lastPingDate?: string;
  /** Cumulative totals at the last ping — the next ping reports the delta. */
  lastTokensSaved?: number;
  lastCalls?: number;
  /** MCP client name from the most recent `initialize` (e.g. "claude-code"). */
  client?: string;
  /** Version that sent the previous ping — the difference is the upgrade signal. */
  lastVersion?: string;
  /**
   * A daemon start that has not yet been matched by a graceful shutdown. Set
   * true when the daemon begins serving, false when it shuts down through its
   * SIGTERM/SIGINT handler. Finding it still true at the next start means the
   * previous run died without running a handler — SIGKILL, OS memory kill,
   * native crash, or power loss (TRA-671).
   */
  daemonRunning?: boolean;
  /** Daemon starts since the last ping. */
  daemonStarts?: number;
  /** Of those starts, how many found `daemonRunning` still true. */
  daemonUncleanStops?: number;
}

function isDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.TRACE_MCP_TELEMETRY?.trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return true;
  // A fresh container per job means a fresh install id: counting CI would
  // inflate "new installs" without adding a single user. Opt CI out entirely
  // rather than pay for a correction factor later.
  return env.CI === 'true' || env.CI === '1';
}

function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function loadOrCreateState(): TelemetryState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(TELEMETRY_STATE_PATH, 'utf8'),
    ) as Partial<TelemetryState>;
    if (parsed.installId)
      return {
        installId: parsed.installId,
        lastPingDate: parsed.lastPingDate,
        lastTokensSaved: parsed.lastTokensSaved,
        lastCalls: parsed.lastCalls,
        client: parsed.client,
        lastVersion: parsed.lastVersion,
        daemonRunning: parsed.daemonRunning,
        daemonStarts: parsed.daemonStarts,
        daemonUncleanStops: parsed.daemonUncleanStops,
      };
  } catch {
    // No state file yet (first run) or it's unreadable — start fresh below.
  }
  return { installId: randomUUID() };
}

function saveState(state: TelemetryState): void {
  fs.mkdirSync(path.dirname(TELEMETRY_STATE_PATH), { recursive: true });
  fs.writeFileSync(TELEMETRY_STATE_PATH, JSON.stringify(state), 'utf8');
}

export interface UsagePingOptions {
  version: string;
  /**
   * Tool preset this session resolved to (`minimal`, `dev`, `full`, …).
   * A preset name and a tool count are categorical and non-identifying, like
   * `version` and `client` beside them — but without them the 67-86% saving
   * measured in preset-surface-budget.test.ts stays a bench number, and the
   * silent `full` → `standard` default migration (TRA-538) is unobservable.
   */
  preset?: string;
  /**
   * Tools this session advertises in `tools/list` after preset filtering —
   * gated tools plus the ungated meta-tools, the same basis the budget test
   * measures. Not the same as the count the client finally sees: the
   * client-profile layer hides up to two more on the wire (TRA-513), and it
   * runs at the session boundary, after the handshake this ping precedes.
   *
   * Both fields are resolved where the surface is built, which on the daemon
   * path is the daemon — it re-reads `tools.preset` from the project config per
   * session, so a config-set preset is reported exactly, while a per-session
   * `TRACE_MCP_PRESET` override lives in the client's environment and is
   * invisible from there. `get_preset_info` already reports the same
   * server-side value, so this adds no new divergence.
   */
  toolsAdvertised?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  /** Injectable for tests; defaults to the on-disk cumulative savings file. */
  loadSavings?: typeof loadPersistentSavings;
}

/**
 * Remember which MCP client connected, for the next ping's `client` dimension.
 * Called from the `initialize` handler — the ping itself fires before any
 * client has spoken, so this lands one session later. Name only, no version,
 * no arguments: enough to tell Claude Code from Cursor, nothing more.
 */
export function recordUsagePingClient(name: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isDisabled(env)) return;
  try {
    const state = loadOrCreateState();
    if (state.client === name) return;
    saveState({ ...state, client: name });
  } catch (err) {
    logger.debug({ err }, 'telemetry.usage_ping_client_record_failed');
  }
}

/**
 * Count a daemon start, and the previous run's unclean death if there was one
 * (TRA-671).
 *
 * Everything we know about daemon reliability was measured on one developer's
 * machine: `daemon status` shows launchd's post-mortem and daemon.log shows the
 * restart history, but only to whoever opens them. This is the field-observable
 * half — two counts, no timestamps, no exit codes, no reasons, nothing about
 * which project or client was running. "How often does a daemon die without
 * shutting down" is answerable from that pair and from nothing we ship today.
 *
 * Deliberately not derived from a stale `daemon.pid`: `readDaemonPid()` unlinks
 * a file naming a dead process, and on the detached-spawn path (Windows/Linux)
 * `ensureDaemonGeneric` does exactly that before the new daemon boots — so the
 * evidence is routinely gone by the time the daemon could read it. This flag
 * lives in the telemetry state file, which nothing else touches.
 *
 * Best-effort: never throws, and a failed write costs one data point.
 */
export function recordDaemonStart(env: NodeJS.ProcessEnv = process.env): void {
  if (isDisabled(env)) return;
  try {
    const state = loadOrCreateState();
    saveState({
      ...state,
      daemonStarts: (state.daemonStarts ?? 0) + 1,
      daemonUncleanStops: (state.daemonUncleanStops ?? 0) + (state.daemonRunning ? 1 : 0),
      daemonRunning: true,
    });
  } catch (err) {
    logger.debug({ err }, 'telemetry.daemon_start_record_failed');
  }
}

/**
 * Mark the daemon as having shut down through its own handler, so the next
 * start does not count this run as an unclean stop (TRA-671). Called from the
 * SIGTERM/SIGINT path; anything that skips that path is what we want counted.
 */
export function recordDaemonCleanStop(env: NodeJS.ProcessEnv = process.env): void {
  if (isDisabled(env)) return;
  try {
    const state = loadOrCreateState();
    if (!state.daemonRunning) return;
    saveState({ ...state, daemonRunning: false });
  } catch (err) {
    logger.debug({ err }, 'telemetry.daemon_stop_record_failed');
  }
}

/**
 * ISO country of the machine, derived from its timezone setting — this is what
 * fills GA4's map. Deliberately *not* from an IP: `ip_override` and a geo-IP
 * lookup would both put a network address in scope, and country granularity
 * answers "which regions use this" just as well.
 */
function country(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? countryForTimezone(zone) : undefined;
  } catch {
    return undefined;
  }
}

/** -1 / 0 / 1 on the numeric prefix of two semver strings; prerelease tags are ignored. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/**
 * What this ping represents for the install: its first ever run, a move to a
 * different version, or another day on the same one. Reported alongside
 * `previous_version` so an upgrade funnel reads directly off the events —
 * GA4 alone cannot derive per-install version transitions.
 */
function installType(state: TelemetryState, version: string): string {
  if (!state.lastVersion) return state.lastPingDate ? 'unknown' : 'new';
  const cmp = compareVersions(version, state.lastVersion);
  if (cmp > 0) return 'upgrade';
  if (cmp < 0) return 'downgrade';
  return 'active';
}

/**
 * Machine class, not machine identity: CPU architecture, core count, memory
 * rounded to whole gigabytes, and the OS kernel version. Enough to answer
 * "do our users run arm64" and "is 8GB the floor we must index within";
 * too coarse to single out a device.
 */
function device(): Record<string, string | number> {
  try {
    return {
      arch: process.arch,
      cpu_count: os.cpus().length,
      ram_gb: Math.round(os.totalmem() / 1024 ** 3),
      os_version: os.release(),
    };
  } catch {
    return {};
  }
}

/** Delta since the last ping, floored at 0 so a reset savings file can't send a negative. */
function delta(total: number | undefined, last: number | undefined): number {
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return 0;
  return Math.max(0, Math.round(total - (last ?? 0)));
}

/**
 * Fire-and-forget: never throws, and a failure never blocks or delays
 * startup. Sends at most one ping per UTC calendar day per install.
 */
export async function sendUsagePing(opts: UsagePingOptions): Promise<void> {
  const env = opts.env ?? process.env;
  if (isDisabled(env)) return;

  const measurementId = env.TRACE_MCP_GA_MEASUREMENT_ID || GA_MEASUREMENT_ID_DEFAULT;
  const apiSecret = env.TRACE_MCP_GA_API_SECRET || GA_API_SECRET_DEFAULT;
  if (!measurementId || !apiSecret) return;

  const state = loadOrCreateState();
  const today = utcDate(opts.nowMs ?? Date.now());
  if (state.lastPingDate === today) return;

  const countryId = country();
  const savings = (opts.loadSavings ?? loadPersistentSavings)();
  const tokensSaved = delta(savings?.total_tokens_saved, state.lastTokensSaved);
  const calls = delta(savings?.total_calls, state.lastCalls);
  const daemonStarts = state.daemonStarts ?? 0;
  const daemonUncleanStops = state.daemonUncleanStops ?? 0;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    await fetchImpl(url, {
      method: 'POST',
      body: JSON.stringify({
        client_id: state.installId,
        // Country only, from the machine's own timezone. `ip_override` stays
        // unset — Google derives nothing about the network from this request.
        ...(countryId ? { user_location: { country_id: countryId } } : {}),
        events: [
          {
            name: 'app_open',
            params: {
              version: opts.version,
              platform: process.platform,
              node_major: process.versions.node.split('.')[0],
              tokens_saved: tokensSaved,
              calls,
              client: state.client ?? 'unknown',
              install_type: installType(state, opts.version),
              previous_version: state.lastVersion ?? 'none',
              ...device(),
              model: topModelLastDay() ?? 'unknown',
              repos_indexed: Object.keys(savings?.per_project ?? {}).length,
              preset: opts.preset ?? 'unknown',
              tools_advertised: opts.toolsAdvertised ?? 0,
              // Daemon reliability since the previous ping (TRA-671). Both are
              // 0 for a stdio-only install, which never starts a daemon.
              daemon_starts: daemonStarts,
              daemon_unclean_stops: daemonUncleanStops,
              // Without these two GA4 keeps the event but doesn't count the
              // install as an active user — reports read 0 while the raw event
              // count is non-zero. See the "Tip" under `session_id` /
              // `engagement_time_msec` in the Measurement Protocol reference.
              session_id: String(Math.floor((opts.nowMs ?? Date.now()) / 1000)),
              engagement_time_msec: 1,
            },
          },
        ],
      }),
    });
  } catch (err) {
    logger.debug({ err }, 'telemetry.usage_ping_failed');
    return; // Don't persist lastPingDate — retry on next start.
  }

  try {
    // Re-read rather than saving the snapshot taken before the fetch: the
    // client's `initialize` routinely lands while that request is in flight,
    // and `recordUsagePingClient` writes the name straight to disk. Persisting
    // the stale snapshot erased it every time — so an install whose only
    // session of the day was the one that pinged never recorded a client, and
    // reported `unknown` again the next day, forever (TRA-643).
    const latest = loadOrCreateState();
    saveState({
      ...latest,
      installId: state.installId,
      lastPingDate: today,
      lastTokensSaved: savings?.total_tokens_saved ?? state.lastTokensSaved,
      lastCalls: savings?.total_calls ?? state.lastCalls,
      lastVersion: opts.version,
      // Subtract what was reported rather than zeroing: a daemon start can land
      // between the snapshot above and this write, and zeroing would swallow it.
      daemonStarts: Math.max(0, (latest.daemonStarts ?? 0) - daemonStarts),
      daemonUncleanStops: Math.max(0, (latest.daemonUncleanStops ?? 0) - daemonUncleanStops),
    });
  } catch (err) {
    logger.debug({ err }, 'telemetry.usage_ping_state_save_failed');
  }
}
