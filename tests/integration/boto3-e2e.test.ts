/**
 * AWS boto3 E2E integration test.
 * Asserts file → framework_role mapping and verifies that resolveEdges emits
 * aws_call edges with service/operation/op/resource metadata across S3, SSM,
 * Glue, and Lambda usage, while preserving 0 false positives on unrelated code.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { Boto3Plugin } from '../../src/indexer/plugins/integration/tooling/boto3/index.js';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { findReferences } from '../../src/tools/framework/references.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/boto3-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['**/*.py'],
    exclude: [],
    plugins: [],
  };
}

const EXPECTED_ROLES: Record<string, string | null> = {
  's3_service.py': 'boto3_client',
  's3_secondary.py': 'boto3_client',
  'ssm_service.py': 'boto3_client',
  'glue_service.py': 'boto3_client',
  'lambda_service.py': 'boto3_client',
  'unrelated.py': null,
};

interface EdgeWithMeta {
  meta: Record<string, unknown>;
  srcSymbolId: string | null;
  targetSymbolId?: string;
}

function loadEdges(store: Store, edgeType: string): EdgeWithMeta[] {
  const edges = store.getEdgesByType(edgeType);
  return edges.map((e) => {
    const meta = e.metadata ? JSON.parse(e.metadata) : {};
    const node = store.db
      .prepare('SELECT node_type, ref_id FROM nodes WHERE id = ?')
      .get(e.source_node_id) as { node_type: string; ref_id: number } | undefined;
    let srcSymbolId: string | null = null;
    if (node?.node_type === 'symbol') {
      const s = store.db.prepare('SELECT symbol_id FROM symbols WHERE id = ?').get(node.ref_id) as
        | { symbol_id: string }
        | undefined;
      if (s) srcSymbolId = s.symbol_id;
    }
    return { meta, srcSymbolId, targetSymbolId: meta.targetSymbolId };
  });
}

describe('AWS Boto3 E2E', () => {
  let store: Store;
  let fileByRel: Map<string, { framework_role: string | null }>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    registry.registerFrameworkPlugin(new Boto3Plugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();

    fileByRel = new Map();
    for (const f of store.getAllFiles()) {
      fileByRel.set(f.path.replace(/\\/g, '/'), f);
    }
  });

  describe('framework roles', () => {
    it.each(Object.entries(EXPECTED_ROLES))('tags %s with role %s', (rel, expectedRole) => {
      const file = fileByRel.get(rel);
      expect(file, `missing ${rel}`).toBeDefined();
      expect(file!.framework_role).toBe(expectedRole);
    });
  });

  describe('edges — S3 service and resources', () => {
    it('makes AWS operation targets navigable through find_usages', () => {
      const usages = findReferences(store, { symbolId: 'aws:s3:PutObject' });
      expect(usages.isOk()).toBe(true);
      if (usages.isErr()) return;
      expect(usages.value.references.map((ref) => ref.symbol?.symbol_id).sort()).toEqual([
        's3_secondary.py::write_secondary#function',
        's3_service.py::write_data#function',
      ]);
      expect(
        usages.value.references.every((ref) => ref.symbol?.symbol_id !== 'aws:s3:PutObject'),
      ).toBe(true);
    });

    it('emits GetObject read edge with bucket and key', () => {
      const edges = loadEdges(store, 'aws_call').filter((e) => e.meta.method === 'get_object');
      expect(edges).toHaveLength(1);
      const edge = edges[0];
      expect(edge.meta.service).toBe('s3');
      expect(edge.meta.operation).toBe('GetObject');
      expect(edge.meta.op).toBe('read');
      expect(edge.meta.bucket).toBe('analytics-bucket');
      expect(edge.meta.key).toBe('data/daily.json');
      expect(edge.meta.envVars).toContain('AWS_REGION');
      expect(edge.srcSymbolId).toContain('read_data');
    });

    it('emits PutObject, DeleteObject, and ListObjectsV2 edges', () => {
      const s3Edges = loadEdges(store, 'aws_call').filter((e) => e.meta.service === 's3');
      const ops = s3Edges.map((e) => e.meta.op).sort();
      expect(ops).toContain('write');
      expect(ops).toContain('delete');
      expect(ops).toContain('list');
    });

    it('emits UploadFile edge on S3 bucket resource', () => {
      const upload = loadEdges(store, 'aws_call').find((e) => e.meta.method === 'upload_file');
      expect(upload).toBeDefined();
      expect(upload?.meta.service).toBe('s3');
      expect(upload?.meta.operation).toBe('UploadFile');
      expect(upload?.srcSymbolId).toContain('sync_backup');
    });
  });

  describe('edges — SSM Parameter Store', () => {
    it('emits GetParameter read edge with parameter path', () => {
      const edge = loadEdges(store, 'aws_call').find((e) => e.meta.method === 'get_parameter');
      expect(edge).toBeDefined();
      expect(edge?.meta.service).toBe('ssm');
      expect(edge?.meta.operation).toBe('GetParameter');
      expect(edge?.meta.op).toBe('read');
      expect(edge?.meta.parameter).toBe('/prod/db/endpoint');
      expect(edge?.srcSymbolId).toContain('get_db_param');
    });

    it('emits GetParametersByPath and PutParameter edges', () => {
      const ssmEdges = loadEdges(store, 'aws_call').filter((e) => e.meta.service === 'ssm');
      expect(ssmEdges.some((e) => e.meta.method === 'get_parameters_by_path')).toBe(true);
      expect(ssmEdges.some((e) => e.meta.method === 'put_parameter')).toBe(true);
    });
  });

  describe('edges — Glue service', () => {
    it('emits StartJobRun write edge and GetJobRun read edge', () => {
      const glueEdges = loadEdges(store, 'aws_call').filter((e) => e.meta.service === 'glue');
      expect(glueEdges).toHaveLength(2);

      const start = glueEdges.find((e) => e.meta.method === 'start_job_run');
      expect(start).toBeDefined();
      expect(start?.meta.operation).toBe('StartJobRun');
      expect(start?.meta.op).toBe('write');
      expect(start?.meta.job).toBe('etl-orders-sync');
      expect(start?.srcSymbolId).toContain('start_etl');

      const check = glueEdges.find((e) => e.meta.method === 'get_job_run');
      expect(check).toBeDefined();
      expect(check?.meta.operation).toBe('GetJobRun');
      expect(check?.meta.op).toBe('read');
      expect(check?.srcSymbolId).toContain('check_etl');
    });
  });

  describe('edges — Lambda service', () => {
    it('emits Invoke write edge and GetFunction read edge', () => {
      const lambdaEdges = loadEdges(store, 'aws_call').filter((e) => e.meta.service === 'lambda');
      expect(lambdaEdges).toHaveLength(2);

      const invoke = lambdaEdges.find((e) => e.meta.method === 'invoke');
      expect(invoke).toBeDefined();
      expect(invoke?.meta.operation).toBe('Invoke');
      expect(invoke?.meta.op).toBe('write');
      expect(invoke?.meta.function).toBe('worker-dispatcher');
      expect(invoke?.srcSymbolId).toContain('invoke_worker');

      const getFn = lambdaEdges.find((e) => e.meta.method === 'get_function');
      expect(getFn).toBeDefined();
      expect(getFn?.meta.operation).toBe('GetFunction');
      expect(getFn?.meta.op).toBe('read');
      expect(getFn?.srcSymbolId).toContain('get_worker_info');
    });
  });

  describe('precision gate — no false links on unrelated code', () => {
    it('does not emit any aws_call edges for unrelated.py', () => {
      const allEdges = loadEdges(store, 'aws_call');
      const unrelatedEdges = allEdges.filter((e) => (e.srcSymbolId ?? '').includes('unrelated.py'));
      expect(unrelatedEdges).toHaveLength(0);
    });
  });
});
