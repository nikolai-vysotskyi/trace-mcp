/**
 * Multica workspace agents and their trace-mcp wiring (TRA-1933 Phase C).
 *
 * Read-only by architecture: the only Multica access is the LOCAL `multica`
 * CLI the user already runs — no hosted backend, no extra auth, no writes.
 * The main-process IPC handler (`get-multica-agents` in main/index.ts) is a
 * thin shell around `getMulticaAgentWirings`; the parsing below is pure and
 * unit-tested with a fake runner so no real `multica` binary is needed.
 *
 * Two wiring mechanisms exist side by side (see docs/configuration.md
 * §Multica workspace agents):
 *  1. Workspace-library assignment — `multica agent mcp list <id>` names the
 *     shared servers (e.g. `trace`) with an enabled flag.
 *  2. Per-agent `mcp_config` — a custom JSON payload read back from
 *     `multica agent list/get`. Agent actors see it redacted; only an
 *     owner/admin read carries the argv a `--preset` can be parsed from.
 */

import { execFile } from 'node:child_process';

export interface MulticaAgentWiring {
  id: string;
  name: string;
  status: string;
  /** Workspace-library `trace`/`trace-mcp` assignment; null when unreadable. */
  traceAssigned: boolean | null;
  traceEnabled: boolean | null;
  /**
   * Per-agent custom config: `none` (inherits the machine setup), `hidden`
   * (redacted for this caller — an owner read would show it), `present`.
   */
  customConfig: 'none' | 'hidden' | 'present';
  /**
   * Preset parsed from the custom config's trace entry
   * (`args: ["serve", "--preset", X]`); null unless the raw config was
   * readable and carried one. Never guessed — unknown reads as unknown.
   */
  preset: string | null;
}

export interface MulticaAgentsReport {
  ok: boolean;
  /** False when no `multica` CLI answered — the section shows a hint, not an error. */
  available: boolean;
  error?: string;
  agents?: MulticaAgentWiring[];
}

/** Injectable process runner so tests never spawn a real binary. */
export type MulticaRunner = (args: string[]) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 15_000;

function defaultRunner(bin: string): MulticaRunner {
  return (args) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(String(stdout));
        },
      );
    });
}

/** Best-effort preset parse — only the exact `serve --preset X` shape counts. */
export function parseTracePreset(mcpConfig: unknown): string | null {
  if (!mcpConfig || typeof mcpConfig !== 'object') return null;
  const servers = (mcpConfig as { mcpServers?: Record<string, unknown> }).mcpServers;
  if (!servers || typeof servers !== 'object') return null;
  for (const key of ['trace', 'trace-mcp']) {
    const entry = servers[key] as { args?: unknown } | undefined;
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.args)) continue;
    const i = entry.args.indexOf('--preset');
    if (i >= 0 && typeof entry.args[i + 1] === 'string') return entry.args[i + 1] as string;
  }
  return null;
}

interface RawAgent {
  id: string;
  name?: string;
  status?: string;
  mcp_config?: unknown;
  mcp_config_redacted?: boolean;
}

function isTraceServerName(name: unknown): boolean {
  return name === 'trace' || name === 'trace-mcp';
}

export async function getMulticaAgentWirings(
  runner: MulticaRunner = defaultRunner(process.env.MULTICA_BIN ?? 'multica'),
): Promise<MulticaAgentsReport> {
  let listRaw: string;
  try {
    listRaw = await runner(['agent', 'list', '--output', 'json']);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return {
      ok: false,
      available: false,
      error:
        code === 'ENOENT'
          ? 'multica CLI not found on PATH — install it to see workspace agents here.'
          : `multica agent list failed: ${(err as Error).message}`,
    };
  }

  let rawAgents: RawAgent[];
  try {
    const parsed: unknown = JSON.parse(listRaw);
    rawAgents = Array.isArray(parsed) ? (parsed as RawAgent[]) : [];
  } catch (err) {
    return { ok: false, available: true, error: `multica agent list not JSON: ${(err as Error).message}` };
  }

  const agents = await Promise.all(
    rawAgents.map(async (a): Promise<MulticaAgentWiring> => {
      const customConfig =
        a.mcp_config != null ? 'present' : a.mcp_config_redacted ? 'hidden' : 'none';
      const preset = customConfig === 'present' ? parseTracePreset(a.mcp_config) : null;

      // One agent's assignment failing must not fail the whole section —
      // that row reads as unknown (TRA-497: a silent row is worse).
      let traceAssigned: boolean | null = null;
      let traceEnabled: boolean | null = null;
      try {
        const mcpRaw = await runner(['agent', 'mcp', 'list', a.id, '--output', 'json']);
        const assigned = JSON.parse(mcpRaw) as { name?: unknown; enabled?: unknown }[];
        const trace = Array.isArray(assigned) ? assigned.find((s) => isTraceServerName(s.name)) : undefined;
        if (trace) {
          traceAssigned = true;
          traceEnabled = trace.enabled !== false;
        } else {
          traceAssigned = false;
          traceEnabled = false;
        }
      } catch {
        traceAssigned = null;
        traceEnabled = null;
      }

      return {
        id: a.id,
        name: typeof a.name === 'string' && a.name ? a.name : a.id,
        status: typeof a.status === 'string' ? a.status : 'unknown',
        traceAssigned,
        traceEnabled,
        customConfig,
        preset,
      };
    }),
  );

  return { ok: true, available: true, agents };
}
