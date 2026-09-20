// Run against SQLite backups only; never mutates the live project indexes.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/db/store.js';
import { TopologyStore } from '../src/topology/topology-db.js';
import { buildGraphData } from '../src/tools/analysis/visualize.js';

const folder = path.resolve(process.argv[2]);
const topology = new TopologyStore(path.join(folder, 'topology.db'), { readonly: true });
const projects = JSON.parse(fs.readFileSync(path.join(folder, 'projects.json'), 'utf8')) as {
  name: string;
  root: string;
}[];
for (const { name, root } of projects) {
  for (const child of topology.getSubprojectsByProject(root)) {
    if (!child.db_path) continue;
    const relative = path.relative(folder, child.db_path);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(
        'Rewrite every topology db_path to a backup inside the snapshot folder first.',
      );
    }
  }
  const db = new Database(path.join(folder, `${name}.db`), { readonly: true });
  const start = performance.now();
  const data = buildGraphData(new Store(db), {
    scope: 'project',
    projectRoot: root,
    topoStore: topology,
    granularity: 'file',
    hideIsolated: true,
    depth: 2,
  });
  const ids = new Set(data.nodes.map((n) => n.id));
  const external = data.nodes.filter(
    (n) => n.id.includes('__external__/') || n.id.includes('.synthetic'),
  );
  const real = data.nodes.filter((n) => !external.includes(n));
  const missing = real.filter((n) => !fs.existsSync(path.join(root, n.id)));
  const summary = {
    name,
    nodes: data.nodes.length,
    edges: data.edges.length,
    uniquePairs: new Set(data.edges.map((e) => JSON.stringify([e.source, e.target]))).size,
    groups: data.communities.length,
    external: external.length,
    sourceNodes: real.length,
    missingSourceFiles: missing.length,
    duplicateIds: data.nodes.length - ids.size,
    danglingEdges: data.edges.filter((e) => !ids.has(e.source) || !ids.has(e.target)).length,
    buildMs: Math.round(performance.now() - start),
  };
  fs.writeFileSync(path.join(folder, `${name}-after.json`), JSON.stringify(data));
  console.log(JSON.stringify(summary));
  db.close();
}
topology.close();
