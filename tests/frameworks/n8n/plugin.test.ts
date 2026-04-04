import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  N8nPlugin,
  parseN8nWorkflow,
  extractConnections,
  extractTriggers,
  extractRoutes,
  extractCodeNodes,
  extractSubWorkflowCalls,
  extractHttpRequests,
  extractStickyNotes,
  extractAiNodes,
  extractAllExpressionDeps,
  extractCredentialUsages,
  extractFlowControl,
  extractExpressionDeps,
  classifyNode,
  classifyAiNode,
  isTriggerNode,
  isAiNode,
} from '../../../src/indexer/plugins/framework/n8n/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/n8n-basic');
const ORDER_WF = path.join(FIXTURE_DIR, 'workflows/order-processing.json');
const AI_WF = path.join(FIXTURE_DIR, 'workflows/ai-chatbot.json');
const ERR_WF = path.join(FIXTURE_DIR, 'workflows/error-handler.json');
const PAYMENT_WF = path.join(FIXTURE_DIR, 'workflows/payment-flow.json');

function loadWorkflow(p: string) {
  return parseN8nWorkflow(fs.readFileSync(p))!;
}

describe('N8nPlugin', () => {
  let plugin: N8nPlugin;

  beforeEach(() => {
    plugin = new N8nPlugin();
  });

  // ── Detection ──────────────────────────────────────────────────────────

  describe('detect()', () => {
    it('returns true when workflow JSON files exist in workflows/ dir', () => {
      const ctx: ProjectContext = { rootPath: FIXTURE_DIR, configFiles: [] };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true with n8n-workflow dep', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-n8n-12345',
        packageJson: { dependencies: { 'n8n-workflow': '^1.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true with n8n-nodes-* custom node package', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-n8n-12345',
        packageJson: { devDependencies: { 'n8n-nodes-custom-crm': '^1.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true with n8n-core dep', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-n8n-12345',
        packageJson: { dependencies: { 'n8n-core': '^1.0.0' } },
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

    it('returns true when configFiles contains n8n reference', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nonexistent-n8n-12345',
        configFiles: ['.n8n/config'],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });
  });

  // ── Schema ─────────────────────────────────────────────────────────────

  describe('registerSchema()', () => {
    it('returns expanded node types', () => {
      const schema = plugin.registerSchema();
      const names = schema.nodeTypes!.map((n) => n.name);
      expect(names).toContain('n8n_workflow');
      expect(names).toContain('n8n_ai_node');
      expect(names).toContain('n8n_flow_control');
      expect(names).toContain('n8n_data_transform');
      expect(names).toContain('n8n_sticky_note');
    });

    it('returns expanded edge types', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('n8n_connection');
      expect(names).toContain('n8n_ai_connection');
      expect(names).toContain('n8n_error_connection');
      expect(names).toContain('n8n_expression_dep');
      expect(names).toContain('n8n_error_workflow');
      expect(names).toContain('n8n_conditional_branch');
    });

    it('all edge types have n8n category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('n8n');
      }
    });
  });

  // ── Parsing ────────────────────────────────────────────────────────────

  describe('parseN8nWorkflow()', () => {
    it('parses valid workflow JSON with all top-level fields', () => {
      const wf = loadWorkflow(ORDER_WF);
      expect(wf.name).toBe('Order Processing');
      expect(wf.id).toBe('wf-001');
      expect(wf.active).toBe(true);
      expect(wf.settings?.timezone).toBe('America/New_York');
      expect(wf.settings?.errorWorkflow).toBe('wf-err-001');
      expect(wf.meta?.templateId).toBe('tmpl-orders-v2');
      expect(wf.pinData).toBeDefined();
    });

    it('returns null for non-workflow JSON', () => {
      expect(parseN8nWorkflow(Buffer.from('{"foo":"bar"}'))).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(parseN8nWorkflow(Buffer.from('not json'))).toBeNull();
    });

    it('parses tags as array of objects', () => {
      const wf = loadWorkflow(ERR_WF);
      expect(wf.tags).toBeDefined();
      expect((wf.tags![0] as { name: string }).name).toBe('error-handling');
    });
  });

  // ── Connection extraction ──────────────────────────────────────────────

  describe('extractConnections()', () => {
    it('extracts main connections with connectionType', () => {
      const wf = loadWorkflow(ORDER_WF);
      const conns = extractConnections(wf);
      const mainConns = conns.filter((c) => c.connectionType === 'main');
      expect(mainConns.length).toBeGreaterThan(0);
      expect(conns.find((c) => c.sourceNode === 'Webhook Trigger' && c.targetNode === 'Validate Order')).toBeDefined();
    });

    it('extracts AI typed connections', () => {
      const wf = loadWorkflow(AI_WF);
      const conns = extractConnections(wf);
      const aiConns = conns.filter((c) => c.connectionType !== 'main');
      expect(aiConns.length).toBeGreaterThanOrEqual(5);
      expect(aiConns.find((c) => c.connectionType === 'ai_languageModel')).toBeDefined();
      expect(aiConns.find((c) => c.connectionType === 'ai_memory')).toBeDefined();
      expect(aiConns.find((c) => c.connectionType === 'ai_tool')).toBeDefined();
      expect(aiConns.find((c) => c.connectionType === 'ai_retriever')).toBeDefined();
      expect(aiConns.find((c) => c.connectionType === 'ai_vectorStore')).toBeDefined();
      expect(aiConns.find((c) => c.connectionType === 'ai_embedding')).toBeDefined();
    });

    it('extracts multi-output connections (IF true/false)', () => {
      const wf = loadWorkflow(ORDER_WF);
      const conns = extractConnections(wf);
      const ifConns = conns.filter((c) => c.sourceNode === 'Check Amount');
      expect(ifConns.filter((c) => c.sourceOutput === 0).length).toBeGreaterThanOrEqual(1);
      expect(ifConns.filter((c) => c.sourceOutput === 1).length).toBeGreaterThanOrEqual(1);
    });

    it('extracts switch multi-output connections', () => {
      const wf = loadWorkflow(ERR_WF);
      const conns = extractConnections(wf);
      const switchConns = conns.filter((c) => c.sourceNode === 'Route by Severity');
      expect(switchConns.length).toBe(3);
      expect(new Set(switchConns.map((c) => c.sourceOutput)).size).toBe(3);
    });
  });

  // ── Triggers ───────────────────────────────────────────────────────────

  describe('extractTriggers()', () => {
    it('finds webhook and schedule triggers', () => {
      const wf = loadWorkflow(ORDER_WF);
      const triggers = extractTriggers(wf);
      expect(triggers.length).toBe(2);
      expect(triggers.map((t) => t.type)).toContain('n8n-nodes-base.webhook');
      expect(triggers.map((t) => t.type)).toContain('n8n-nodes-base.scheduleTrigger');
    });

    it('finds AI chat trigger', () => {
      const wf = loadWorkflow(AI_WF);
      const triggers = extractTriggers(wf);
      expect(triggers.length).toBe(1);
      expect(triggers[0].type).toBe('@n8n/n8n-nodes-langchain.chatTrigger');
    });

    it('finds error trigger', () => {
      const wf = loadWorkflow(ERR_WF);
      const triggers = extractTriggers(wf);
      expect(triggers.length).toBe(1);
      expect(triggers[0].type).toBe('n8n-nodes-base.errorTrigger');
    });
  });

  // ── Route extraction ───────────────────────────────────────────────────

  describe('extractRoutes()', () => {
    it('extracts webhook routes', () => {
      const wf = loadWorkflow(ORDER_WF);
      const routes = extractRoutes(wf);
      const webhook = routes.find((r) => r.method === 'POST');
      expect(webhook).toBeDefined();
      expect(webhook!.uri).toBe('/orders/new');
      expect(webhook!.name).toBe('Webhook Trigger');
    });

    it('extracts schedule/cron routes', () => {
      const wf = loadWorkflow(ORDER_WF);
      const routes = extractRoutes(wf);
      // Disabled triggers are skipped
      const cronRoutes = routes.filter((r) => r.method === 'CRON');
      expect(cronRoutes.length).toBe(0);
    });

    it('extracts chat trigger routes', () => {
      const wf = loadWorkflow(AI_WF);
      const routes = extractRoutes(wf);
      const chatRoute = routes.find((r) => r.method === 'CHAT');
      expect(chatRoute).toBeDefined();
      expect(chatRoute!.uri).toContain('chat');
    });

    it('extracts workflow trigger entry points', () => {
      const wf = loadWorkflow(PAYMENT_WF);
      const routes = extractRoutes(wf);
      const wfRoute = routes.find((r) => r.method === 'WORKFLOW');
      expect(wfRoute).toBeDefined();
      expect(wfRoute!.name).toBe('Workflow Trigger');
    });
  });

  // ── Code nodes ─────────────────────────────────────────────────────────

  describe('extractCodeNodes()', () => {
    it('extracts code with expression dependencies', () => {
      const wf = loadWorkflow(AI_WF);
      const codes = extractCodeNodes(wf);
      expect(codes).toHaveLength(1);
      expect(codes[0].node.name).toBe('Format Answer');
      expect(codes[0].nodeDeps).toContain('Support Agent');
    });

    it('extracts jsCode from code nodes', () => {
      const wf = loadWorkflow(ORDER_WF);
      const codes = extractCodeNodes(wf);
      expect(codes).toHaveLength(1);
      expect(codes[0].code).toContain('order.items');
      expect(codes[0].language).toBe('javascript');
    });
  });

  // ── Sub-workflow calls ─────────────────────────────────────────────────

  describe('extractSubWorkflowCalls()', () => {
    it('extracts executeWorkflow references', () => {
      const wf = loadWorkflow(ORDER_WF);
      const calls = extractSubWorkflowCalls(wf);
      expect(calls).toHaveLength(1);
      expect(calls[0].workflowId).toBe('payment-flow');
      expect(calls[0].source).toBe('id');
    });

    it('extracts toolWorkflow references from AI workflows', () => {
      const wf = loadWorkflow(AI_WF);
      const calls = extractSubWorkflowCalls(wf);
      expect(calls).toHaveLength(1);
      expect(calls[0].workflowId).toBe('wf-001');
    });
  });

  // ── HTTP requests ──────────────────────────────────────────────────────

  describe('extractHttpRequests()', () => {
    it('extracts HTTP request nodes with auth', () => {
      const wf = loadWorkflow(ORDER_WF);
      const requests = extractHttpRequests(wf);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toContain('slack.com');
      expect(requests[0].method).toBe('POST');
      expect(requests[0].authentication).toBe('headerAuth');
    });
  });

  // ── Sticky notes ───────────────────────────────────────────────────────

  describe('extractStickyNotes()', () => {
    it('extracts sticky notes with content', () => {
      const wf = loadWorkflow(ORDER_WF);
      const notes = extractStickyNotes(wf);
      expect(notes).toHaveLength(1);
      expect(notes[0].content).toContain('Order Processing Pipeline');
      expect(notes[0].width).toBe(300);
      expect(notes[0].color).toBe(1);
    });

    it('extracts AI workflow sticky notes', () => {
      const wf = loadWorkflow(AI_WF);
      const notes = extractStickyNotes(wf);
      expect(notes).toHaveLength(1);
      expect(notes[0].content).toContain('GPT-4o');
    });
  });

  // ── AI node extraction ─────────────────────────────────────────────────

  describe('extractAiNodes()', () => {
    it('extracts all AI node types with roles', () => {
      const wf = loadWorkflow(AI_WF);
      const aiNodes = extractAiNodes(wf);
      expect(aiNodes.length).toBeGreaterThanOrEqual(6);

      const roles = aiNodes.map((n) => n.role);
      expect(roles).toContain('agent');
      expect(roles).toContain('llm');
      expect(roles).toContain('memory');
      expect(roles).toContain('tool');
      expect(roles).toContain('embedding');
      expect(roles).toContain('vector_store');
      expect(roles).toContain('retriever');
    });

    it('extracts model name from LLM nodes', () => {
      const wf = loadWorkflow(AI_WF);
      const aiNodes = extractAiNodes(wf);
      const llm = aiNodes.find((n) => n.role === 'llm');
      expect(llm).toBeDefined();
      expect(llm!.model).toBe('gpt-4o');
    });

    it('returns empty for non-AI workflow', () => {
      const wf = loadWorkflow(ERR_WF);
      expect(extractAiNodes(wf)).toHaveLength(0);
    });
  });

  // ── Node classification ────────────────────────────────────────────────

  describe('classifyNode()', () => {
    it('classifies trigger nodes', () => {
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.webhook', position: [0, 0] })).toBe('trigger');
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.githubTrigger', position: [0, 0] })).toBe('trigger');
    });

    it('classifies code nodes', () => {
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.code', position: [0, 0] })).toBe('code');
    });

    it('classifies flow control', () => {
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.if', position: [0, 0] })).toBe('flow_control');
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.switch', position: [0, 0] })).toBe('flow_control');
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.merge', position: [0, 0] })).toBe('flow_control');
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.splitInBatches', position: [0, 0] })).toBe('flow_control');
    });

    it('classifies data transforms', () => {
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.set', position: [0, 0] })).toBe('data_transform');
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.aggregate', position: [0, 0] })).toBe('data_transform');
    });

    it('classifies AI nodes', () => {
      expect(classifyNode({ name: 'x', type: '@n8n/n8n-nodes-langchain.agent', position: [0, 0] })).toBe('ai');
      expect(classifyNode({ name: 'x', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', position: [0, 0] })).toBe('ai');
    });

    it('classifies sticky notes', () => {
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.stickyNote', position: [0, 0] })).toBe('sticky_note');
    });

    it('classifies unknown types as action', () => {
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.slack', position: [0, 0] })).toBe('action');
      expect(classifyNode({ name: 'x', type: 'n8n-nodes-base.postgres', position: [0, 0] })).toBe('action');
    });
  });

  describe('classifyAiNode()', () => {
    it('classifies AI node roles correctly', () => {
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.agent')).toBe('agent');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.chainLlm')).toBe('chain');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.lmChatOpenAi')).toBe('llm');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.embeddingsOpenAi')).toBe('embedding');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.memoryBufferWindow')).toBe('memory');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.vectorStoreQdrant')).toBe('vector_store');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.retrieverVectorStore')).toBe('retriever');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.toolWorkflow')).toBe('tool');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.outputParserStructured')).toBe('output_parser');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.documentDefaultDataLoader')).toBe('document_loader');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter')).toBe('text_splitter');
      expect(classifyAiNode('@n8n/n8n-nodes-langchain.openAi')).toBe('standalone');
    });
  });

  // ── Expression dependencies ────────────────────────────────────────────

  describe('extractExpressionDeps()', () => {
    it('parses $node["Name"] references', () => {
      const deps = new Set<string>();
      extractExpressionDeps('={{ $node["My Node"].json.field }}', deps);
      expect(deps.has('My Node')).toBe(true);
    });

    it('parses $items("Name") references', () => {
      const deps = new Set<string>();
      extractExpressionDeps('={{ $items("Source Node").length }}', deps);
      expect(deps.has('Source Node')).toBe(true);
    });

    it('handles nested objects', () => {
      const deps = new Set<string>();
      extractExpressionDeps({ a: { b: '={{ $node["Deep"].json.x }}' } }, deps);
      expect(deps.has('Deep')).toBe(true);
    });
  });

  describe('extractAllExpressionDeps()', () => {
    it('finds cross-node expression references', () => {
      const wf = loadWorkflow(ORDER_WF);
      const deps = extractAllExpressionDeps(wf);
      const formatDeps = deps.get('Format Response');
      expect(formatDeps).toBeDefined();
      expect(formatDeps!.has('Save to Database')).toBe(true);
      expect(formatDeps!.has('Process Payment')).toBe(true);
    });
  });

  // ── Credential extraction ──────────────────────────────────────────────

  describe('extractCredentialUsages()', () => {
    it('extracts full credential details (type, id, name)', () => {
      const wf = loadWorkflow(ORDER_WF);
      const creds = extractCredentialUsages(wf);
      expect(creds.length).toBeGreaterThanOrEqual(2);

      const pg = creds.find((c) => c.credentialType === 'postgres');
      expect(pg).toBeDefined();
      expect(pg!.credentialId).toBe('1');
      expect(pg!.credentialName).toBe('Production DB');

      const http = creds.find((c) => c.credentialType === 'httpHeaderAuth');
      expect(http).toBeDefined();
      expect(http!.credentialId).toBe('5');
    });

    it('extracts AI credentials', () => {
      const wf = loadWorkflow(AI_WF);
      const creds = extractCredentialUsages(wf);
      const openai = creds.filter((c) => c.credentialType === 'openAiApi');
      expect(openai.length).toBe(2); // LLM + Embeddings both use it
      expect(openai[0].credentialId).toBe('10');
    });

    it('finds shared credentials across nodes in error handler', () => {
      const wf = loadWorkflow(ERR_WF);
      const creds = extractCredentialUsages(wf);
      const slack = creds.filter((c) => c.credentialType === 'slackApi');
      expect(slack.length).toBe(2); // both Slack nodes share cred id=20
      expect(slack.every((c) => c.credentialId === '20')).toBe(true);
    });
  });

  // ── Flow control analysis ──────────────────────────────────────────────

  describe('extractFlowControl()', () => {
    it('identifies IF, merge, loop, respond, filter nodes', () => {
      const wf = loadWorkflow(ORDER_WF);
      const conns = extractConnections(wf);
      const flow = extractFlowControl(wf, conns);

      const ifNode = flow.find((f) => f.controlType === 'conditional');
      expect(ifNode).toBeDefined();
      expect(ifNode!.outputCount).toBe(2);

      const merge = flow.find((f) => f.controlType === 'merge');
      expect(merge).toBeDefined();
      expect(merge!.mergeMode).toBe('multiplex');

      const loop = flow.find((f) => f.controlType === 'loop');
      expect(loop).toBeDefined();
      expect(loop!.batchSize).toBe(5);

      const respond = flow.find((f) => f.controlType === 'respond');
      expect(respond).toBeDefined();
    });

    it('identifies switch with multiple outputs', () => {
      const wf = loadWorkflow(ERR_WF);
      const conns = extractConnections(wf);
      const flow = extractFlowControl(wf, conns);

      const sw = flow.find((f) => f.controlType === 'switch');
      expect(sw).toBeDefined();
      expect(sw!.outputCount).toBe(3);
    });

    it('identifies filter nodes', () => {
      const wf = loadWorkflow(ERR_WF);
      const conns = extractConnections(wf);
      const flow = extractFlowControl(wf, conns);
      expect(flow.find((f) => f.controlType === 'filter')).toBeDefined();
    });
  });

  // ── extractNodes() integration ─────────────────────────────────────────

  describe('extractNodes() — order processing workflow', () => {
    it('classifies as webhook workflow with correct metadata', () => {
      const content = fs.readFileSync(ORDER_WF);
      const result = plugin.extractNodes('workflows/order-processing.json', content, 'json');
      expect(result.isOk()).toBe(true);
      const parsed = result._unsafeUnwrap();

      expect(parsed.frameworkRole).toBe('n8n_webhook_workflow');
      expect(parsed.metadata!.workflowName).toBe('Order Processing');
      expect(parsed.metadata!.workflowId).toBe('wf-001');
      expect(parsed.metadata!.active).toBe(true);
      expect(parsed.metadata!.tags).toEqual(['orders', 'production']);
      expect(parsed.metadata!.templateId).toBe('tmpl-orders-v2');
      expect(parsed.metadata!.hasPinData).toBe(true);
      expect(parsed.metadata!.settings).toBeDefined();
      expect((parsed.metadata!.settings as Record<string, unknown>).timezone).toBe('America/New_York');
    });

    it('skips sticky notes from symbols', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();
      const stickySymbols = parsed.symbols.filter((s) => s.name === 'Sticky Note');
      expect(stickySymbols).toHaveLength(0);
    });

    it('includes sticky notes in metadata', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();
      expect(parsed.metadata!.stickyNoteCount).toBe(1);
      expect((parsed.metadata!.stickyNotes as Array<{ content: string }>)[0].content).toContain('Order Processing');
    });

    it('produces symbols with category and error handling metadata', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();

      const validate = parsed.symbols.find((s) => s.name === 'Validate Order');
      expect(validate).toBeDefined();
      expect(validate!.metadata!.category).toBe('code');
      expect((validate!.metadata!.errorHandling as Record<string, unknown>).onError).toBe('continueErrorOutput');
      expect((validate!.metadata!.errorHandling as Record<string, unknown>).retryOnFail).toBe(true);
      expect((validate!.metadata!.errorHandling as Record<string, unknown>).maxTries).toBe(3);

      const db = parsed.symbols.find((s) => s.name === 'Save to Database');
      expect(db).toBeDefined();
      expect((db!.metadata!.errorHandling as Record<string, unknown>).continueOnFail).toBe(true);
      expect(db!.metadata!.notes).toBe('Insert into orders table, continue on duplicate key');
    });

    it('produces typed connection edges (main)', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();
      const connEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_connection');
      expect(connEdges.length).toBeGreaterThan(0);
      expect(connEdges[0].metadata!.connectionType).toBe('main');
    });

    it('produces conditional branch edges for IF node', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();
      const branches = parsed.edges!.filter((e) => e.edgeType === 'n8n_conditional_branch');
      expect(branches.length).toBeGreaterThanOrEqual(2);
      expect(branches.find((e) => e.metadata!.branch === 'true')).toBeDefined();
      expect(branches.find((e) => e.metadata!.branch === 'false')).toBeDefined();
    });

    it('produces expression dependency edges', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();
      const exprEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_expression_dep');
      expect(exprEdges.length).toBeGreaterThanOrEqual(2);
      expect(exprEdges.find((e) => e.metadata!.referencedNode === 'Save to Database')).toBeDefined();
      expect(exprEdges.find((e) => e.metadata!.referencedNode === 'Process Payment')).toBeDefined();
    });

    it('produces error workflow edge from settings', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();
      const errEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_error_workflow');
      expect(errEdges).toHaveLength(1);
      expect(errEdges[0].metadata!.targetWorkflowId).toBe('wf-err-001');
    });

    it('includes credential id and name in edges', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();
      const credEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_uses_credential');
      expect(credEdges.length).toBeGreaterThanOrEqual(2);
      const pg = credEdges.find((e) => e.metadata!.credentialType === 'postgres');
      expect(pg!.metadata!.credentialId).toBe('1');
      expect(pg!.metadata!.credentialName).toBe('Production DB');
    });

    it('includes authentication in HTTP request edges', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();
      const httpEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_http_request');
      expect(httpEdges).toHaveLength(1);
      expect(httpEdges[0].metadata!.authentication).toBe('headerAuth');
    });

    it('includes version in symbol signatures', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();
      const validate = parsed.symbols.find((s) => s.name === 'Validate Order');
      expect(validate!.signature).toContain('@2');
    });

    it('includes flow control metadata on symbols', () => {
      const content = fs.readFileSync(ORDER_WF);
      const parsed = plugin.extractNodes('wf.json', content, 'json')._unsafeUnwrap();
      const ifNode = parsed.symbols.find((s) => s.name === 'Check Amount');
      expect(ifNode).toBeDefined();
      expect(ifNode!.metadata!.category).toBe('flow_control');
      expect(ifNode!.metadata!.outputCount).toBe(2);

      const merge = parsed.symbols.find((s) => s.name === 'Merge Results');
      expect(merge!.metadata!.mergeMode).toBe('multiplex');

      const loop = parsed.symbols.find((s) => s.name === 'Process Items');
      expect(loop!.metadata!.batchSize).toBe(5);
    });
  });

  describe('extractNodes() — AI workflow', () => {
    it('classifies as AI workflow', () => {
      const content = fs.readFileSync(AI_WF);
      const parsed = plugin.extractNodes('ai-chatbot.json', content, 'json')._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('n8n_ai_workflow');
    });

    it('produces AI connection edges', () => {
      const content = fs.readFileSync(AI_WF);
      const parsed = plugin.extractNodes('ai-chatbot.json', content, 'json')._unsafeUnwrap();
      const aiEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_ai_connection');
      expect(aiEdges.length).toBeGreaterThanOrEqual(5);

      const types = aiEdges.map((e) => e.metadata!.aiConnectionType);
      expect(types).toContain('ai_languageModel');
      expect(types).toContain('ai_memory');
      expect(types).toContain('ai_tool');
      expect(types).toContain('ai_retriever');
    });

    it('includes AI role and model in symbol metadata', () => {
      const content = fs.readFileSync(AI_WF);
      const parsed = plugin.extractNodes('ai-chatbot.json', content, 'json')._unsafeUnwrap();

      const agent = parsed.symbols.find((s) => s.name === 'Support Agent');
      expect(agent!.metadata!.aiRole).toBe('agent');

      const llm = parsed.symbols.find((s) => s.name === 'OpenAI Model');
      expect(llm!.metadata!.aiRole).toBe('llm');
      expect(llm!.metadata!.aiModel).toBe('gpt-4o');

      const memory = parsed.symbols.find((s) => s.name === 'Chat Memory');
      expect(memory!.metadata!.aiRole).toBe('memory');
    });

    it('extracts chat route', () => {
      const content = fs.readFileSync(AI_WF);
      const parsed = plugin.extractNodes('ai-chatbot.json', content, 'json')._unsafeUnwrap();
      expect(parsed.routes!.find((r) => r.method === 'CHAT')).toBeDefined();
    });
  });

  describe('extractNodes() — error handler workflow', () => {
    it('classifies as error workflow', () => {
      const content = fs.readFileSync(ERR_WF);
      const parsed = plugin.extractNodes('error-handler.json', content, 'json')._unsafeUnwrap();
      expect(parsed.frameworkRole).toBe('n8n_error_workflow');
    });

    it('produces switch conditional branch edges', () => {
      const content = fs.readFileSync(ERR_WF);
      const parsed = plugin.extractNodes('error-handler.json', content, 'json')._unsafeUnwrap();
      const branches = parsed.edges!.filter((e) => e.edgeType === 'n8n_conditional_branch');
      expect(branches.length).toBe(3);
      expect(branches.find((e) => e.metadata!.branch === 'case_0')).toBeDefined();
      expect(branches.find((e) => e.metadata!.branch === 'case_1')).toBeDefined();
      expect(branches.find((e) => e.metadata!.branch === 'case_2')).toBeDefined();
    });

    it('normalizes object-style tags', () => {
      const content = fs.readFileSync(ERR_WF);
      const parsed = plugin.extractNodes('error-handler.json', content, 'json')._unsafeUnwrap();
      const tags = parsed.metadata!.tags as string[];
      expect(tags).toContain('error-handling');
      expect(tags).toContain('infrastructure');
    });
  });

  describe('extractNodes() — edge cases', () => {
    it('skips non-JSON files', () => {
      const result = plugin.extractNodes('test.ts', Buffer.from(''), 'typescript');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });

    it('skips non-workflow JSON', () => {
      const content = Buffer.from(JSON.stringify({ name: 'package', version: '1.0.0' }));
      const result = plugin.extractNodes('package.json', content, 'json');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().symbols).toHaveLength(0);
    });
  });

  // ── Manifest ───────────────────────────────────────────────────────────

  describe('manifest', () => {
    it('has correct name, version, and priority', () => {
      expect(plugin.manifest.name).toBe('n8n');
      expect(plugin.manifest.version).toBe('2.0.0');
      expect(plugin.manifest.priority).toBe(30);
    });
  });
});
