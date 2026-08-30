/**
 * `trace-mcp clients status` — report whether each detected MCP client's
 * config currently matches what `trace-mcp init` would write.
 *
 * Used by the desktop app's MCP Clients screen to decide between an
 * "Install" and an "Update" button: when a managed field has drifted from
 * what `init` would write now — including a stale `alwaysLoad: true` left
 * by a pre-#354 `init` run — the row should prompt the user to refresh the
 * config rather than pretend the integration is healthy.
 *
 * `trace-mcp clients update` is the repair half of the same pair, and exists
 * because `init` could not be it. What drifts is the MCP server entry —
 * `command`, `cwd`, a leftover `alwaysLoad` — and repairing it is a different
 * operation from setting trace-mcp up: setup asks which enforcement level to
 * run at, repair must not, because the answer is already in the user's config
 * and re-asking it can only change what the user already chose. `init` is a
 * setup command through and through: `--skip-hooks` writes
 * `tools.agent_behavior = "off"`, and omitting it installs hooks and tweakcc.
 * There is no flag combination that means "reconcile the entry and touch
 * nothing else", so the desktop app's Update button had no safe call to make.
 * This command is that call.
 */

import { Command } from 'commander';
import {
  configureMcpClients,
  getMcpClientStatuses,
  type McpClientStatus,
} from '../init/mcp-client.js';
import type { DetectedMcpClient, InitStepResult } from '../init/types.js';
import { findProjectRoot } from '../project-root.js';

export const clientsCommand = new Command('clients').description(
  'Inspect MCP client configurations',
);

/**
 * Project root for the scope-dependent parts of a client config. Global-scope
 * entries no longer use it at all (TRA-501), so a cwd with no root marker is
 * not a reason to fail: `findProjectRoot` throws there, which is exactly what
 * the desktop app hits when it shells out from inside a packaged bundle.
 */
function resolveProjectRoot(): string {
  try {
    return findProjectRoot(process.cwd());
  } catch {
    return process.cwd();
  }
}

clientsCommand
  .command('status')
  .description(
    'Report per-client config status (missing | up_to_date | stale | unmanageable | unknown)',
  )
  .option('--json', 'Output machine-readable JSON')
  .option('--scope <scope>', 'Config scope: global | project', 'global')
  .option(
    '--client <name>',
    'Restrict to one client (e.g. claude-code). Repeat by passing comma-separated names.',
  )
  .action((opts: { json?: boolean; scope?: 'global' | 'project'; client?: string }) => {
    const scope = opts.scope === 'project' ? 'project' : 'global';
    const projectRoot = resolveProjectRoot();
    const clientNames = opts.client
      ? // biome-ignore lint/suspicious/noExplicitAny: validated downstream by getMcpClientStatuses
        (opts.client
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean) as any[])
      : undefined;
    const statuses = getMcpClientStatuses(projectRoot, scope, clientNames);

    if (opts.json) {
      console.log(JSON.stringify({ scope, projectRoot, statuses }, null, 2));
      return;
    }

    printHumanReport(scope, statuses);
  });

clientsCommand
  .command('update')
  .description(
    'Rewrite the trace-mcp entry in one or more client configs. Never touches hooks, tweakcc or agent_behavior.',
  )
  .argument(
    '[clients...]',
    'Clients to repair (e.g. cursor amp). Omit to repair every client whose config has drifted.',
  )
  .option('--json', 'Output machine-readable JSON')
  .option('--scope <scope>', 'Config scope: global | project', 'global')
  .option('--dry-run', 'Report what would be written without writing it')
  .action(
    (
      clients: string[],
      opts: { json?: boolean; scope?: 'global' | 'project'; dryRun?: boolean },
    ) => {
      const scope = opts.scope === 'project' ? 'project' : 'global';
      const projectRoot = resolveProjectRoot();

      const targets = (
        clients.length > 0
          ? (clients as DetectedMcpClient['name'][])
          : getMcpClientStatuses(projectRoot, scope)
              .filter((s) => s.status === 'stale')
              .map((s) => s.client)
      ) as DetectedMcpClient['name'][];

      const steps =
        targets.length > 0
          ? configureMcpClients(targets, projectRoot, { scope, dryRun: opts.dryRun })
          : [];

      if (opts.json) {
        console.log(JSON.stringify({ scope, projectRoot, clients: targets, steps }, null, 2));
      } else {
        printUpdateReport(targets, steps);
      }

      /* A repair that wrote nothing because every write failed is not a success.
       `skipped` is also how configureMcpClients reports an unknown client name
       and the manual-only pair, so the app can tell "nothing to do" from
       "asked for something impossible" by the exit code alone. */
      if (steps.some((s) => s.action === 'skipped' && s.detail?.startsWith('Error:'))) {
        process.exitCode = 1;
      }
    },
  );

function printUpdateReport(targets: string[], steps: InitStepResult[]): void {
  if (targets.length === 0) {
    console.log('Every MCP client config already matches what trace-mcp writes.');
    return;
  }
  for (const s of steps) {
    console.log(`  ${s.action.padEnd(18)}  ${s.target}${s.detail ? `  (${s.detail})` : ''}`);
  }
}

function printHumanReport(scope: string, statuses: McpClientStatus[]): void {
  console.log(`MCP client configurations (scope: ${scope})\n`);
  const widthName = Math.max(6, ...statuses.map((s) => s.client.length));
  for (const s of statuses) {
    const pad = s.client.padEnd(widthName);
    const tag = formatStatusTag(s);
    const path = s.configPath ?? '—';
    const reason = s.staleReason ? `  (drift: ${s.staleReason})` : '';
    const level = s.level ? `  level: ${s.level}` : '';
    console.log(`  ${pad}  ${tag}  ${path}${level}${reason}`);
  }
}

function formatStatusTag(s: McpClientStatus): string {
  switch (s.status) {
    case 'up_to_date':
      return '[ok]      ';
    case 'missing':
      return '[install] ';
    case 'stale':
      return '[update]  ';
    case 'unmanageable':
      return '[manual]  ';
    case 'unknown':
      return '[present] ';
  }
}
