import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopologyStore } from '../../src/topology/topology-db.js';

describe('TopologyStore', () => {
  let store: TopologyStore;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topo-db-'));
    dbPath = path.join(tmpDir, 'topology.db');
    store = new TopologyStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  describe('services', () => {
    it('upserts and retrieves a service', () => {
      const id = store.upsertService({
        name: 'auth-api',
        repoRoot: '/repo/auth',
        serviceType: 'microservice',
        detectionSource: 'docker-compose',
        dbPath: '/fake/db',
      });
      expect(id).toBeGreaterThan(0);

      const svc = store.getService('auth-api');
      expect(svc).toBeDefined();
      expect(svc!.name).toBe('auth-api');
      expect(svc!.service_type).toBe('microservice');
    });

    it('returns all services', () => {
      store.upsertService({ name: 'svc-a', repoRoot: '/a', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });
      store.upsertService({ name: 'svc-b', repoRoot: '/b', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });
      expect(store.getAllServices()).toHaveLength(2);
    });

    it('deletes a service', () => {
      const id = store.upsertService({ name: 'to-delete', repoRoot: '/d', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });
      store.deleteService(id);
      expect(store.getService('to-delete')).toBeUndefined();
    });

    it('upsert updates existing service', () => {
      store.upsertService({ name: 'svc', repoRoot: '/repo', serviceType: 'monolith', detectionSource: 'ws', dbPath: '/fake/db' });
      store.upsertService({ name: 'svc', repoRoot: '/repo', serviceType: 'microservice', detectionSource: 'docker', dbPath: '/fake/db' });
      const all = store.getAllServices();
      expect(all).toHaveLength(1);
      expect(all[0].service_type).toBe('microservice');
    });
  });

  describe('contracts and endpoints', () => {
    let serviceId: number;

    beforeEach(() => {
      serviceId = store.upsertService({ name: 'api', repoRoot: '/api', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });
    });

    it('inserts contract and endpoints', () => {
      const contractId = store.insertContract(serviceId, {
        contractType: 'openapi',
        specPath: 'openapi.json',
        version: '3.0.0',
        parsedSpec: '{}',
      });
      expect(contractId).toBeGreaterThan(0);

      store.insertEndpoints(contractId, serviceId, [
        { method: 'GET', path: '/users', operationId: 'listUsers' },
        { method: 'POST', path: '/users', operationId: 'createUser' },
      ]);

      const endpoints = store.getEndpointsByService(serviceId);
      expect(endpoints).toHaveLength(2);
    });

    it('finds endpoints by path', () => {
      const contractId = store.insertContract(serviceId, {
        contractType: 'openapi', specPath: 'api.json', version: '3.0.0', parsedSpec: '{}',
      });
      store.insertEndpoints(contractId, serviceId, [
        { method: 'GET', path: '/users', operationId: 'list' },
        { method: 'GET', path: '/orders', operationId: 'listOrders' },
      ]);

      const found = store.findEndpointByPath('/users');
      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(found[0].path).toBe('/users');
    });

    it('deletes contracts by service', () => {
      store.insertContract(serviceId, {
        contractType: 'openapi', specPath: 'a.json', version: '1', parsedSpec: '{}',
      });
      store.deleteContractsByService(serviceId);
      expect(store.getContractsByService(serviceId)).toHaveLength(0);
    });
  });

  describe('event channels', () => {
    it('inserts and retrieves events', () => {
      const svcId = store.upsertService({ name: 'events-svc', repoRoot: '/e', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });
      store.insertEventChannels(null, svcId, [
        { channelName: 'user.created', direction: 'publish' },
        { channelName: 'user.created', direction: 'subscribe' },
      ]);

      const events = store.getEventsByService(svcId);
      expect(events).toHaveLength(2);
    });

    it('matches producers and consumers', () => {
      const pub = store.upsertService({ name: 'pub-svc', repoRoot: '/pub', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });
      const sub = store.upsertService({ name: 'sub-svc', repoRoot: '/sub', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });

      store.insertEventChannels(null, pub, [{ channelName: 'order.placed', direction: 'publish' }]);
      store.insertEventChannels(null, sub, [{ channelName: 'order.placed', direction: 'subscribe' }]);

      const matches = store.matchProducersConsumers();
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0].channel).toBe('order.placed');
    });
  });

  describe('subprojects', () => {
    const PROJECT = '/projects/my-app';

    it('upserts and retrieves repos', () => {
      const id = store.upsertSubproject({ name: 'frontend', repoRoot: '/repos/frontend', projectRoot: PROJECT });
      expect(id).toBeGreaterThan(0);

      const repo = store.getSubproject('frontend');
      expect(repo).toBeDefined();
      expect(repo!.repo_root).toBe('/repos/frontend');
      expect(repo!.project_root).toBe(PROJECT);
    });

    it('retrieves by root path', () => {
      store.upsertSubproject({ name: 'backend', repoRoot: '/repos/backend', projectRoot: PROJECT });
      const repo = store.getSubproject('/repos/backend');
      expect(repo).toBeDefined();
      expect(repo!.name).toBe('backend');
    });

    it('filters by project root', () => {
      store.upsertSubproject({ name: 'a', repoRoot: '/a', projectRoot: '/project-1' });
      store.upsertSubproject({ name: 'b', repoRoot: '/b', projectRoot: '/project-1' });
      store.upsertSubproject({ name: 'c', repoRoot: '/c', projectRoot: '/project-2' });
      expect(store.getAllSubprojects()).toHaveLength(3);
      expect(store.getSubprojectsByProject('/project-1')).toHaveLength(2);
      expect(store.getSubprojectsByProject('/project-2')).toHaveLength(1);
    });

    it('same repo can belong to different projects', () => {
      store.upsertSubproject({ name: 'shared-lib', repoRoot: '/shared', projectRoot: '/project-1' });
      store.upsertSubproject({ name: 'shared-lib', repoRoot: '/shared', projectRoot: '/project-2' });
      expect(store.getAllSubprojects()).toHaveLength(2);
    });

    it('lists all repos', () => {
      store.upsertSubproject({ name: 'a', repoRoot: '/a', projectRoot: PROJECT });
      store.upsertSubproject({ name: 'b', repoRoot: '/b', projectRoot: PROJECT });
      expect(store.getAllSubprojects()).toHaveLength(2);
    });

    it('deletes a repo', () => {
      const id = store.upsertSubproject({ name: 'del', repoRoot: '/del', projectRoot: PROJECT });
      store.deleteSubproject(id);
      expect(store.getSubproject('del')).toBeUndefined();
    });

    it('updates sync time', () => {
      const id = store.upsertSubproject({ name: 'synced', repoRoot: '/synced', projectRoot: PROJECT });
      store.updateSubprojectSyncTime(id);
      const repo = store.getSubproject('synced');
      expect(repo!.last_synced).not.toBeNull();
    });
  });

  describe('client calls', () => {
    let repoId: number;

    beforeEach(() => {
      repoId = store.upsertSubproject({ name: 'client-repo', repoRoot: '/client', projectRoot: '/project' });
    });

    it('inserts and retrieves client calls', () => {
      store.insertClientCalls([
        { sourceRepoId: repoId, filePath: 'src/api.ts', line: 10, callType: 'fetch', method: 'GET', urlPattern: '/users', confidence: 0.9 },
        { sourceRepoId: repoId, filePath: 'src/api.ts', line: 20, callType: 'fetch', method: 'POST', urlPattern: '/orders', confidence: 0.8 },
      ]);

      const calls = store.getClientCallsByRepo(repoId);
      expect(calls).toHaveLength(2);
    });

    it('deletes client calls by repo', () => {
      store.insertClientCalls([
        { sourceRepoId: repoId, filePath: 'src/a.ts', line: 1, callType: 'axios', method: 'GET', urlPattern: '/x', confidence: 1 },
      ]);
      store.deleteClientCallsByRepo(repoId);
      expect(store.getClientCallsByRepo(repoId)).toHaveLength(0);
    });

    it('links client calls to endpoints', () => {
      const svcId = store.upsertService({ name: 'target', repoRoot: '/target', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });
      const contractId = store.insertContract(svcId, {
        contractType: 'openapi', specPath: 'api.json', version: '3', parsedSpec: '{}',
      });
      store.insertEndpoints(contractId, svcId, [
        { method: 'GET', path: '/users', operationId: 'listUsers' },
      ]);

      store.insertClientCalls([
        { sourceRepoId: repoId, filePath: 'src/api.ts', line: 5, callType: 'fetch', method: 'GET', urlPattern: '/users', confidence: 0.9 },
      ]);

      const linked = store.linkClientCallsToEndpoints();
      expect(linked).toBeGreaterThanOrEqual(1);
    });
  });

  describe('cross-service edges', () => {
    it('inserts and retrieves edges', () => {
      const a = store.upsertService({ name: 'a', repoRoot: '/a', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });
      const b = store.upsertService({ name: 'b', repoRoot: '/b', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });

      store.insertCrossServiceEdge({
        sourceServiceId: a,
        targetServiceId: b,
        edgeType: 'api_call',
        sourceRef: 'src/client.ts:10',
        targetRef: 'GET /users',
        confidence: 0.95,
      });

      const edges = store.getAllCrossServiceEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0].edge_type).toBe('api_call');

      expect(store.getEdgesBySource(a)).toHaveLength(1);
      expect(store.getEdgesByTarget(b)).toHaveLength(1);
    });
  });

  describe('contract snapshots', () => {
    it('stores and retrieves snapshots', () => {
      const svcId = store.upsertService({ name: 'snap-svc', repoRoot: '/snap', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });
      const contractId = store.insertContract(svcId, {
        contractType: 'openapi', specPath: 'api.json', version: '1.0', parsedSpec: '{}',
      });

      store.insertContractSnapshot(contractId, svcId, {
        version: '1.0',
        specPath: 'api.json',
        contentHash: 'abc123',
        endpointsJson: '{"endpoints":[]}',
        eventsJson: '[]',
      });

      const snapshots = store.getContractSnapshots(contractId);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].version).toBe('1.0');

      const latest = store.getLatestSnapshot(contractId);
      expect(latest).toBeDefined();
      expect(latest!.content_hash).toBe('abc123');
    });
  });

  describe('topology stats', () => {
    it('returns correct counts', () => {
      const svcId = store.upsertService({ name: 'stats-svc', repoRoot: '/stats', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });
      store.insertContract(svcId, {
        contractType: 'openapi', specPath: 'api.json', version: '1', parsedSpec: '{}',
      });

      const stats = store.getTopologyStats();
      expect(stats.services).toBe(1);
      expect(stats.contracts).toBe(1);
    });
  });

  describe('contract deduplication', () => {
    it('deleteContractsByService clears contracts and cascades to endpoints', () => {
      const svcId = store.upsertService({ name: 'dedup-svc', repoRoot: '/dedup', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });

      // Insert two contracts with endpoints
      const c1 = store.insertContract(svcId, {
        contractType: 'framework_routes', specPath: '/db1', version: 'auto', parsedSpec: '{}',
      });
      store.insertEndpoints(c1, svcId, [
        { method: 'GET', path: '/users' },
        { method: 'POST', path: '/users' },
      ]);
      const c2 = store.insertContract(svcId, {
        contractType: 'framework_routes', specPath: '/db2', version: 'auto', parsedSpec: '{}',
      });
      store.insertEndpoints(c2, svcId, [
        { method: 'GET', path: '/posts' },
      ]);

      expect(store.getContractsByService(svcId)).toHaveLength(2);
      expect(store.getEndpointsByService(svcId)).toHaveLength(3);

      // deleteContractsByService should clear everything
      store.deleteContractsByService(svcId);
      expect(store.getContractsByService(svcId)).toHaveLength(0);
      expect(store.getEndpointsByService(svcId)).toHaveLength(0);
    });

    it('calling registerContracts after deleteContractsByService avoids duplication', () => {
      const svcId = store.upsertService({ name: 'norep-svc', repoRoot: '/norep', serviceType: 'api', detectionSource: 'ws', dbPath: '/fake/db' });

      // Simulate first sync: add contracts
      const c1 = store.insertContract(svcId, {
        contractType: 'framework_routes', specPath: '/db', version: 'auto', parsedSpec: '{}',
      });
      store.insertEndpoints(c1, svcId, [
        { method: 'GET', path: '/users' },
        { method: 'POST', path: '/users' },
      ]);
      expect(store.getEndpointsByService(svcId)).toHaveLength(2);

      // Simulate second sync: delete first, then re-add
      store.deleteContractsByService(svcId);
      const c2 = store.insertContract(svcId, {
        contractType: 'framework_routes', specPath: '/db', version: 'auto', parsedSpec: '{}',
      });
      store.insertEndpoints(c2, svcId, [
        { method: 'GET', path: '/users' },
        { method: 'POST', path: '/users' },
        { method: 'DELETE', path: '/users/{id}' },
      ]);

      // Should have exactly the new set, no duplicates
      expect(store.getContractsByService(svcId)).toHaveLength(1);
      expect(store.getEndpointsByService(svcId)).toHaveLength(3);
    });
  });
});
