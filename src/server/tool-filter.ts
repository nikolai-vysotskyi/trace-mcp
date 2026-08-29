/**
 * The single source of truth for "is this tool part of the surface this client
 * session asked for" — preset + tools.include + tools.exclude.
 *
 * Two callers:
 *  - the registration-time gate (src/server/tool-gate.ts), which never
 *    registers a filtered-out tool on a local McpServer;
 *  - the daemon proxy (src/daemon/router/proxy-backend.ts), which cannot filter
 *    at registration — one daemon serves many sessions with different presets —
 *    so it filters `tools/list` and rejects `tools/call` per session instead.
 *
 * Before TRA-250 only the first existed, so every daemon-backed session (the
 * default path) saw the full surface regardless of its preset.
 */
import type { TraceMcpConfig } from '../config.js';
import { resolvePreset } from '../tools/project/presets.js';

/**
 * Tools registered through `_originalTool` in src/tools/register/session.ts —
 * deliberately outside the preset gate, so any session can inspect its own
 * preset/usage and use `batch`. The proxy-side filter has to let them through
 * as well, otherwise the daemon-backed surface would be smaller than the local
 * one for the same preset. Kept honest by tool-filter.test.ts.
 */
export const UNGATED_META_TOOLS: ReadonlySet<string> = new Set([
  'get_preset_info',
  'get_session_analytics',
  'get_optimization_report',
  'get_coverage_report',
  'get_real_savings',
  'get_usage_trends',
  'get_session_stats',
  'plan_turn',
  'batch',
  // TRA-402: escalation itself can never be gated — a preset that hides
  // load_tools would make its own deferred half permanently unreachable.
  'load_tools',
]);

/**
 * Preset name this session runs with: env beats config, default `minimal`.
 *
 * The default was `standard` (55 tools, ~64.6k serialized chars) until TRA-402
 * gave presets an escape hatch. Until then a preset was permanent — anything
 * outside it was unreachable for the whole session — so a small default meant
 * silently taking capabilities away. With `load_tools` the deferred half is one
 * call away, which makes the cheap surface the right default: `minimal` is
 * ~30.5k chars, roughly half of `standard` and a fifth of `full`, paid by every
 * session before it asks its first question.
 */
export function resolvePresetName(config: TraceMcpConfig): string {
  return process.env.TRACE_MCP_PRESET ?? config.tools?.preset ?? 'minimal';
}

/** Resolved preset set; unknown names fall back to the full surface. */
export function resolveActivePreset(config: TraceMcpConfig): Set<string> | 'all' {
  return resolvePreset(resolvePresetName(config)) ?? 'all';
}

/**
 * Build the per-session predicate. `activePreset` is injectable because the
 * server resolves it once and logs it; everyone else can let us resolve it.
 */
export function createToolFilter(
  config: TraceMcpConfig,
  activePreset: Set<string> | 'all' = resolveActivePreset(config),
): (name: string) => boolean {
  const includeSet = config.tools?.include ? new Set(config.tools.include) : null;
  const excludeSet = config.tools?.exclude ? new Set(config.tools.exclude) : null;
  return (name: string): boolean => {
    if (excludeSet?.has(name)) return false;
    if (includeSet?.has(name)) return true;
    if (activePreset === 'all') return true;
    // Meta-tools are never registered through the gate, so this branch only
    // matters for the proxy filter — it keeps both surfaces identical.
    return activePreset.has(name) || UNGATED_META_TOOLS.has(name);
  };
}
