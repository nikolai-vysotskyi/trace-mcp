/**
 * CLI: trace-mcp subproject — manage subprojects within your project ecosystem.
 *
 * A subproject is any working repository that is part of your project's ecosystem:
 * microservices, frontends, backends, shared libraries, CLI tools, etc.
 *
 * Usage:
 *   trace-mcp subproject add --repo=../service-b [--contract=openapi.yaml] [--name=my-service]
 *   trace-mcp subproject remove <name-or-path>
 *   trace-mcp subproject list [--json]
 *   trace-mcp subproject sync
 *   trace-mcp subproject impact --endpoint=/api/users [--method=GET] [--service=user-svc]
 */

import { Command } from 'commander';
import { TopologyStore } from '../topology/topology-db.js';
import { SubprojectManager } from '../subproject/manager.js';
import { TOPOLOGY_DB_PATH, ensureGlobalDirs } from '../global.js';
import { logger } from '../logger.js';

function createManager(): { manager: SubprojectManager; topoStore: TopologyStore } {
  ensureGlobalDirs();
  const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
  const manager = new SubprojectManager(topoStore);
  return { manager, topoStore };
}

export const subprojectCommand = new Command('subproject')
  .description(
    'Manage subprojects — link repositories in your project ecosystem (microservices, frontends, backends, shared libs, etc.)',
  )
  .alias('sub');

// ── subproject add ──────────────────────────────────────────────────

subprojectCommand
  .command('add')
  .description('Add a repository as a subproject, bound to a project')
  .requiredOption('--repo <path>', 'Path to the repository/service')
  .requiredOption('--project <path>', 'Project root this subproject belongs to')
  .option('--contract <paths...>', 'Explicit contract file paths (relative to repo root)')
  .option('--name <name>', 'Name for this repo (default: directory basename)')
  .action((opts: { repo: string; project: string; contract?: string[]; name?: string }) => {
    const { manager, topoStore } = createManager();
    try {
      console.log(`Adding subproject: ${opts.repo} (project: ${opts.project})`);
      const result = manager.add(opts.repo, opts.project, {
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
      logger.error({ error: e }, 'Failed to add subproject');
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    } finally {
      topoStore.close();
    }
  });

// ── subproject remove ───────────────────────────────────────────────

subprojectCommand
  .command('remove <name-or-path>')
  .description('Remove a subproject')
  .action((nameOrPath: string) => {
    const { manager, topoStore } = createManager();
    try {
      const removed = manager.remove(nameOrPath);
      if (removed) {
        console.log(`Removed '${nameOrPath}' from subprojects.`);
      } else {
        console.log(`Subproject '${nameOrPath}' not found.`);
        process.exit(1);
      }
    } finally {
      topoStore.close();
    }
  });

// ── subproject list ─────────────────────────────────────────────────

subprojectCommand
  .command('list')
  .description('List subprojects and their connections')
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Filter to subprojects of a specific project')
  .action((opts: { json?: boolean; project?: string }) => {
    const { manager, topoStore } = createManager();
    try {
      const graph = manager.list(opts.project);

      if (opts.json) {
        console.log(JSON.stringify(graph, null, 2));
        return;
      }

      if (graph.repos.length === 0) {
        console.log('No subprojects. Use `trace-mcp subproject add --repo=<path>` to add one.');
        return;
      }

      console.log('Subprojects:\n');
      for (const repo of graph.repos) {
        console.log(`  ${repo.name}`);
        console.log(`    Root: ${repo.repoRoot}`);
        console.log(
          `    Services: ${repo.services} | Endpoints: ${repo.endpoints} | Client calls: ${repo.clientCalls}`,
        );
        console.log(`    Last synced: ${repo.lastSynced ?? 'never'}`);
        console.log();
      }

      if (graph.edges.length > 0) {
        console.log('Cross-Repo Dependencies:\n');
        for (const edge of graph.edges) {
          console.log(`  ${edge.source} → ${edge.target}`);
          console.log(
            `    Calls: ${edge.callCount} (${edge.linkedCount} linked) via ${edge.callTypes.join(', ')}`,
          );
        }
        console.log();
      }

      console.log(
        `Stats: ${graph.stats.repos} repos, ${graph.stats.totalEndpoints} endpoints, ` +
          `${graph.stats.totalClientCalls} client calls (${graph.stats.linkedCallsPercent}% linked)`,
      );
    } finally {
      topoStore.close();
    }
  });

// ── subproject sync ─────────────────────────────────────────────────

subprojectCommand
  .command('sync')
  .description('Re-scan all subprojects: contracts, client calls, and re-link')
  .action(() => {
    const { manager, topoStore } = createManager();
    try {
      console.log('Syncing all subprojects...');
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
      logger.error({ error: e }, 'Subproject sync failed');
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    } finally {
      topoStore.close();
    }
  });

// ── subproject impact ───────────────────────────────────────────────

subprojectCommand
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
        const risk =
          r.riskLevel === 'critical'
            ? '🔴 CRITICAL'
            : r.riskLevel === 'high'
              ? '🟠 HIGH'
              : r.riskLevel === 'medium'
                ? '🟡 MEDIUM'
                : '🟢 LOW';

        console.log(`  ${r.endpoint.method ?? '*'} ${r.endpoint.path} (${r.endpoint.service})`);
        console.log(`  Risk: ${risk}`);
        console.log(`  ${r.summary}\n`);

        for (const client of r.clients) {
          const loc = client.line ? `${client.filePath}:${client.line}` : client.filePath;
          console.log(
            `    [${client.repo}] ${loc} (${client.callType}, confidence: ${(client.confidence * 100).toFixed(0)}%)`,
          );
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
