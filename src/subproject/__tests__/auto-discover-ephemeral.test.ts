/**
 * TRA-527: topology.db is global and shared by every project, but nothing ever
 * deletes rows for a one-shot agent-run workdir — it is never in registry.json,
 * so no removeProject/sweep path can reach it. Every run therefore left
 * permanent services/subprojects rows behind (260 of 320 distinct project roots
 * on the reported machine), which every scoped topology query then fans out
 * over (TRA-470). Auto-discovery has to skip those roots at the source.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubprojectManager } from '../manager.js';
import { TopologyStore } from '../../topology/topology-db.js';

let tmp: string;
let store: TopologyStore;

/** A directory with a service marker, so detectServices() has something to find. */
function makeService(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'svc', main: 'i.js' }));
  fs.writeFileSync(path.join(root, 'i.js'), 'export const x = 1;\n');
  return root;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-autodiscover-'));
  store = new TopologyStore(path.join(tmp, 'topology.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('autoDiscoverSubprojects on a one-shot agent workdir (TRA-527)', () => {
  it.each([['workdir'], ['workdir/trace-mcp']])(
    'writes no topology rows for .../%s',
    async (rel) => {
      const root = makeService(
        path.join(tmp, 'multica_workspaces_test.multica.ai', 'ws-1', 'run-1', ...rel.split('/')),
      );

      const { services } = await new SubprojectManager(store).autoDiscoverSubprojects(root);

      expect(services).toEqual([]);
      expect(store.getAllSubprojects()).toEqual([]);
    },
  );

  it('still discovers a normal project root', async () => {
    const root = makeService(path.join(tmp, 'real-project'));

    await new SubprojectManager(store).autoDiscoverSubprojects(root);

    expect(store.getAllSubprojects().length).toBeGreaterThan(0);
  });
});
