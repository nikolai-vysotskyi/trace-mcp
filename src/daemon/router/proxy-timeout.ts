/**
 * Adaptive proxy-initialize timeout (TRA-1605, PROC-1).
 *
 * The old fixed 1 s watchdog (`PROXY_INITIALIZE_TIMEOUT_MS`) treated a
 * healthy-but-loaded daemon the same as a dead one: N stdio sessions on a
 * busy machine all gave up at the same instant and stampeded into local
 * mode — N processes × ~220 MB plus their own ExtractPool/ONNX runtimes,
 * pressing a machine that was already at its limit.
 *
 * Two signals distinguish "slow" from "dead", both read off the daemon's own
 * cheap /health route (which answers even while the MCP handler is starved):
 *
 * 1. Warmup (`status: "starting"`): the daemon just bound its listener and is
 *    still running startup indexing. Every session that sees this waits out a
 *    bounded grace instead of falling back — a cross-process single-flight by
 *    construction: they all wait on the one starting daemon rather than each
 *    forking a local backend.
 * 2. Load (slow-but-answering /health): on a loaded box even /health takes
 *    tens of ms. The extra budget scales with the observed round-trip, so a
 *    daemon that is provably alive but starved gets room to answer.
 *
 * A silent /health (connection refused / timeout) keeps the base timeout —
 * that is still the dead-daemon fast path, and the healthy-daemon handshake
 * timing is unchanged (the extension only ever fires when there is evidence
 * the daemon is alive).
 */
import { getDaemonHealth } from '../client.js';

/** Base budget, unchanged from the old fixed constant. */
export const DEFAULT_PROXY_INITIALIZE_TIMEOUT_MS = 1_000;

/**
 * How long a session waits for a daemon that reports `status: "starting"`
 * before falling back to local mode. Startup indexing can starve /health's
 * siblings for tens of seconds; 30 s covers a cold start without letting a
 * wedged daemon pin the handshake forever.
 */
export const DEFAULT_PROXY_WARMUP_GRACE_MS = 30_000;

/** Absolute cap on base + any extension. A hung daemon must never pin us. */
export const PROXY_ABSOLUTE_MAX_MS = 120_000;

/**
 * Extra budget per millisecond of /health round-trip. A daemon whose cheapest
 * route takes 50 ms is under real pressure — grant 4× that on the handshake.
 */
const LOAD_RTT_FACTOR = 4;

/** Cap on the load-derived extra so one slow probe can't blow the budget. */
const PROXY_MAX_LOAD_EXTRA_MS = 9_000;

/**
 * Resolve the base proxy-initialize budget. Explicit opts win, then env
 * (so operators can tune without rebuilding), then the default — the same
 * precedence `resolveHandshakeTimeout` uses.
 */
export function resolveProxyInitializeTimeout(
  optsValue: number | undefined,
  envValue: string | undefined,
  fallback: number = DEFAULT_PROXY_INITIALIZE_TIMEOUT_MS,
): number {
  if (typeof optsValue === 'number' && Number.isFinite(optsValue) && optsValue >= 0) {
    return Math.floor(optsValue);
  }
  const parsed = parseEnvInt(envValue);
  if (parsed !== undefined) return parsed;
  return fallback;
}

/**
 * Resolve the warmup grace. Same precedence as the base timeout; its env key
 * is separate so raising one never silently raises the other.
 */
export function resolveProxyWarmupGrace(
  optsValue: number | undefined,
  envValue: string | undefined,
  fallback: number = DEFAULT_PROXY_WARMUP_GRACE_MS,
): number {
  if (typeof optsValue === 'number' && Number.isFinite(optsValue) && optsValue >= 0) {
    return Math.floor(optsValue);
  }
  const parsed = parseEnvInt(envValue);
  if (parsed !== undefined) return parsed;
  return fallback;
}

function parseEnvInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}

/** What a /health probe learned, or null when the daemon is silent. */
export interface ProxyReadiness {
  reachable: boolean;
  /** True while the daemon reports `status: "starting"` (warming up). */
  starting: boolean;
  /** /health round-trip in ms — the load signal. */
  rttMs: number;
}

/**
 * Probe the daemon's /health once. Returns null when nothing answers
 * (connection refused, timeout, non-200) — the dead-daemon case, which keeps
 * the base timeout. Never throws.
 */
export async function probeProxyReadiness(port: number): Promise<ProxyReadiness | null> {
  const start = Date.now();
  try {
    const health = await getDaemonHealth(port);
    if (!health) return null;
    return {
      reachable: true,
      starting: health.status === 'starting',
      rttMs: Date.now() - start,
    };
  } catch {
    return null;
  }
}

/**
 * Total proxy-initialize budget given the base and one readiness probe.
 * Pure — unit-tested without a daemon.
 *
 * - Silent daemon (null): base. Dead stays fast.
 * - Starting daemon: base + full warmup grace (capped). Wait, don't stampede.
 * - Reachable daemon: base + RTT-scaled load extra (capped). Loaded gets room.
 */
export function computeProxyTimeoutMs(
  baseMs: number,
  readiness: ProxyReadiness | null,
  warmupGraceMs: number,
): number {
  if (!readiness) return baseMs;
  if (readiness.starting) {
    return Math.min(baseMs + Math.max(0, warmupGraceMs), PROXY_ABSOLUTE_MAX_MS);
  }
  const extra = Math.min(Math.max(0, readiness.rttMs) * LOAD_RTT_FACTOR, PROXY_MAX_LOAD_EXTRA_MS);
  return Math.min(baseMs + extra, PROXY_ABSOLUTE_MAX_MS);
}
