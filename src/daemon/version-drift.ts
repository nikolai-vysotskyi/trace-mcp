/**
 * Version drift detection between executing CLI, background daemon, and launcher shim.
 *
 * TRA-2721: A user or agent invoking `trace-mcp` through shell PATH can run an
 * outdated global npm package (e.g., Herd Node v22.22.2) while the live daemon
 * and `~/.trace/bin/trace` shim have already moved to a newer release.
 *
 * This module provides pure comparison logic and non-blocking diagnostics to
 * surface drift across `doctor` and `daemon status`.
 */

import { getDaemonHealth } from './client.js';
import { readLauncherConfig } from '../init/launcher.js';

declare const PKG_VERSION_INJECTED: string;
export const CURRENT_CLI_VERSION =
  typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';

/** Compare two semver strings numerically. Returns -1 if a < b, 0 if a === b, 1 if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^[^\d]*/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = b
    .replace(/^[^\d]*/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai > bi ? 1 : -1;
  }
  return 0;
}

export type VersionDriftStatus =
  | 'in_sync'
  | 'cli_older'
  | 'cli_newer'
  | 'daemon_offline'
  | 'dev_build';

export interface VersionDriftCheckOptions {
  cliVersion: string;
  daemonVersion?: string | null;
  launcherVersion?: string | null;
  daemonRunning?: boolean;
}

export interface CliDaemonVersionDriftReport {
  drift: boolean;
  cliVersion: string;
  daemonVersion: string | null;
  launcherVersion: string | null;
  daemonRunning: boolean;
  status: VersionDriftStatus;
  warning?: string;
  remedy?: string;
}

/**
 * Pure evaluation of CLI, daemon, and launcher versions.
 */
export function checkCliDaemonVersionDrift(
  opts: VersionDriftCheckOptions,
): CliDaemonVersionDriftReport {
  const cliVersion = opts.cliVersion;
  const daemonVersion = opts.daemonVersion ?? null;
  const launcherVersion = opts.launcherVersion ?? null;
  const daemonRunning = opts.daemonRunning ?? daemonVersion !== null;

  if (cliVersion === '0.0.0-dev') {
    return {
      drift: false,
      cliVersion,
      daemonVersion,
      launcherVersion,
      daemonRunning,
      status: 'dev_build',
    };
  }

  if (!daemonRunning || !daemonVersion) {
    return {
      drift: false,
      cliVersion,
      daemonVersion: null,
      launcherVersion,
      daemonRunning: false,
      status: 'daemon_offline',
    };
  }

  const cmp = compareVersions(cliVersion, daemonVersion);

  if (cmp < 0) {
    return {
      drift: true,
      cliVersion,
      daemonVersion,
      launcherVersion,
      daemonRunning: true,
      status: 'cli_older',
      warning:
        `CLI version (${cliVersion}) is older than the running daemon (${daemonVersion}). ` +
        'Commands executed via shell PATH are using an outdated binary.',
      remedy:
        "Update the global package in your active PATH ('npm i -g trace-mcp@latest') " +
        "or invoke commands via the control plane shim ('~/.trace/bin/trace').",
    };
  }

  if (cmp > 0) {
    return {
      drift: true,
      cliVersion,
      daemonVersion,
      launcherVersion,
      daemonRunning: true,
      status: 'cli_newer',
      warning:
        `CLI version (${cliVersion}) is newer than the running daemon (${daemonVersion}). ` +
        'The running daemon was started with an older version.',
      remedy: "Restart the daemon with 'trace-mcp daemon restart' to apply the updated code.",
    };
  }

  // CLI and daemon agree on version. Check launcherVersion if provided.
  if (launcherVersion && compareVersions(cliVersion, launcherVersion) < 0) {
    return {
      drift: true,
      cliVersion,
      daemonVersion,
      launcherVersion,
      daemonRunning: true,
      status: 'cli_older',
      warning: `CLI and daemon (${cliVersion}) are older than the control plane launcher (${launcherVersion}).`,
      remedy:
        "Update global CLI ('npm i -g trace-mcp@latest') or re-run 'trace-mcp init' to synchronize.",
    };
  }

  return {
    drift: false,
    cliVersion,
    daemonVersion,
    launcherVersion,
    daemonRunning: true,
    status: 'in_sync',
  };
}

/**
 * Diagnostics helper that queries the running daemon and launcher config.
 * Safe and non-blocking: never throws even if daemon is unreachable.
 */
export async function diagnoseVersionDrift(opts?: {
  port?: number;
  cliVersion?: string;
}): Promise<CliDaemonVersionDriftReport> {
  const cliVersion = opts?.cliVersion ?? CURRENT_CLI_VERSION;
  let daemonVersion: string | null = null;
  let daemonRunning = false;

  try {
    const health = await getDaemonHealth(opts?.port);
    if (health) {
      daemonRunning = true;
      daemonVersion = health.version ?? null;
    }
  } catch {
    // Daemon unreachable — best-effort fallback
  }

  let launcherVersion: string | null = null;
  try {
    const launcherCfg = readLauncherConfig();
    launcherVersion = launcherCfg.version ?? null;
  } catch {
    // Missing or invalid launcher config
  }

  return checkCliDaemonVersionDrift({
    cliVersion,
    daemonVersion,
    launcherVersion,
    daemonRunning,
  });
}

/**
 * Human-readable warning lines for terminal reports (doctor, daemon status).
 */
export function formatVersionDriftReport(report: CliDaemonVersionDriftReport): string[] {
  if (!report.drift) return [];
  const lines: string[] = ['Version drift detected:'];
  if (report.warning) lines.push(`  ${report.warning}`);
  if (report.remedy) lines.push(`  Remedy: ${report.remedy}`);
  return lines;
}
