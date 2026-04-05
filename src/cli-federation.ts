/**
 * CLI: trace-mcp federation — multi-repo graph federation commands.
 *
 * Usage:
 *   trace-mcp federation add --repo=../service-b [--contract=openapi.yaml] [--name=my-service]
 *   trace-mcp federation remove <name-or-path>
 *   trace-mcp federation list [--json]
 *   trace-mcp federation sync
 *   trace-mcp federation impact --endpoint=/api/users [--method=GET] [--service=user-svc]
 */

import { Command } from 'commander';
import { TopologyStore } from './topology/topology-db.js';
import { FederationManager } from './federation/manager.js';
import { TOPOLOGY_DB_PATH, ensureGlobalDirs } from './global.js';
import { logger } from './logger.js';

function createManager(): { manager: FederationManager; topoStore: TopologyStore } {
  ensureGlobalDirs();
  const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
  const manager = new FederationManager(topoStore);
  return { manager, topoStore };
}

export const federationCommand = new Command('federation')
  .description('Multi-repo graph federation — link API contracts across repositories')
  .alias('fed');

// ── federation add ──────────────────────────────────────────────────

federationCommand
  .command('add')
  .description('Add a repository to the federation')
  .requiredOption('--repo <path>', 'Path to the repository')
  .option('--contract <paths...>', 'Explicit contract file paths (relative to repo root)')
  .option('--name <name>', 'Name for this repo (default: directory basename)')
  .action((opts: { repo: string; contract?: string[]; name?: string }) => {
    const { manager, topoStore } = createManager();
    try {
      console.log(`Adding repo to federation: ${opts.repo}`);
      const result = manager.add(opts.repo, {
        name: opts.name,
        contractPaths: opts.contract,
      });

      console.log(`\n  Repository: ${result.name}`);
      console.log(`  Path: ${result.repo}`);
      console.log(`  Services detected: ${result.services}`);
      console.log(`  Contracts parsed: ${result.contracts}`);
      console.log(`  Endpoints: ${result.endpoints}`);
      console.log(`  Client calls found: ${result.clientCalls}`);
      console.log(`  Linked to endpoints: ${result.linkedCalls}`);
      console.log();
    } catch (e) {
      logger.error({ error: e }, 'Failed to add repo');
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    } finally {
      topoStore.close();
    }
  });

// ── federation remove ───────────────────────────────────────────────

federationCommand
  .command('remove <name-or-path>')
  .description('Remove a repository from the federation')
  .action((nameOrPath: string) => {
    const { manager, topoStore } = createManager();
    try {
      const removed = manager.remove(nameOrPath);
      if (removed) {
        console.log(`Removed '${nameOrPath}' from federation.`);
      } else {
        console.log(`Repository '${nameOrPath}' not found in federation.`);
        process.exit(1);
      }
    } finally {
      topoStore.close();
    }
  });

// ── federation list ─────────────────────────────────────────────────

federationCommand
  .command('list')
  .description('List all federated repositories and their connections')
  .option('--json', 'Output as JSON')
  .action((opts: { json?: boolean }) => {
    const { manager, topoStore } = createManager();
    try {
      const graph = manager.list();

      if (opts.json) {
        console.log(JSON.stringify(graph, null, 2));
        return;
      }

      if (graph.repos.length === 0) {
        console.log('No federated repositories. Use `trace-mcp federation add --repo=<path>` to add one.');
        return;
      }

      console.log('Federated Repositories:\n');
      for (const repo of graph.repos) {
        console.log(`  ${repo.name}`);
        console.log(`    Root: ${repo.repoRoot}`);
        console.log(`    Services: ${repo.services} | Endpoints: ${repo.endpoints} | Client calls: ${repo.clientCalls}`);
        console.log(`    Last synced: ${repo.lastSynced ?? 'never'}`);
        console.log();
      }

      if (graph.edges.length > 0) {
        console.log('Cross-Repo Dependencies:\n');
        for (const edge of graph.edges) {
          console.log(`  ${edge.source} → ${edge.target}`);
          console.log(`    Calls: ${edge.callCount} (${edge.linkedCount} linked) via ${edge.callTypes.join(', ')}`);
        }
        console.log();
      }

      console.log(`Stats: ${graph.stats.repos} repos, ${graph.stats.totalEndpoints} endpoints, ` +
        `${graph.stats.totalClientCalls} client calls (${graph.stats.linkedCallsPercent}% linked)`);
    } finally {
      topoStore.close();
    }
  });

// ── federation sync ─────────────────────────────────────────────────

federationCommand
  .command('sync')
  .description('Re-scan all federated repos: contracts, client calls, and re-link')
  .action(() => {
    const { manager, topoStore } = createManager();
    try {
      console.log('Syncing all federated repositories...');
      const result = manager.sync();

      console.log(`\n  Repos synced: ${result.repos}`);
      console.log(`  Services: ${result.servicesUpdated}`);
      console.log(`  Contracts: ${result.contractsUpdated}`);
      console.log(`  Endpoints: ${result.endpointsUpdated}`);
      console.log(`  Client calls scanned: ${result.clientCallsScanned}`);
      console.log(`  Newly linked: ${result.newlyLinked}`);
      console.log(`  Cross-repo edges: ${result.crossRepoEdges}`);
      console.log();
    } catch (e) {
      logger.error({ error: e }, 'Federation sync failed');
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    } finally {
      topoStore.close();
    }
  });

// ── federation impact ───────────────────────────────────────────────

federationCommand
  .command('impact')
  .description('Cross-repo impact analysis: who breaks if this endpoint changes?')
  .option('--endpoint <path>', 'Endpoint path pattern (e.g. /api/users)')
  .option('--method <method>', 'HTTP method filter')
  .option('--service <name>', 'Service name filter')
  .option('--json', 'Output as JSON')
  .action((opts: { endpoint?: string; method?: string; service?: string; json?: boolean }) => {
    if (!opts.endpoint && !opts.service) {
      console.error('Error: at least one of --endpoint or --service is required');
      process.exit(1);
    }

    const { manager, topoStore } = createManager();
    try {
      const results = manager.getImpact({
        endpoint: opts.endpoint,
        method: opts.method,
        service: opts.service,
      });

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log('No cross-repo impact found for this endpoint.');
        return;
      }

      console.log('Cross-Repo Impact Analysis:\n');
      for (const r of results) {
        const risk = r.riskLevel === 'critical' ? '🔴 CRITICAL'
          : r.riskLevel === 'high' ? '🟠 HIGH'
          : r.riskLevel === 'medium' ? '🟡 MEDIUM' : '🟢 LOW';

        console.log(`  ${r.endpoint.method ?? '*'} ${r.endpoint.path} (${r.endpoint.service})`);
        console.log(`  Risk: ${risk}`);
        console.log(`  ${r.summary}\n`);

        for (const client of r.clients) {
          const loc = client.line ? `${client.filePath}:${client.line}` : client.filePath;
          console.log(`    [${client.repo}] ${loc} (${client.callType}, confidence: ${(client.confidence * 100).toFixed(0)}%)`);
          for (const sym of client.symbols) {
            console.log(`      → ${sym.kind} ${sym.fqn ?? sym.name}`);
          }
        }
        console.log();
      }
    } finally {
      topoStore.close();
    }
  });
