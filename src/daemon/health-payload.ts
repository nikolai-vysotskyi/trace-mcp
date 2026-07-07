/**
 * Pure builder for the daemon's `GET /health` response.
 *
 * Split out of cli.ts so it can be unit-tested without spinning up an HTTP
 * server. The daemon binds its listener BEFORE startup indexing begins
 * (see the `serve-http` action), so `/health` answers from the first
 * millisecond — but during the initial reindex of all registered projects the
 * daemon is alive yet not fully warmed. Clients must be able to tell
 * "starting up" apart from "dead" so they wait/back off instead of respawning
 * a perfectly live daemon (issue #237 — the restart-war root cause).
 *
 * Contract:
 *   - `startupComplete === false` → `status: "starting"`, `phase: "startup_index"`.
 *     Clients treat this as ALIVE.
 *   - `startupComplete === true`  → `status: "ok"`.
 */

export type HealthStatus = 'ok' | 'starting';

export interface HealthProject {
  root: string;
  status: string;
}

export interface HealthPayload {
  status: HealthStatus;
  transport: 'http';
  version?: string;
  uptime: number;
  pid: number;
  projects: HealthProject[];
  /** Present only while `status === "starting"`. */
  phase?: 'startup_index';
  /** Present only while `status === "starting"`: cheap per-project progress. */
  progress?: {
    projectsReady: number;
    projectsTotal: number;
  };
}

export interface BuildHealthPayloadInput {
  startupComplete: boolean;
  version?: string;
  uptimeSeconds: number;
  pid: number;
  projects: HealthProject[];
}

/**
 * Build the `/health` payload. Pure — no I/O, fully unit-testable.
 *
 * `projectsReady` counts projects whose status is `ready`; anything else
 * (starting/indexing/error/unloaded) is not yet ready. This is derived from
 * the project list the caller already assembled, so it costs nothing extra.
 */
export function buildHealthPayload(input: BuildHealthPayloadInput): HealthPayload {
  const { startupComplete, version, uptimeSeconds, pid, projects } = input;

  const base: HealthPayload = {
    status: startupComplete ? 'ok' : 'starting',
    transport: 'http',
    version,
    uptime: uptimeSeconds,
    pid,
    projects,
  };

  if (!startupComplete) {
    base.phase = 'startup_index';
    base.progress = {
      projectsReady: projects.filter((p) => p.status === 'ready').length,
      projectsTotal: projects.length,
    };
  }

  return base;
}
