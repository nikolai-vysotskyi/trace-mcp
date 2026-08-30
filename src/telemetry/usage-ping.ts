/**
 * Anonymous, opt-out active-install ping.
 *
 * Separate from the observability bridge in `index.ts`/`otlp.ts`/`langfuse.ts`:
 * that bridge exports a *user's own* spans to a backend *they* configure. This
 * module reports back to the maintainer instead — a single daily event with
 * an anonymous install id, the trace-mcp version, Node major version,
 * platform, the country its timezone belongs to, the MCP client name (e.g.
 * "claude-code"), the model that client mostly drove, how many repositories
 * are indexed, and two aggregate counters since the previous ping (tool calls
 * and estimated tokens saved). Counts and names only: no IP, no project paths,
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
}

function isDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.TRACE_MCP_TELEMETRY?.trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false';
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
              model: topModelLastDay() ?? 'unknown',
              repos_indexed: Object.keys(savings?.per_project ?? {}).length,
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
    saveState({
      installId: state.installId,
      lastPingDate: today,
      lastTokensSaved: savings?.total_tokens_saved ?? state.lastTokensSaved,
      lastCalls: savings?.total_calls ?? state.lastCalls,
      client: state.client,
    });
  } catch (err) {
    logger.debug({ err }, 'telemetry.usage_ping_state_save_failed');
  }
}
