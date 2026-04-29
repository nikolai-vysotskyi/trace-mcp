/**
 * `trace-mcp clients status` — report whether each detected MCP client's
 * config currently matches what `trace-mcp init` would write.
 *
 * Used by the desktop app's MCP Clients screen to decide between an
 * "Install" and an "Update" button: when a flag we now write (e.g.
 * `alwaysLoad: true` for Claude Code) is missing from a previously
 * installed entry, the row should prompt the user to refresh the config
 * rather than pretend the integration is healthy.
 */

import { Command } from 'commander';
import { getMcpClientStatuses, type McpClientStatus } from '../init/mcp-client.js';
import { findProjectRoot } from '../project-root.js';

export const clientsCommand = new Command('clients').description(
  'Inspect MCP client configurations',
);

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
    const projectRoot = findProjectRoot(process.cwd());
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

function printHumanReport(scope: string, statuses: McpClientStatus[]): void {
  console.log(`MCP client configurations (scope: ${scope})\n`);
  const widthName = Math.max(6, ...statuses.map((s) => s.client.length));
  for (const s of statuses) {
    const pad = s.client.padEnd(widthName);
    const tag = formatStatusTag(s);
    const path = s.configPath ?? '—';
    const reason = s.staleReason ? `  (drift: ${s.staleReason})` : '';
    console.log(`  ${pad}  ${tag}  ${path}${reason}`);
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
