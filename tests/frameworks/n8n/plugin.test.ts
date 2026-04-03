import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  N8nPlugin,
  parseN8nWorkflow,
  extractConnections,
  extractTriggers,
  extractWebhookPaths,
  extractCodeNodes,
  extractSubWorkflowCalls,
  extractHttpRequests,
} from '../../../src/indexer/plugins/framework/n8n/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/n8n-basic');
const WORKFLOW_PATH = path.join(FIXTURE_DIR, 'workflows/order-processing.json');

describe('N8nPlugin', () => {
  let plugin: N8nPlugin;

  beforeEach(() => {
    plugin = new N8nPlugin();
  });

  describe('detect()', () => {
    it('returns true when workflow JSON files exist', () => {
      const ctx: ProjectContext = {
        rootPath: FIXTURE_DIR,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when packageJson has n8n-workflow dep', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-n8n-12345',
        packageJson: { dependencies: { 'n8n-workflow': '^1.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true when packageJson has n8n-nodes-base dep', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-n8n-12345',
        packageJson: { devDependencies: { 'n8n-nodes-base': '^1.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-n8n project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-n8n-12345',
        packageJson: { dependencies: { express: '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });
  });

  describe('registerSchema()', () => {
    it('returns expected node types', () => {
      const schema = plugin.registerSchema();
      const names = schema.nodeTypes!.map((n) => n.name);
      expect(names).toContain('n8n_workflow');
      expect(names).toContain('n8n_node');
      expect(names).toContain('n8n_trigger');
      expect(names).toContain('n8n_webhook');
      expect(names).toContain('n8n_code_node');
      expect(names).toContain('n8n_subworkflow_call');
    });

    it('returns expected edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('n8n_connection');
      expect(names).toContain('n8n_triggers');
      expect(names).toContain('n8n_webhook_route');
      expect(names).toContain('n8n_calls_subworkflow');
      expect(names).toContain('n8n_http_request');
      expect(names).toContain('n8n_uses_credential');
    });

    it('all edge types have n8n category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('n8n');
      }
    });
  });

  describe('parseN8nWorkflow()', () => {
    it('parses valid workflow JSON', () => {
      const content = fs.readFileSync(WORKFLOW_PATH);
      const wf = parseN8nWorkflow(content);
      expect(wf).not.toBeNull();
      expect(wf!.name).toBe('Order Processing');
      expect(wf!.nodes).toHaveLength(6);
      expect(wf!.active).toBe(true);
    });

    it('returns null for non-workflow JSON', () => {
      const content = Buffer.from(JSON.stringify({ foo: 'bar' }));
      expect(parseN8nWorkflow(content)).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const content = Buffer.from('not json at all');
      expect(parseN8nWorkflow(content)).toBeNull();
    });
  });

  describe('extractConnections()', () => {
    it('extracts all connections', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(WORKFLOW_PATH))!;
      const conns = extractConnections(wf);
      expect(conns.length).toBe(4); // trigger→validate, validate→db, validate→notify, db→payment
      expect(conns.find((c) => c.sourceNode === 'Webhook Trigger' && c.targetNode === 'Validate Order')).toBeDefined();
      expect(conns.find((c) => c.sourceNode === 'Validate Order' && c.targetNode === 'Save to Database')).toBeDefined();
      expect(conns.find((c) => c.sourceNode === 'Validate Order' && c.targetNode === 'Send Notification')).toBeDefined();
      expect(conns.find((c) => c.sourceNode === 'Save to Database' && c.targetNode === 'Process Payment')).toBeDefined();
    });
  });

  describe('extractTriggers()', () => {
    it('finds trigger nodes', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(WORKFLOW_PATH))!;
      const triggers = extractTriggers(wf);
      expect(triggers.length).toBe(2);
      const types = triggers.map((t) => t.type);
      expect(types).toContain('n8n-nodes-base.webhook');
      expect(types).toContain('n8n-nodes-base.scheduleTrigger');
    });
  });

  describe('extractWebhookPaths()', () => {
    it('extracts webhook routes', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(WORKFLOW_PATH))!;
      const routes = extractWebhookPaths(wf);
      expect(routes).toHaveLength(1);
      expect(routes[0].uri).toBe('/orders/new');
      expect(routes[0].method).toBe('POST');
      expect(routes[0].name).toBe('Webhook Trigger');
    });
  });

  describe('extractCodeNodes()', () => {
    it('extracts code node content', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(WORKFLOW_PATH))!;
      const codeNodes = extractCodeNodes(wf);
      expect(codeNodes).toHaveLength(1);
      expect(codeNodes[0].node.name).toBe('Validate Order');
      expect(codeNodes[0].code).toContain('order.items');
      expect(codeNodes[0].language).toBe('javascript');
    });
  });

  describe('extractSubWorkflowCalls()', () => {
    it('extracts sub-workflow references', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(WORKFLOW_PATH))!;
      const calls = extractSubWorkflowCalls(wf);
      expect(calls).toHaveLength(1);
      expect(calls[0].node.name).toBe('Process Payment');
      expect(calls[0].workflowId).toBe('payment-flow');
    });
  });

  describe('extractHttpRequests()', () => {
    it('extracts HTTP request nodes', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(WORKFLOW_PATH))!;
      const requests = extractHttpRequests(wf);
      expect(requests).toHaveLength(1);
      expect(requests[0].node.name).toBe('Send Notification');
      expect(requests[0].method).toBe('POST');
    });
  });

  describe('extractNodes()', () => {
    it('extracts workflow symbols and edges from JSON', () => {
      const content = fs.readFileSync(WORKFLOW_PATH);
      const result = plugin.extractNodes('workflows/order-processing.json', content, 'json');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();

      expect(parsed.frameworkRole).toBe('n8n_workflow');
      expect(parsed.symbols.length).toBe(6);
      expect(parsed.edges!.length).toBeGreaterThan(0);
      expect(parsed.routes!.length).toBe(1);

      // Check workflow metadata
      expect(parsed.metadata!.workflowName).toBe('Order Processing');
      expect(parsed.metadata!.active).toBe(true);
      expect(parsed.metadata!.nodeCount).toBe(6);
    });

    it('creates connection edges', () => {
      const content = fs.readFileSync(WORKFLOW_PATH);
      const result = plugin.extractNodes('workflows/order-processing.json', content, 'json');
      const parsed = result._unsafeUnwrap();

      const connectionEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_connection');
      expect(connectionEdges.length).toBe(4);
    });

    it('creates trigger edges', () => {
      const content = fs.readFileSync(WORKFLOW_PATH);
      const result = plugin.extractNodes('workflows/order-processing.json', content, 'json');
      const parsed = result._unsafeUnwrap();

      const triggerEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_triggers');
      expect(triggerEdges.length).toBeGreaterThanOrEqual(1);
    });

    it('creates credential edges', () => {
      const content = fs.readFileSync(WORKFLOW_PATH);
      const result = plugin.extractNodes('workflows/order-processing.json', content, 'json');
      const parsed = result._unsafeUnwrap();

      const credEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_uses_credential');
      expect(credEdges.length).toBe(1);
      expect(credEdges[0].metadata!.credentialType).toBe('postgres');
    });

    it('creates sub-workflow edges', () => {
      const content = fs.readFileSync(WORKFLOW_PATH);
      const result = plugin.extractNodes('workflows/order-processing.json', content, 'json');
      const parsed = result._unsafeUnwrap();

      const subWfEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_calls_subworkflow');
      expect(subWfEdges.length).toBe(1);
      expect(subWfEdges[0].metadata!.targetWorkflowId).toBe('payment-flow');
    });

    it('creates HTTP request edges', () => {
      const content = fs.readFileSync(WORKFLOW_PATH);
      const result = plugin.extractNodes('workflows/order-processing.json', content, 'json');
      const parsed = result._unsafeUnwrap();

      const httpEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_http_request');
      expect(httpEdges.length).toBe(1);
      expect(httpEdges[0].metadata!.method).toBe('POST');
    });

    it('skips non-JSON files', () => {
      const result = plugin.extractNodes('test.ts', Buffer.from(''), 'typescript');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });

    it('skips non-workflow JSON files', () => {
      const content = Buffer.from(JSON.stringify({ name: 'package', version: '1.0.0' }));
      const result = plugin.extractNodes('package.json', content, 'json');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  describe('manifest', () => {
    it('has correct name and priority', () => {
      expect(plugin.manifest.name).toBe('n8n');
      expect(plugin.manifest.priority).toBe(30);
    });
  });
});
