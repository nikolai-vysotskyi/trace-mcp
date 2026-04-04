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
  classifyNode,
  classifyAiNode,
  extractExpressionDeps,
  getServiceDomain,
  isTriggerNode,
} from '../../../src/indexer/plugins/integration/n8n/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/n8n-basic');
const ORDER_WF = path.join(FIXTURE_DIR, 'workflows/order-processing.json');
const AI_WF = path.join(FIXTURE_DIR, 'workflows/ai-chatbot.json');
const ERROR_WF = path.join(FIXTURE_DIR, 'workflows/error-handler.json');

describe('N8nPlugin', () => {
  let plugin: N8nPlugin;

  beforeEach(() => {
    plugin = new N8nPlugin();
  });

  // ── detect() ─────────────────────────────────────────────────────────

  describe('detect()', () => {
    it('returns true when workflow JSON files exist in workflows/', () => {
      const ctx: ProjectContext = { rootPath: FIXTURE_DIR, configFiles: [] };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true for n8n-workflow dep', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nx-n8n-00000',
        packageJson: { dependencies: { 'n8n-workflow': '^1.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true for n8n-nodes-base devDep', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nx-n8n-00001',
        packageJson: { devDependencies: { 'n8n-nodes-base': '^1.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true for custom node package', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nx-n8n-00002',
        packageJson: { dependencies: { 'n8n-nodes-my-custom': '^0.1.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns true for n8n-core dep', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nx-n8n-00003',
        packageJson: { dependencies: { 'n8n-core': '^1.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for non-n8n project', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nx-n8n-00004',
        packageJson: { dependencies: { express: '^4.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('detects via configFiles containing n8n', () => {
      const ctx: ProjectContext = {
        rootPath: '/tmp/nx-n8n-00005',
        configFiles: ['.n8n/config'],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });
  });

  // ── registerSchema() ─────────────────────────────────────────────────

  describe('registerSchema()', () => {
    it('returns all node types', () => {
      const schema = plugin.registerSchema();
      const names = schema.nodeTypes!.map((n) => n.name);
      expect(names).toContain('n8n_workflow');
      expect(names).toContain('n8n_ai_node');
      expect(names).toContain('n8n_flow_control');
      expect(names).toContain('n8n_data_transform');
      expect(names).toContain('n8n_sticky_note');
      expect(names.length).toBe(10);
    });

    it('returns all edge types including AI and error connections', () => {
      const schema = plugin.registerSchema();
      const names = schema.edgeTypes!.map((e) => e.name);
      expect(names).toContain('n8n_connection');
      expect(names).toContain('n8n_ai_connection');
      expect(names).toContain('n8n_error_connection');
      expect(names).toContain('n8n_expression_dep');
      expect(names).toContain('n8n_error_workflow');
      expect(names).toContain('n8n_conditional_branch');
      expect(names).toContain('n8n_external_service');
      expect(names.length).toBe(12);
    });

    it('all edge types have n8n category', () => {
      const schema = plugin.registerSchema();
      for (const et of schema.edgeTypes!) {
        expect(et.category).toBe('n8n');
      }
    });
  });

  // ── parseN8nWorkflow() ───────────────────────────────────────────────

  describe('parseN8nWorkflow()', () => {
    it('parses valid workflow JSON with id', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF));
      expect(wf).not.toBeNull();
      expect(wf!.name).toBe('Order Processing');
      expect(wf!.id).toBe('wf-001');
      expect(wf!.active).toBe(true);
    });

    it('parses workflow settings', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      expect(wf.settings).toBeDefined();
      expect(wf.settings!.timezone).toBe('America/New_York');
      expect(wf.settings!.errorWorkflow).toBe('wf-err-001');
      expect(wf.settings!.executionTimeout).toBe(300);
    });

    it('parses AI workflow', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      expect(wf.name).toBe('AI Customer Support');
      expect(wf.nodes.some((n) => n.type.includes('langchain'))).toBe(true);
    });

    it('returns null for non-workflow JSON', () => {
      expect(parseN8nWorkflow(Buffer.from('{"foo":"bar"}'))).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(parseN8nWorkflow(Buffer.from('not json'))).toBeNull();
    });

    it('parses pinData', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      expect(wf.pinData).toBeDefined();
      expect(wf.pinData!['Webhook Trigger']).toBeDefined();
    });

    it('parses meta/templateId', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      expect(wf.meta?.templateId).toBe('tmpl-orders-v2');
    });
  });

  // ── extractConnections() ─────────────────────────────────────────────

  describe('extractConnections()', () => {
    it('extracts main connections with connectionType', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const conns = extractConnections(wf);
      expect(conns.length).toBeGreaterThanOrEqual(8);
      for (const c of conns) {
        expect(c.connectionType).toBe('main');
      }
    });

    it('extracts AI-typed connections', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const conns = extractConnections(wf);
      const aiConns = conns.filter((c) => c.connectionType !== 'main');
      expect(aiConns.length).toBeGreaterThanOrEqual(5);

      const types = new Set(aiConns.map((c) => c.connectionType));
      expect(types.has('ai_languageModel')).toBe(true);
      expect(types.has('ai_memory')).toBe(true);
      expect(types.has('ai_tool')).toBe(true);
      expect(types.has('ai_retriever')).toBe(true);
      expect(types.has('ai_vectorStore')).toBe(true);
    });

    it('preserves output index for IF branching', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const conns = extractConnections(wf);
      const ifConns = conns.filter((c) => c.sourceNode === 'Check Amount');
      const trueConns = ifConns.filter((c) => c.sourceOutput === 0);
      const falseConns = ifConns.filter((c) => c.sourceOutput === 1);
      expect(trueConns.length).toBe(2);
      expect(falseConns.length).toBe(1);
    });

    it('handles switch node multi-output', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ERROR_WF))!;
      const conns = extractConnections(wf);
      const switchConns = conns.filter((c) => c.sourceNode === 'Route by Severity');
      expect(switchConns.length).toBe(3);
      expect(switchConns[0].sourceOutput).toBe(0);
      expect(switchConns[1].sourceOutput).toBe(1);
      expect(switchConns[2].sourceOutput).toBe(2);
    });
  });

  // ── Node classification ──────────────────────────────────────────────

  describe('classifyNode()', () => {
    it('classifies trigger nodes', () => {
      expect(classifyNode({ name: 'T', type: 'n8n-nodes-base.webhook', position: [0, 0] })).toBe('trigger');
      expect(classifyNode({ name: 'T', type: 'n8n-nodes-base.scheduleTrigger', position: [0, 0] })).toBe('trigger');
      expect(classifyNode({ name: 'T', type: 'n8n-nodes-base.gmailTrigger', position: [0, 0] })).toBe('trigger');
    });

    it('classifies code nodes', () => {
      expect(classifyNode({ name: 'C', type: 'n8n-nodes-base.code', position: [0, 0] })).toBe('code');
      expect(classifyNode({ name: 'C', type: 'n8n-nodes-base.function', position: [0, 0] })).toBe('code');
    });

    it('classifies flow control nodes', () => {
      expect(classifyNode({ name: 'F', type: 'n8n-nodes-base.if', position: [0, 0] })).toBe('flow_control');
      expect(classifyNode({ name: 'F', type: 'n8n-nodes-base.switch', position: [0, 0] })).toBe('flow_control');
      expect(classifyNode({ name: 'F', type: 'n8n-nodes-base.merge', position: [0, 0] })).toBe('flow_control');
      expect(classifyNode({ name: 'F', type: 'n8n-nodes-base.splitInBatches', position: [0, 0] })).toBe('flow_control');
      expect(classifyNode({ name: 'F', type: 'n8n-nodes-base.wait', position: [0, 0] })).toBe('flow_control');
    });

    it('classifies data transform nodes', () => {
      expect(classifyNode({ name: 'D', type: 'n8n-nodes-base.set', position: [0, 0] })).toBe('data_transform');
      expect(classifyNode({ name: 'D', type: 'n8n-nodes-base.itemLists', position: [0, 0] })).toBe('data_transform');
      expect(classifyNode({ name: 'D', type: 'n8n-nodes-base.crypto', position: [0, 0] })).toBe('data_transform');
    });

    it('classifies AI nodes', () => {
      expect(classifyNode({ name: 'A', type: '@n8n/n8n-nodes-langchain.agent', position: [0, 0] })).toBe('ai');
      expect(classifyNode({ name: 'A', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', position: [0, 0] })).toBe('ai');
    });

    it('classifies sticky notes', () => {
      expect(classifyNode({ name: 'S', type: 'n8n-nodes-base.stickyNote', position: [0, 0] })).toBe('sticky_note');
    });

    it('classifies subworkflow nodes', () => {
      expect(classifyNode({ name: 'E', type: 'n8n-nodes-base.executeWorkflow', position: [0, 0] })).toBe('subworkflow');
      expect(classifyNode({ name: 'E', type: '@n8n/n8n-nodes-langchain.toolWorkflow', position: [0, 0] })).toBe('subworkflow');
    });

    it('classifies http request nodes', () => {
      expect(classifyNode({ name: 'H', type: 'n8n-nodes-base.httpRequest', position: [0, 0] })).toBe('http_request');
      expect(classifyNode({ name: 'H', type: 'n8n-nodes-base.graphql', position: [0, 0] })).toBe('http_request');
    });

    it('falls back to action for generic nodes', () => {
      expect(classifyNode({ name: 'G', type: 'n8n-nodes-base.postgres', position: [0, 0] })).toBe('action');
      expect(classifyNode({ name: 'G', type: 'n8n-nodes-base.slack', position: [0, 0] })).toBe('action');
    });
  });

  describe('classifyAiNode()', () => {
    it('classifies agent', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.agent')).toBe('agent'));
    it('classifies chain', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.chainLlm')).toBe('chain'));
    it('classifies llm', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.lmChatOpenAi')).toBe('llm'));
    it('classifies embedding', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.embeddingsOpenAi')).toBe('embedding'));
    it('classifies memory', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.memoryBufferWindow')).toBe('memory'));
    it('classifies vector_store', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.vectorStoreQdrant')).toBe('vector_store'));
    it('classifies retriever', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.retrieverVectorStore')).toBe('retriever'));
    it('classifies tool', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.toolWorkflow')).toBe('tool'));
    it('classifies output_parser', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.outputParserStructured')).toBe('output_parser'));
    it('classifies document_loader', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.documentDefaultDataLoader')).toBe('document_loader'));
    it('classifies text_splitter', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter')).toBe('text_splitter'));
    it('classifies standalone', () => expect(classifyAiNode('@n8n/n8n-nodes-langchain.openAi')).toBe('standalone'));
  });

  // ── isTriggerNode() — pattern-based trigger detection ──────────────────

  describe('isTriggerNode()', () => {
    it('matches core triggers', () => {
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-base.webhook', position: [0, 0] })).toBe(true);
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-base.cron', position: [0, 0] })).toBe(true);
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-base.emailReadImap', position: [0, 0] })).toBe(true);
    });

    it('matches ANY node ending in Trigger (pattern-based)', () => {
      // These are NOT in any hardcoded set — they work by suffix matching
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-base.shopifyTrigger', position: [0, 0] })).toBe(true);
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-base.hubspotTrigger', position: [0, 0] })).toBe(true);
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-base.notionTrigger', position: [0, 0] })).toBe(true);
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-base.typeformTrigger', position: [0, 0] })).toBe(true);
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-base.jiraTrigger', position: [0, 0] })).toBe(true);
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-base.woocommerceTrigger', position: [0, 0] })).toBe(true);
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-base.salesforceTrigger', position: [0, 0] })).toBe(true);
    });

    it('matches community/custom node triggers', () => {
      expect(isTriggerNode({ name: 'T', type: 'n8n-nodes-custom.myServiceTrigger', position: [0, 0] })).toBe(true);
    });

    it('does not match action nodes', () => {
      expect(isTriggerNode({ name: 'N', type: 'n8n-nodes-base.slack', position: [0, 0] })).toBe(false);
      expect(isTriggerNode({ name: 'N', type: 'n8n-nodes-base.postgres', position: [0, 0] })).toBe(false);
    });
  });

  // ── getServiceDomain() — full taxonomy ────────────────────────────────

  describe('getServiceDomain()', () => {
    it('resolves communication services', () => {
      expect(getServiceDomain('n8n-nodes-base.slack')).toBe('communication');
      expect(getServiceDomain('n8n-nodes-base.discord')).toBe('communication');
      expect(getServiceDomain('n8n-nodes-base.telegram')).toBe('communication');
      expect(getServiceDomain('n8n-nodes-base.microsoftTeams')).toBe('communication');
      expect(getServiceDomain('n8n-nodes-base.gmail')).toBe('communication');
      expect(getServiceDomain('n8n-nodes-base.twilio')).toBe('communication');
      expect(getServiceDomain('n8n-nodes-base.sendgrid')).toBe('communication');
      expect(getServiceDomain('n8n-nodes-base.whatsApp')).toBe('communication');
    });

    it('resolves trigger variants to same domain', () => {
      expect(getServiceDomain('n8n-nodes-base.slackTrigger')).toBe('communication');
      expect(getServiceDomain('n8n-nodes-base.gmailTrigger')).toBe('communication');
      expect(getServiceDomain('n8n-nodes-base.telegramTrigger')).toBe('communication');
    });

    it('resolves database services', () => {
      expect(getServiceDomain('n8n-nodes-base.postgres')).toBe('database');
      expect(getServiceDomain('n8n-nodes-base.mysql')).toBe('database');
      expect(getServiceDomain('n8n-nodes-base.mongodb')).toBe('database');
      expect(getServiceDomain('n8n-nodes-base.redis')).toBe('database');
      expect(getServiceDomain('n8n-nodes-base.elasticsearch')).toBe('database');
      expect(getServiceDomain('n8n-nodes-base.supabase')).toBe('database');
      expect(getServiceDomain('n8n-nodes-base.snowflake')).toBe('database');
    });

    it('resolves cloud storage', () => {
      expect(getServiceDomain('n8n-nodes-base.s3')).toBe('cloud_storage');
      expect(getServiceDomain('n8n-nodes-base.googleDrive')).toBe('cloud_storage');
      expect(getServiceDomain('n8n-nodes-base.dropbox')).toBe('cloud_storage');
      expect(getServiceDomain('n8n-nodes-base.ftp')).toBe('cloud_storage');
    });

    it('resolves dev tools', () => {
      expect(getServiceDomain('n8n-nodes-base.github')).toBe('dev_tools');
      expect(getServiceDomain('n8n-nodes-base.gitlab')).toBe('dev_tools');
      expect(getServiceDomain('n8n-nodes-base.jira')).toBe('dev_tools');
      expect(getServiceDomain('n8n-nodes-base.linear')).toBe('dev_tools');
      expect(getServiceDomain('n8n-nodes-base.sentry')).toBe('dev_tools');
    });

    it('resolves CRM & sales', () => {
      expect(getServiceDomain('n8n-nodes-base.salesforce')).toBe('crm_sales');
      expect(getServiceDomain('n8n-nodes-base.hubspot')).toBe('crm_sales');
      expect(getServiceDomain('n8n-nodes-base.pipedrive')).toBe('crm_sales');
    });

    it('resolves productivity', () => {
      expect(getServiceDomain('n8n-nodes-base.googleSheets')).toBe('productivity');
      expect(getServiceDomain('n8n-nodes-base.airtable')).toBe('productivity');
      expect(getServiceDomain('n8n-nodes-base.notion')).toBe('productivity');
      expect(getServiceDomain('n8n-nodes-base.asana')).toBe('productivity');
      expect(getServiceDomain('n8n-nodes-base.trello')).toBe('productivity');
    });

    it('resolves marketing', () => {
      expect(getServiceDomain('n8n-nodes-base.mailchimp')).toBe('marketing');
      expect(getServiceDomain('n8n-nodes-base.convertKit')).toBe('marketing');
    });

    it('resolves finance', () => {
      expect(getServiceDomain('n8n-nodes-base.stripe')).toBe('finance');
      expect(getServiceDomain('n8n-nodes-base.paypal')).toBe('finance');
      expect(getServiceDomain('n8n-nodes-base.quickBooks')).toBe('finance');
    });

    it('resolves ecommerce', () => {
      expect(getServiceDomain('n8n-nodes-base.shopify')).toBe('ecommerce');
      expect(getServiceDomain('n8n-nodes-base.woocommerce')).toBe('ecommerce');
    });

    it('resolves CMS', () => {
      expect(getServiceDomain('n8n-nodes-base.wordpress')).toBe('cms');
      expect(getServiceDomain('n8n-nodes-base.strapi')).toBe('cms');
      expect(getServiceDomain('n8n-nodes-base.ghost')).toBe('cms');
    });

    it('resolves social media', () => {
      expect(getServiceDomain('n8n-nodes-base.twitter')).toBe('social_media');
      expect(getServiceDomain('n8n-nodes-base.facebook')).toBe('social_media');
      expect(getServiceDomain('n8n-nodes-base.linkedin')).toBe('social_media');
    });

    it('resolves security', () => {
      expect(getServiceDomain('n8n-nodes-base.theHive')).toBe('security');
      expect(getServiceDomain('n8n-nodes-base.virusTotal')).toBe('security');
    });

    it('resolves support/helpdesk', () => {
      expect(getServiceDomain('n8n-nodes-base.zendesk')).toBe('support');
      expect(getServiceDomain('n8n-nodes-base.freshdesk')).toBe('support');
    });

    it('resolves cloud infrastructure', () => {
      expect(getServiceDomain('n8n-nodes-base.awsLambda')).toBe('cloud_infra');
      expect(getServiceDomain('n8n-nodes-base.awsSqs')).toBe('cloud_infra');
    });

    it('resolves forms/surveys', () => {
      expect(getServiceDomain('n8n-nodes-base.typeform')).toBe('forms_surveys');
      expect(getServiceDomain('n8n-nodes-base.jotform')).toBe('forms_surveys');
    });

    it('resolves HR/recruiting', () => {
      expect(getServiceDomain('n8n-nodes-base.bambooHr')).toBe('hr_recruiting');
    });

    it('resolves design/media', () => {
      expect(getServiceDomain('n8n-nodes-base.figma')).toBe('design');
    });

    it('resolves IoT', () => {
      expect(getServiceDomain('n8n-nodes-base.mqtt')).toBe('iot_hardware');
    });

    it('returns undefined for utility/core nodes', () => {
      expect(getServiceDomain('n8n-nodes-base.set')).toBeUndefined();
      expect(getServiceDomain('n8n-nodes-base.if')).toBeUndefined();
      expect(getServiceDomain('n8n-nodes-base.code')).toBeUndefined();
      expect(getServiceDomain('n8n-nodes-base.httpRequest')).toBeUndefined();
    });
  });

  // ── extractTriggers() ────────────────────────────────────────────────

  describe('extractTriggers()', () => {
    it('finds all triggers in order workflow', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const triggers = extractTriggers(wf);
      expect(triggers.length).toBe(2);
      const types = triggers.map((t) => t.type);
      expect(types).toContain('n8n-nodes-base.webhook');
      expect(types).toContain('n8n-nodes-base.scheduleTrigger');
    });

    it('finds AI chat trigger', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const triggers = extractTriggers(wf);
      expect(triggers.length).toBe(1);
      expect(triggers[0].type).toBe('@n8n/n8n-nodes-langchain.chatTrigger');
    });

    it('finds error trigger', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ERROR_WF))!;
      const triggers = extractTriggers(wf);
      expect(triggers.length).toBe(1);
      expect(triggers[0].type).toBe('n8n-nodes-base.errorTrigger');
    });
  });

  // ── extractRoutes() ──────────────────────────────────────────────────

  describe('extractRoutes()', () => {
    it('extracts webhook routes with webhookId', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const routes = extractRoutes(wf);
      const webhooks = routes.filter((r) => r.method === 'POST');
      expect(webhooks.length).toBe(1);
      expect(webhooks[0].uri).toBe('/orders/new');
      expect(webhooks[0].name).toBe('Webhook Trigger');
      expect(webhooks[0].metadata!.webhookId).toBe('wh-abc-123');
    });

    it('skips disabled triggers', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const routes = extractRoutes(wf);
      const allNames = routes.map((r) => r.name);
      expect(allNames).not.toContain('Daily Cleanup');
    });

    it('extracts chat trigger as CHAT route', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const routes = extractRoutes(wf);
      const chats = routes.filter((r) => r.method === 'CHAT');
      expect(chats.length).toBe(1);
      expect(chats[0].name).toBe('Chat Trigger');
    });
  });

  // ── extractCodeNodes() ───────────────────────────────────────────────

  describe('extractCodeNodes()', () => {
    it('extracts code content and language', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const codes = extractCodeNodes(wf);
      expect(codes.length).toBe(1);
      expect(codes[0].node.name).toBe('Validate Order');
      expect(codes[0].code).toContain('order.items');
      expect(codes[0].language).toBe('javascript');
    });

    it('extracts expression dependencies from code', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const codes = extractCodeNodes(wf);
      const formatNode = codes.find((c) => c.node.name === 'Format Answer');
      expect(formatNode).toBeDefined();
      expect(formatNode!.nodeDeps).toContain('Support Agent');
    });
  });

  // ── extractSubWorkflowCalls() ────────────────────────────────────────

  describe('extractSubWorkflowCalls()', () => {
    it('extracts sub-workflow references', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const calls = extractSubWorkflowCalls(wf);
      expect(calls.length).toBe(1);
      expect(calls[0].node.name).toBe('Process Payment');
      expect(calls[0].workflowId).toBe('payment-flow');
      expect(calls[0].source).toBe('id');
    });

    it('extracts toolWorkflow sub-workflow calls from AI workflow', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const calls = extractSubWorkflowCalls(wf);
      expect(calls.length).toBe(1);
      expect(calls[0].node.name).toBe('Search Orders Tool');
      expect(calls[0].workflowId).toBe('wf-001');
    });
  });

  // ── extractHttpRequests() ────────────────────────────────────────────

  describe('extractHttpRequests()', () => {
    it('extracts HTTP request nodes with authentication', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const reqs = extractHttpRequests(wf);
      expect(reqs.length).toBe(1);
      expect(reqs[0].node.name).toBe('Send Notification');
      expect(reqs[0].method).toBe('POST');
      expect(reqs[0].url).toContain('slack.com');
      expect(reqs[0].authentication).toBe('headerAuth');
    });
  });

  // ── extractStickyNotes() ─────────────────────────────────────────────

  describe('extractStickyNotes()', () => {
    it('extracts sticky note content and dimensions', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const notes = extractStickyNotes(wf);
      expect(notes.length).toBe(1);
      expect(notes[0].content).toContain('Order Processing Pipeline');
      expect(notes[0].width).toBe(300);
      expect(notes[0].color).toBe(1);
    });

    it('extracts AI workflow sticky note', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const notes = extractStickyNotes(wf);
      expect(notes.length).toBe(1);
      expect(notes[0].content).toContain('GPT-4o');
      expect(notes[0].color).toBe(2);
    });
  });

  // ── extractAiNodes() ─────────────────────────────────────────────────

  describe('extractAiNodes()', () => {
    it('extracts all AI nodes with roles', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const aiNodes = extractAiNodes(wf);
      // chatTrigger, agent, lmChatOpenAi, memoryBufferWindow, toolWorkflow, toolHttpRequest, embeddingsOpenAi, vectorStoreQdrant, retrieverVectorStore = 9
      expect(aiNodes.length).toBeGreaterThanOrEqual(7);
    });

    it('correctly identifies agent role', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const aiNodes = extractAiNodes(wf);
      const agent = aiNodes.find((n) => n.role === 'agent');
      expect(agent).toBeDefined();
      expect(agent!.node.name).toBe('Support Agent');
    });

    it('extracts model name', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const aiNodes = extractAiNodes(wf);
      const llm = aiNodes.find((n) => n.role === 'llm');
      expect(llm).toBeDefined();
      expect(llm!.model).toBe('gpt-4o');
    });

    it('identifies memory, embeddings, vector store, retriever', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const aiNodes = extractAiNodes(wf);
      const roles = new Set(aiNodes.map((n) => n.role));
      expect(roles.has('memory')).toBe(true);
      expect(roles.has('embedding')).toBe(true);
      expect(roles.has('vector_store')).toBe(true);
      expect(roles.has('retriever')).toBe(true);
    });
  });

  // ── extractAllExpressionDeps() ───────────────────────────────────────

  describe('extractAllExpressionDeps()', () => {
    it('finds $node["Name"] references in parameters', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const deps = extractAllExpressionDeps(wf);
      expect(deps.has('Format Response')).toBe(true);
      const formatDeps = deps.get('Format Response')!;
      expect(formatDeps.has('Save to Database')).toBe(true);
      expect(formatDeps.has('Process Payment')).toBe(true);
    });
  });

  describe('extractExpressionDeps()', () => {
    it('parses $node["Name"] syntax', () => {
      const deps = new Set<string>();
      extractExpressionDeps('={{ $node["Foo"].json.bar }}', deps);
      expect(deps.has('Foo')).toBe(true);
    });

    it('parses $items("Name") syntax', () => {
      const deps = new Set<string>();
      extractExpressionDeps('={{ $items("Bar") }}', deps);
      expect(deps.has('Bar')).toBe(true);
    });

    it('recurses into nested objects', () => {
      const deps = new Set<string>();
      extractExpressionDeps({ a: { b: '={{ $node["Deep"].json }}' } }, deps);
      expect(deps.has('Deep')).toBe(true);
    });
  });

  // ── extractCredentialUsages() ────────────────────────────────────────

  describe('extractCredentialUsages()', () => {
    it('extracts full credential references with id and name', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const creds = extractCredentialUsages(wf);
      expect(creds.length).toBe(2); // postgres + httpHeaderAuth

      const pg = creds.find((c) => c.credentialType === 'postgres');
      expect(pg).toBeDefined();
      expect(pg!.credentialId).toBe('1');
      expect(pg!.credentialName).toBe('Production DB');

      const http = creds.find((c) => c.credentialType === 'httpHeaderAuth');
      expect(http).toBeDefined();
      expect(http!.credentialId).toBe('5');
      expect(http!.credentialName).toBe('Slack Webhook Auth');
    });

    it('extracts multiple credentials from AI workflow', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(AI_WF))!;
      const creds = extractCredentialUsages(wf);
      expect(creds.length).toBe(3); // 2x openAiApi + qdrantApi
      const openAiCreds = creds.filter((c) => c.credentialType === 'openAiApi');
      expect(openAiCreds.length).toBe(2);
    });

    it('extracts shared credentials in error handler', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ERROR_WF))!;
      const creds = extractCredentialUsages(wf);
      const slackCreds = creds.filter((c) => c.credentialType === 'slackApi');
      expect(slackCreds.length).toBe(2);
      expect(slackCreds[0].credentialId).toBe(slackCreds[1].credentialId);
    });
  });

  // ── extractFlowControl() ─────────────────────────────────────────────

  describe('extractFlowControl()', () => {
    it('identifies IF node as conditional with 2 outputs', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const conns = extractConnections(wf);
      const flow = extractFlowControl(wf, conns);
      const ifNode = flow.find((f) => f.controlType === 'conditional');
      expect(ifNode).toBeDefined();
      expect(ifNode!.node.name).toBe('Check Amount');
      expect(ifNode!.outputCount).toBe(2);
    });

    it('identifies merge node with mode', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const conns = extractConnections(wf);
      const flow = extractFlowControl(wf, conns);
      const merge = flow.find((f) => f.controlType === 'merge');
      expect(merge).toBeDefined();
      expect(merge!.mergeMode).toBe('multiplex');
    });

    it('identifies loop node with batch size', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const conns = extractConnections(wf);
      const flow = extractFlowControl(wf, conns);
      const loop = flow.find((f) => f.controlType === 'loop');
      expect(loop).toBeDefined();
      expect(loop!.batchSize).toBe(5);
    });

    it('identifies switch node with 3 outputs', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ERROR_WF))!;
      const conns = extractConnections(wf);
      const flow = extractFlowControl(wf, conns);
      const sw = flow.find((f) => f.controlType === 'switch');
      expect(sw).toBeDefined();
      expect(sw!.node.name).toBe('Route by Severity');
      expect(sw!.outputCount).toBe(3);
    });

    it('identifies filter node', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ERROR_WF))!;
      const conns = extractConnections(wf);
      const flow = extractFlowControl(wf, conns);
      expect(flow.find((f) => f.controlType === 'filter')).toBeDefined();
    });

    it('identifies respond node', () => {
      const wf = parseN8nWorkflow(fs.readFileSync(ORDER_WF))!;
      const conns = extractConnections(wf);
      const flow = extractFlowControl(wf, conns);
      expect(flow.find((f) => f.controlType === 'respond')).toBeDefined();
    });
  });

  // ── extractNodes() (plugin main method) ──────────────────────────────

  describe('extractNodes()', () => {
    describe('framework role classification', () => {
      it('assigns n8n_webhook_workflow for webhook-based workflow', () => {
        const result = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json');
        expect(result._unsafeUnwrap().frameworkRole).toBe('n8n_webhook_workflow');
      });

      it('assigns n8n_ai_workflow for AI workflows', () => {
        const result = plugin.extractNodes('ai.json', fs.readFileSync(AI_WF), 'json');
        expect(result._unsafeUnwrap().frameworkRole).toBe('n8n_ai_workflow');
      });

      it('assigns n8n_error_workflow for error handler', () => {
        const result = plugin.extractNodes('err.json', fs.readFileSync(ERROR_WF), 'json');
        expect(result._unsafeUnwrap().frameworkRole).toBe('n8n_error_workflow');
      });
    });

    describe('symbol extraction', () => {
      it('excludes sticky notes from symbols', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        expect(parsed.symbols.find((s) => s.name === 'Sticky Note')).toBeUndefined();
      });

      it('includes typeVersion in signature', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const validate = parsed.symbols.find((s) => s.name === 'Validate Order');
        expect(validate!.signature).toContain('@2');
      });

      it('captures node category in metadata', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        expect(parsed.symbols.find((s) => s.name === 'Check Amount')!.metadata!.category).toBe('flow_control');
        expect(parsed.symbols.find((s) => s.name === 'Save to Database')!.metadata!.category).toBe('action');
        expect(parsed.symbols.find((s) => s.name === 'Validate Order')!.metadata!.category).toBe('code');
        expect(parsed.symbols.find((s) => s.name === 'Format Response')!.metadata!.category).toBe('data_transform');
      });

      it('captures error handling settings on nodes', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();

        const validate = parsed.symbols.find((s) => s.name === 'Validate Order');
        const eh = validate!.metadata!.errorHandling as Record<string, unknown>;
        expect(eh.onError).toBe('continueErrorOutput');
        expect(eh.retryOnFail).toBe(true);
        expect(eh.maxTries).toBe(3);
        expect(eh.waitBetweenTries).toBe(1000);

        const db = parsed.symbols.find((s) => s.name === 'Save to Database');
        expect((db!.metadata!.errorHandling as any).continueOnFail).toBe(true);
      });

      it('captures per-node notes', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const db = parsed.symbols.find((s) => s.name === 'Save to Database');
        expect(db!.metadata!.notes).toContain('duplicate key');
      });

      it('captures full credential info on symbols', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const db = parsed.symbols.find((s) => s.name === 'Save to Database');
        const creds = db!.metadata!.credentials as Array<{ type: string; id: string; name: string }>;
        expect(creds[0].type).toBe('postgres');
        expect(creds[0].id).toBe('1');
        expect(creds[0].name).toBe('Production DB');
      });

      it('captures AI metadata on AI node symbols', () => {
        const parsed = plugin.extractNodes('ai.json', fs.readFileSync(AI_WF), 'json')._unsafeUnwrap();
        const llm = parsed.symbols.find((s) => s.name === 'OpenAI Model');
        expect(llm!.metadata!.aiRole).toBe('llm');
        expect(llm!.metadata!.aiModel).toBe('gpt-4o');
      });

      it('captures flow control metadata (merge mode, batch size)', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        expect(parsed.symbols.find((s) => s.name === 'Merge Results')!.metadata!.mergeMode).toBe('multiplex');
        expect(parsed.symbols.find((s) => s.name === 'Process Items')!.metadata!.batchSize).toBe(5);
      });

      it('captures serviceDomain on integration nodes', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const db = parsed.symbols.find((s) => s.name === 'Save to Database');
        expect(db!.metadata!.serviceDomain).toBe('database');
      });

      it('captures serviceDomain on error handler nodes', () => {
        const parsed = plugin.extractNodes('err.json', fs.readFileSync(ERROR_WF), 'json')._unsafeUnwrap();
        const slack = parsed.symbols.find((s) => s.name === 'Alert Slack Critical');
        expect(slack!.metadata!.serviceDomain).toBe('communication');
        const pg = parsed.symbols.find((s) => s.name === 'Log to DB');
        expect(pg!.metadata!.serviceDomain).toBe('database');
      });
    });

    describe('metadata', () => {
      it('includes settings, pinData, templateId, sticky notes', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        expect((parsed.metadata!.settings as any).timezone).toBe('America/New_York');
        expect(parsed.metadata!.hasPinData).toBe(true);
        expect(parsed.metadata!.templateId).toBe('tmpl-orders-v2');
        expect(parsed.metadata!.stickyNoteCount).toBe(1);
        expect((parsed.metadata!.stickyNotes as any[])[0].content).toContain('Order Processing');
      });

      it('normalizes tag objects to strings', () => {
        const parsed = plugin.extractNodes('err.json', fs.readFileSync(ERROR_WF), 'json')._unsafeUnwrap();
        const tags = parsed.metadata!.tags as string[];
        expect(tags).toContain('error-handling');
        expect(tags).toContain('infrastructure');
      });
    });

    describe('edge extraction', () => {
      it('creates typed main connection edges', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const mainEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_connection');
        expect(mainEdges.length).toBeGreaterThanOrEqual(8);
        for (const e of mainEdges) {
          expect(e.metadata!.connectionType).toBe('main');
        }
      });

      it('creates AI connection edges with ai type', () => {
        const parsed = plugin.extractNodes('ai.json', fs.readFileSync(AI_WF), 'json')._unsafeUnwrap();
        const aiEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_ai_connection');
        expect(aiEdges.length).toBeGreaterThanOrEqual(5);

        const aiTypes = new Set(aiEdges.map((e) => e.metadata!.aiConnectionType));
        expect(aiTypes.has('ai_languageModel')).toBe(true);
        expect(aiTypes.has('ai_memory')).toBe(true);
        expect(aiTypes.has('ai_tool')).toBe(true);
      });

      it('creates conditional branch edges for IF node', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const branchEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_conditional_branch');
        const trueBranch = branchEdges.filter((e) => e.metadata!.branch === 'true');
        const falseBranch = branchEdges.filter((e) => e.metadata!.branch === 'false');
        expect(trueBranch.length).toBe(2);
        expect(falseBranch.length).toBe(1);
      });

      it('creates conditional branch edges for switch node', () => {
        const parsed = plugin.extractNodes('err.json', fs.readFileSync(ERROR_WF), 'json')._unsafeUnwrap();
        const branchEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_conditional_branch');
        expect(branchEdges.length).toBe(3);
        expect(branchEdges[0].metadata!.branch).toBe('case_0');
        expect(branchEdges[1].metadata!.branch).toBe('case_1');
        expect(branchEdges[2].metadata!.branch).toBe('case_2');
      });

      it('creates trigger edges', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const triggerEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_triggers');
        expect(triggerEdges.length).toBeGreaterThanOrEqual(1);
      });

      it('creates credential edges with full detail', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const credEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_uses_credential');
        expect(credEdges.length).toBe(2);

        const pg = credEdges.find((e) => e.metadata!.credentialType === 'postgres');
        expect(pg!.metadata!.credentialId).toBe('1');
        expect(pg!.metadata!.credentialName).toBe('Production DB');
      });

      it('creates expression dependency edges', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const exprEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_expression_dep');
        expect(exprEdges.length).toBe(2);
        const targets = exprEdges.map((e) => e.targetSymbolId);
        expect(targets.every((t) => t!.includes('Format Response'))).toBe(true);
      });

      it('creates error workflow edge from settings', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const errEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_error_workflow');
        expect(errEdges.length).toBe(1);
        expect(errEdges[0].metadata!.targetWorkflowId).toBe('wf-err-001');
      });

      it('creates sub-workflow edges', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const subEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_calls_subworkflow');
        expect(subEdges.length).toBe(1);
        expect(subEdges[0].metadata!.targetWorkflowId).toBe('payment-flow');
      });

      it('creates HTTP request edges with authentication', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const httpEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_http_request');
        expect(httpEdges.length).toBe(1);
        expect(httpEdges[0].metadata!.authentication).toBe('headerAuth');
      });

      it('creates external service edges with domain', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const svcEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_external_service');
        expect(svcEdges.length).toBeGreaterThanOrEqual(1);
        const pgEdge = svcEdges.find((e) => e.metadata!.service === 'postgres');
        expect(pgEdge).toBeDefined();
        expect(pgEdge!.metadata!.serviceDomain).toBe('database');
      });

      it('aggregates serviceDomains in workflow metadata', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        const domains = parsed.metadata!.serviceDomains as string[];
        expect(domains).toBeDefined();
        expect(domains).toContain('database');
      });

      it('creates external service edges for error handler', () => {
        const parsed = plugin.extractNodes('err.json', fs.readFileSync(ERROR_WF), 'json')._unsafeUnwrap();
        const svcEdges = parsed.edges!.filter((e) => e.edgeType === 'n8n_external_service');
        const domains = new Set(svcEdges.map((e) => e.metadata!.serviceDomain));
        expect(domains.has('communication')).toBe(true); // slack nodes
        expect(domains.has('database')).toBe(true); // postgres node
      });
    });

    describe('routes', () => {
      it('extracts webhook routes', () => {
        const parsed = plugin.extractNodes('order.json', fs.readFileSync(ORDER_WF), 'json')._unsafeUnwrap();
        expect(parsed.routes!.length).toBe(1);
        expect(parsed.routes![0].method).toBe('POST');
        expect(parsed.routes![0].uri).toBe('/orders/new');
      });

      it('extracts CHAT routes from AI workflow', () => {
        const parsed = plugin.extractNodes('ai.json', fs.readFileSync(AI_WF), 'json')._unsafeUnwrap();
        const chats = parsed.routes!.filter((r) => r.method === 'CHAT');
        expect(chats.length).toBe(1);
      });
    });

    describe('skip non-applicable files', () => {
      it('skips non-JSON files', () => {
        const result = plugin.extractNodes('test.ts', Buffer.from(''), 'typescript');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().symbols).toHaveLength(0);
      });

      it('skips non-workflow JSON', () => {
        const result = plugin.extractNodes('pkg.json', Buffer.from('{"name":"pkg"}'), 'json');
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().symbols).toHaveLength(0);
      });
    });
  });

  // ── manifest ─────────────────────────────────────────────────────────

  describe('manifest', () => {
    it('has correct name, version and priority', () => {
      expect(plugin.manifest.name).toBe('n8n');
      expect(plugin.manifest.version).toBe('2.0.0');
      expect(plugin.manifest.priority).toBe(30);
    });
  });
});
