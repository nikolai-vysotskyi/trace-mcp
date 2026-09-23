import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { getDbPath } from '../../global.js';
import { buildGraphData } from '../../tools/analysis/visualize.js';
import { TopologyStore } from '../../topology/topology-db.js';
import { SubprojectManager } from '../manager.js';
import { reconcileSubprojectIndex } from '../reconcile-index.js';

let tmp: string;
let root: string;
let child: string;
let store: Store;
let topo: TopologyStore;
let parent: Store;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-deleted-child-'));
  root = path.join(tmp, 'project');
  child = path.join(root, 'frontend');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, 'package.json'), '{"name":"frontend","main":"live.js"}');
  fs.writeFileSync(path.join(child, 'live.js'), 'export const live = 1;');
  const dbPath = getDbPath(child);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  store = new Store(initializeDatabase(dbPath));
  parent = new Store(initializeDatabase(':memory:'));
  topo = new TopologyStore(path.join(tmp, 'topology.db'));
  topo.upsertSubproject({ name: 'frontend', repoRoot: child, projectRoot: root, dbPath });
  const live = store.insertFile('live.js', 'javascript', 'live', 22);
  const gone = store.insertFile('gone.js', 'javascript', 'gone', 22);
  const sym = store.insertSymbol(gone, {
    symbolId: 'gone.js::gone#function',
    name: 'gone',
    kind: 'function',
    byteStart: 0,
    byteEnd: 22,
    lineStart: 1,
    lineEnd: 1,
  });
  store.insertEdge(store.getNodeId('file', live)!, store.getNodeId('file', gone)!, 'imports');
  store.insertEdge(store.getNodeId('symbol', sym)!, store.getNodeId('file', live)!, 'calls');
  store.insertFile('__external__/dep.synthetic', 'typescript', '__phantom_pkg__', 0);
});

afterEach(() => {
  vi.restoreAllMocks();
  store.db.close();
  parent.db.close();
  topo.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function graph() {
  return buildGraphData(parent, { scope: 'project', projectRoot: root, topoStore: topo });
}

describe('deleted files in federated indexes (TRA-1746)', () => {
  it.each(['sync', 'auto-discovery'] as const)(
    '%s removes files, symbols and both edge directions',
    async (entry) => {
      expect(graph().nodes.some((n) => n.id === 'frontend/gone.js')).toBe(true);
      const manager = new SubprojectManager(topo);
      if (entry === 'sync') await manager.sync();
      else await manager.autoDiscoverSubprojects(root);
      expect(store.getFile('gone.js')).toBeUndefined();
      expect(store.db.prepare('SELECT count(*) AS n FROM symbols').get()).toEqual({ n: 0 });
      expect(store.db.prepare('SELECT count(*) AS n FROM edges').get()).toEqual({ n: 0 });
      expect(
        store.db.prepare("SELECT count(*) AS n FROM nodes WHERE node_type = 'symbol'").get(),
      ).toEqual({ n: 0 });
      expect(store.getFile('live.js')).toBeDefined();
      expect(store.getFile('__external__/dep.synthetic')).toBeDefined();
      expect(graph().nodes.some((n) => n.id === 'frontend/gone.js')).toBe(false);
      await manager.sync();
      expect(store.getAllFiles()).toHaveLength(2);
    },
  );

  it('keeps an unavailable repository index intact', async () => {
    fs.renameSync(child, `${child}-offline`);
    await new SubprojectManager(topo).sync();
    expect(store.getFile('gone.js')).toBeDefined();
    expect(store.getAllFiles()).toHaveLength(3);
  });

  it('preserves unreadable entries, phantom symbols and paths outside the repository', () => {
    store.insertFile('phantom.ts', 'typescript', '__phantom__', 0);
    store.insertFile('../outside.ts', 'typescript', 'outside', 10);
    store.insertFile('denied.ts', 'typescript', 'denied', 10);
    const lstat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]).endsWith('denied.ts')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return lstat(...args);
    });
    expect(reconcileSubprojectIndex(child, store.db.name)).toBe(1);
    expect(store.getAllFiles().map((f) => f.path)).toEqual(
      expect.arrayContaining([
        'live.js',
        'phantom.ts',
        '__external__/dep.synthetic',
        '../outside.ts',
        'denied.ts',
      ]),
    );
  });

  it('does not prune when the root is unreadable or create an absent database', () => {
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    expect(reconcileSubprojectIndex(child, store.db.name)).toBe(0);
    expect(store.getAllFiles()).toHaveLength(3);
    const missingDb = path.join(tmp, 'missing.db');
    expect(reconcileSubprojectIndex(child, missingDb)).toBe(0);
    expect(fs.existsSync(missingDb)).toBe(false);
  });

  it('rolls back the whole cleanup if a cascade fails', () => {
    store.insertFile('also-gone.js', 'javascript', 'gone2', 20);
    const remove = Store.prototype.deleteFile;
    let calls = 0;
    vi.spyOn(Store.prototype, 'deleteFile').mockImplementation(function (this: Store, id) {
      if (++calls === 2) throw new Error('cascade failed');
      remove.call(this, id);
    });
    expect(reconcileSubprojectIndex(child, store.db.name)).toBe(0);
    expect(store.getFile('gone.js')).toBeDefined();
    expect(store.getFile('also-gone.js')).toBeDefined();
    expect(store.db.prepare('SELECT count(*) AS n FROM symbols').get()).toEqual({ n: 1 });
    expect(store.db.prepare('SELECT count(*) AS n FROM edges').get()).toEqual({ n: 2 });
  });

  it('preserves a file recreated before synchronization', () => {
    fs.writeFileSync(path.join(child, 'gone.js'), 'export const gone = 2;');
    expect(reconcileSubprojectIndex(child, store.db.name)).toBe(0);
    expect(store.getFile('gone.js')).toBeDefined();
  });
});
