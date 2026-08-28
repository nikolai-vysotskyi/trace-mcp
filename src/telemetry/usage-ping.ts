/**
 * Anonymous, opt-out active-install ping.
 *
 * Separate from the observability bridge in `index.ts`/`otlp.ts`/`langfuse.ts`:
 * that bridge exports a *user's own* spans to a backend *they* configure. This
 * module reports back to the maintainer instead — a single daily event with
 * an anonymous install id, the trace-mcp version, Node major version, and
 * platform. No project paths, file names, query content, or anything else
 * that could identify a user or their code.
 *
 * Transport is GA4's Measurement Protocol (a plain HTTP POST to a Google
 * endpoint) rather than a self-hosted collector, so there's no backend to
 * run or maintain. TRACE_MCP_GA_MEASUREMENT_ID/TRACE_MCP_GA_API_SECRET
 * override at runtime; published builds fall back to credentials baked in
 * at build time via tsup's `define` (same mechanism as PKG_VERSION_INJECTED)
 * so installs report without per-user setup. See README "Usage telemetry"
 * for how to opt out (TRACE_MCP_TELEMETRY=off).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
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
    if (parsed.installId) return { installId: parsed.installId, lastPingDate: parsed.lastPingDate };
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

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    await fetchImpl(url, {
      method: 'POST',
      body: JSON.stringify({
        client_id: state.installId,
        events: [
          {
            name: 'app_open',
            params: {
              version: opts.version,
              platform: process.platform,
              node_major: process.versions.node.split('.')[0],
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
    saveState({ installId: state.installId, lastPingDate: today });
  } catch (err) {
    logger.debug({ err }, 'telemetry.usage_ping_state_save_failed');
  }
}
