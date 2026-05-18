import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('DecisionStore — decision clusters (P1.1)', () => {
  let store: DecisionStore;
  let dbPath: string;
  const projectRoot = '/projects/clusters-test';

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-clusters-'));
    dbPath = path.join(tmpDir, 'decisions.db');
    store = new DecisionStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  describe('schema migration', () => {
    it('creates decision_clusters and decision_cluster_members tables on a fresh DB', () => {
      const tables = (
        store.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toContain('decision_clusters');
      expect(tables).toContain('decision_cluster_members');
    });

    it('creates the decision_clusters_fts virtual table', () => {
      const tables = (
        store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'decision_clusters_fts%'",
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toContain('decision_clusters_fts');
    });

    it('migration is idempotent — re-opening an already-migrated DB does not error', () => {
      store.close();
      const reopened = new DecisionStore(dbPath);
      const tables = (
        reopened.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_clusters'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toContain('decision_clusters');
      reopened.close();
      store = new DecisionStore(dbPath); // afterEach close()
    });
  });

  describe('createCluster + getCluster', () => {
    function seedDecision(title: string): number {
      return store.addDecision({
        title,
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
    }

    it('persists a cluster with member ids and returns it', () => {
      const d1 = seedDecision('decision-1');
      const d2 = seedDecision('decision-2');
      const created = store.createCluster({
        project_root: projectRoot,
        title: 'Auth thinking',
        summary: 'How we approach authentication.',
        tags: ['auth', 'security'],
        primary_type: 'tech_choice',
        decision_ids: [d1, d2],
      });
      expect(created.id).toBeGreaterThan(0);
      expect(created.title).toBe('Auth thinking');
      expect(created.decision_count).toBe(2);
      expect(created.primary_type).toBe('tech_choice');
      expect(created.tags).toBe(JSON.stringify(['auth', 'security']));

      const fetched = store.getCluster(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe('Auth thinking');
    });

    it('getCluster returns undefined for an unknown id', () => {
      expect(store.getCluster(99999)).toBeUndefined();
    });

    it('stamps created_at as ISO and updated_at as unix ms', () => {
      const d1 = seedDecision('x');
      const c = store.createCluster({
        project_root: projectRoot,
        title: 'T',
        summary: 'S',
        decision_ids: [d1],
      });
      expect(Number.isNaN(Date.parse(c.created_at))).toBe(false);
      expect(typeof c.updated_at).toBe('number');
      expect(c.updated_at).toBeGreaterThan(0);
    });
  });

  describe('listClusters', () => {
    function seedCluster(title: string, count: number, opts?: { service?: string }): number {
      const ids: number[] = [];
      for (let i = 0; i < count; i++) {
        ids.push(
          store.addDecision({
            title: `${title}-${i}`,
            content: 'c',
            type: 'tech_choice',
            project_root: projectRoot,
            service_name: opts?.service,
          }).id,
        );
      }
      const c = store.createCluster({
        project_root: projectRoot,
        service_name: opts?.service ?? null,
        title,
        summary: `summary for ${title}`,
        tags: ['t'],
        decision_ids: ids,
      });
      return c.id;
    }

    it('returns clusters in decision_count DESC by default', () => {
      seedCluster('small', 2);
      seedCluster('big', 5);
      seedCluster('medium', 3);
      const list = store.listClusters({ project_root: projectRoot });
      expect(list.map((c) => c.title)).toEqual(['big', 'medium', 'small']);
    });

    it('filters by project_root', () => {
      seedCluster('here', 2);
      store.createCluster({
        project_root: '/other',
        title: 'other',
        summary: 's',
        decision_ids: [
          store.addDecision({
            title: 'x',
            content: 'c',
            type: 'tech_choice',
            project_root: '/other',
          }).id,
        ],
      });
      const list = store.listClusters({ project_root: projectRoot });
      expect(list.map((c) => c.title)).toEqual(['here']);
    });

    it('filters by service_name', () => {
      seedCluster('a', 2, { service: 'svc-a' });
      seedCluster('b', 2, { service: 'svc-b' });
      const list = store.listClusters({ project_root: projectRoot, service_name: 'svc-a' });
      expect(list.map((c) => c.title)).toEqual(['a']);
    });

    it('supports title ordering', () => {
      seedCluster('zebra', 2);
      seedCluster('alpha', 2);
      seedCluster('mango', 2);
      const list = store.listClusters({ project_root: projectRoot, order_by: 'title' });
      expect(list.map((c) => c.title)).toEqual(['alpha', 'mango', 'zebra']);
    });

    it('FTS search matches against title and summary', () => {
      seedCluster('Authentication strategy', 2);
      seedCluster('Deployment pipeline', 2);
      // Porter stemmer matches morphological variants of the same root, but
      // 'auth' is not a stem-related prefix of 'authentication'. Use the
      // FTS5 prefix-match operator for substring-style hits.
      const list = store.listClusters({ project_root: projectRoot, search: 'auth*' });
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe('Authentication strategy');
    });
  });

  describe('updateCluster', () => {
    it('updates title/summary/tags/primary_type and refreshes updated_at', async () => {
      const d1 = store.addDecision({
        title: 'd1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      const created = store.createCluster({
        project_root: projectRoot,
        title: 'Old title',
        summary: 'Old summary',
        tags: ['a'],
        primary_type: 'tech_choice',
        decision_ids: [d1],
      });
      const oldUpdatedAt = created.updated_at;
      // Tick a millisecond so updated_at changes deterministically.
      await new Promise((r) => setTimeout(r, 2));
      const updated = store.updateCluster(created.id, {
        title: 'New title',
        summary: 'New summary',
        tags: ['b', 'c'],
        primary_type: 'architecture_decision',
      })!;
      expect(updated.title).toBe('New title');
      expect(updated.summary).toBe('New summary');
      expect(updated.tags).toBe(JSON.stringify(['b', 'c']));
      expect(updated.primary_type).toBe('architecture_decision');
      expect(updated.updated_at).toBeGreaterThan(oldUpdatedAt);
    });

    it('replaces membership when decision_ids is provided', () => {
      const d1 = store.addDecision({
        title: 'd1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      const d2 = store.addDecision({
        title: 'd2',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      const d3 = store.addDecision({
        title: 'd3',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      const c = store.createCluster({
        project_root: projectRoot,
        title: 't',
        summary: 's',
        decision_ids: [d1, d2],
      });
      store.updateCluster(c.id, { decision_ids: [d2, d3] });
      const members = store.getClusterDecisions(c.id);
      expect(members.map((m) => m.id).sort()).toEqual([d2, d3].sort());
      const refreshed = store.getCluster(c.id)!;
      expect(refreshed.decision_count).toBe(2);
    });

    it('returns undefined for unknown cluster', () => {
      expect(store.updateCluster(9999, { title: 'x' })).toBeUndefined();
    });
  });

  describe('getClusterDecisions', () => {
    it('returns members of a cluster, default active-only', () => {
      const d1 = store.addDecision({
        title: 'live',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      const d2 = store.addDecision({
        title: 'dead',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      store.invalidateDecision(d2);
      const c = store.createCluster({
        project_root: projectRoot,
        title: 't',
        summary: 's',
        decision_ids: [d1, d2],
      });
      const active = store.getClusterDecisions(c.id);
      expect(active.map((m) => m.id)).toEqual([d1]);
      const all = store.getClusterDecisions(c.id, { include_invalidated: true });
      expect(all.map((m) => m.id).sort()).toEqual([d1, d2].sort());
    });

    it('respects the limit', () => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(
          store.addDecision({
            title: `d${i}`,
            content: 'c',
            type: 'tech_choice',
            project_root: projectRoot,
          }).id,
        );
      }
      const c = store.createCluster({
        project_root: projectRoot,
        title: 't',
        summary: 's',
        decision_ids: ids,
      });
      expect(store.getClusterDecisions(c.id, { limit: 2 })).toHaveLength(2);
    });
  });

  describe('findClustersForDecision', () => {
    it('returns clusters that contain a decision', () => {
      const d1 = store.addDecision({
        title: 'd1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      const d2 = store.addDecision({
        title: 'd2',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      const cA = store.createCluster({
        project_root: projectRoot,
        title: 'A',
        summary: 's',
        decision_ids: [d1, d2],
      });
      const cB = store.createCluster({
        project_root: projectRoot,
        title: 'B',
        summary: 's',
        decision_ids: [d1],
      });
      const clusters = store.findClustersForDecision(d1);
      expect(clusters.map((c) => c.id).sort()).toEqual([cA.id, cB.id].sort());

      const clustersForD2 = store.findClustersForDecision(d2);
      expect(clustersForD2.map((c) => c.id)).toEqual([cA.id]);
    });
  });

  describe('deleteCluster cascade', () => {
    it('drops the cluster and cascades the membership rows', () => {
      const d1 = store.addDecision({
        title: 'd1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      const c = store.createCluster({
        project_root: projectRoot,
        title: 't',
        summary: 's',
        decision_ids: [d1],
      });
      expect(store.deleteCluster(c.id)).toBe(true);
      expect(store.getCluster(c.id)).toBeUndefined();
      const memberCount = (
        store.db
          .prepare('SELECT COUNT(*) as c FROM decision_cluster_members WHERE cluster_id = ?')
          .get(c.id) as { c: number }
      ).c;
      expect(memberCount).toBe(0);
    });

    it('decision delete cascades membership row but leaves the cluster', () => {
      const d1 = store.addDecision({
        title: 'd1',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      const d2 = store.addDecision({
        title: 'd2',
        content: 'c',
        type: 'tech_choice',
        project_root: projectRoot,
      }).id;
      const c = store.createCluster({
        project_root: projectRoot,
        title: 't',
        summary: 's',
        decision_ids: [d1, d2],
      });
      store.deleteDecision(d1);
      expect(store.getCluster(c.id)).toBeDefined();
      const members = store.getClusterDecisions(c.id, { include_invalidated: true });
      expect(members.map((m) => m.id)).toEqual([d2]);
    });
  });

  describe('deleteClustersForScope + countClusters', () => {
    it('drops all clusters for a project', () => {
      for (const t of ['a', 'b', 'c']) {
        const d = store.addDecision({
          title: t,
          content: 'c',
          type: 'tech_choice',
          project_root: projectRoot,
        }).id;
        store.createCluster({
          project_root: projectRoot,
          title: t,
          summary: 's',
          decision_ids: [d],
        });
      }
      expect(store.countClusters({ project_root: projectRoot })).toBe(3);
      const removed = store.deleteClustersForScope({ project_root: projectRoot });
      expect(removed).toBe(3);
      expect(store.countClusters({ project_root: projectRoot })).toBe(0);
    });
  });
});
