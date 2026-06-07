/**
 * First-run preflight checks (#124).
 *
 * Catches the environment problems that otherwise surface mid-`init` as a raw
 * stack trace — wrong Node version, an unwritable `~/.trace-mcp/`, or no MCP
 * client config to write into — and turns each into a short, actionable
 * message. Pure and individually testable: every check takes its input as an
 * argument so the suite never depends on the real machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TRACE_MCP_HOME } from '../global.js';

/** Minimum supported Node major — keep in sync with package.json `engines.node`. */
export const MIN_NODE_MAJOR = 20;

export type PreflightSeverity = 'ok' | 'warn' | 'error';

export interface PreflightCheck {
  name: string;
  severity: PreflightSeverity;
  message: string;
  /** Actionable next step shown when severity is warn/error. */
  hint?: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  /** True when no check has severity 'error' (init can safely proceed). */
  ok: boolean;
}

/** Verify the running Node is new enough for trace-mcp. */
export function checkNodeVersion(version: string = process.versions.node): PreflightCheck {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isNaN(major)) {
    return {
      name: 'node-version',
      severity: 'warn',
      message: `Could not parse Node version "${version}".`,
      hint: `trace-mcp needs Node >= ${MIN_NODE_MAJOR}.`,
    };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      name: 'node-version',
      severity: 'error',
      message: `Node ${version} is too old (trace-mcp requires Node >= ${MIN_NODE_MAJOR}).`,
      hint: 'Upgrade Node (e.g. `nvm install 20` or https://nodejs.org) and re-run `trace-mcp init`.',
    };
  }
  return { name: 'node-version', severity: 'ok', message: `Node ${version}` };
}

/** Verify `~/.trace-mcp/` can be created and written to. */
export function checkHomeWritable(home: string = TRACE_MCP_HOME): PreflightCheck {
  try {
    fs.mkdirSync(home, { recursive: true });
    const probe = path.join(home, `.preflight-${process.pid}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { name: 'home-writable', severity: 'ok', message: `Writable: ${home}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    return {
      name: 'home-writable',
      severity: 'error',
      message: `Cannot write to ${home}${code ? ` (${code})` : ''}.`,
      hint:
        'Fix permissions on the directory (e.g. `chmod u+rwx ~/.trace-mcp`) or set ' +
        'TRACE_MCP_DATA_DIR to a writable location, then re-run `trace-mcp init`.',
    };
  }
}

/** Warn (not fail) when no MCP client config was detected to write into. */
export function checkMcpClientConfig(detectedClientCount: number): PreflightCheck {
  if (detectedClientCount > 0) {
    return {
      name: 'mcp-client-config',
      severity: 'ok',
      message: `${detectedClientCount} MCP client config${detectedClientCount > 1 ? 's' : ''} detected`,
    };
  }
  return {
    name: 'mcp-client-config',
    severity: 'warn',
    message: 'No MCP client config detected.',
    hint:
      'init can still write a default config, but verify your client (Claude Code, Cursor, ' +
      "etc.) is installed. After init, run `trace-mcp doctor` if the client doesn't pick it up.",
  };
}

/** Run all preflight checks. `mcpClientCount` comes from the init detector. */
export function runPreflight(opts: { mcpClientCount: number }): PreflightReport {
  const checks = [
    checkNodeVersion(),
    checkHomeWritable(),
    checkMcpClientConfig(opts.mcpClientCount),
  ];
  return { checks, ok: !checks.some((c) => c.severity === 'error') };
}
