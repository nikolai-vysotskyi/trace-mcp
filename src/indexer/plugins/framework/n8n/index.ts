/**
 * N8nPlugin — comprehensive n8n workflow indexing.
 *
 * Extracts and models the full structure of n8n workflow JSON files:
 *   - All node categories: triggers, actions, flow control, data transforms, AI/LangChain
 *   - Typed connections (main, error, ai_languageModel, ai_tool, ai_memory, etc.)
 *   - Webhook/form/schedule routes as discoverable endpoints
 *   - Sub-workflow calls with cross-file resolution
 *   - HTTP request external dependencies
 *   - Credential references with full ID/name
 *   - Implicit data dependencies via expression parsing ($node["Name"])
 *   - Sticky notes as documentation
 *   - Workflow-level settings (errorWorkflow, timezone, callerPolicy)
 *   - Node-level error handling (continueOnFail, retryOnFail, onError)
 *   - Custom n8n node package detection
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  RawSymbol,
  ResolveContext,
} from '../../../../plugin-api/types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface N8nCredentialRef {
  id: string | null;
  name: string;
}

export interface N8nNode {
  id?: string;
  name: string;
  type: string;
  position: [number, number];
  parameters?: Record<string, unknown>;
  typeVersion?: number;
  credentials?: Record<string, N8nCredentialRef>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  continueOnFail?: boolean;
  onError?: 'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow';
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  webhookId?: string;
  color?: number;
}

export interface N8nConnectionTarget {
  node: string;
  type: string;   // "main", "ai_languageModel", "ai_tool", etc.
  index: number;
}

export interface N8nConnection {
  sourceNode: string;
  sourceOutput: number;
  targetNode: string;
  targetInput: number;
  connectionType: string;   // "main", "ai_languageModel", "ai_tool", etc.
}

export interface N8nWorkflowSettings {
  timezone?: string;
  errorWorkflow?: string;
  callerIds?: string;
  callerPolicy?: 'any' | 'none' | 'workflowsFromAList';
  saveDataErrorExecution?: string;
  saveDataSuccessExecution?: string;
  saveManualExecutions?: string | boolean;
  saveExecutionProgress?: string | boolean;
  executionTimeout?: number;
  executionOrder?: 'v0' | 'v1';
}

export interface N8nWorkflow {
  id?: string;
  name?: string;
  nodes: N8nNode[];
  connections: Record<string, Record<string, Array<Array<N8nConnectionTarget>>>>;
  active?: boolean;
  settings?: N8nWorkflowSettings;
  staticData?: Record<string, unknown> | null;
  pinData?: Record<string, unknown[]>;
  tags?: string[] | Array<{ name: string }>;
  meta?: { templateId?: string; instanceId?: string };
}

// ── Node classification ──────────────────────────────────────────────────

const TRIGGER_TYPES = new Set([
  // Core triggers
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.cronTrigger',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.workflowTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.emailReadImap',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.sseTrigger',
  'n8n-nodes-base.rssFeedReadTrigger',
  // AI triggers
  '@n8n/n8n-nodes-langchain.chatTrigger',
  '@n8n/n8n-nodes-langchain.manualChatTrigger',
  '@n8n/n8n-nodes-langchain.mcpTrigger',
  // Common service triggers
  'n8n-nodes-base.gmailTrigger',
  'n8n-nodes-base.telegramTrigger',
  'n8n-nodes-base.slackTrigger',
  'n8n-nodes-base.stripeTrigger',
  'n8n-nodes-base.githubTrigger',
  'n8n-nodes-base.gitlabTrigger',
  'n8n-nodes-base.linearTrigger',
  'n8n-nodes-base.asanaTrigger',
  'n8n-nodes-base.airtableTrigger',
  'n8n-nodes-base.postgresTrigger',
  'n8n-nodes-base.redisTrigger',
  'n8n-nodes-base.whatsAppTrigger',
  'n8n-nodes-base.facebookTrigger',
  'n8n-nodes-base.calTrigger',
  'n8n-nodes-base.calendlyTrigger',
]);

const CODE_TYPES = new Set([
  'n8n-nodes-base.code',
  'n8n-nodes-base.function',
  'n8n-nodes-base.functionItem',
  '@n8n/n8n-nodes-langchain.code',
]);

const FLOW_CONTROL_TYPES = new Set([
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.wait',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.limit',
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.respondToWebhook',
  'n8n-nodes-base.compareDatasets',
  'n8n-nodes-base.executionData',
]);

const DATA_TRANSFORM_TYPES = new Set([
  'n8n-nodes-base.set',
  'n8n-nodes-base.itemLists',
  'n8n-nodes-base.splitOut',
  'n8n-nodes-base.aggregate',
  'n8n-nodes-base.summarize',
  'n8n-nodes-base.sort',
  'n8n-nodes-base.removeDuplicates',
  'n8n-nodes-base.crypto',
  'n8n-nodes-base.markdown',
  'n8n-nodes-base.xml',
  'n8n-nodes-base.convertToFile',
  'n8n-nodes-base.extractFromFile',
  'n8n-nodes-base.aiTransform',
  'n8n-nodes-base.dateTime',
  'n8n-nodes-base.html',
  'n8n-nodes-base.renameKeys',
]);

const SUBWORKFLOW_TYPES = new Set([
  'n8n-nodes-base.executeWorkflow',
  '@n8n/n8n-nodes-langchain.toolWorkflow',
]);

const HTTP_REQUEST_TYPES = new Set([
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.httpRequestTool',
  'n8n-nodes-base.graphql',
]);

const STICKY_NOTE_TYPE = 'n8n-nodes-base.stickyNote';

const AI_CONNECTION_TYPES = new Set([
  'ai_agent', 'ai_chain', 'ai_document', 'ai_embedding',
  'ai_languageModel', 'ai_memory', 'ai_outputParser',
  'ai_retriever', 'ai_reranker', 'ai_textSplitter',
  'ai_tool', 'ai_vectorStore',
]);

// ── Expression dependency parsing ────────────────────────────────────────

const EXPR_NODE_REF = /\$node\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
const EXPR_ITEMS_REF = /\$items\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function extractExpressionDeps(value: unknown, deps: Set<string>): void {
  if (typeof value === 'string') {
    let m: RegExpExecArray | null;
    const re1 = new RegExp(EXPR_NODE_REF.source, 'g');
    while ((m = re1.exec(value)) !== null) deps.add(m[1]);
    const re2 = new RegExp(EXPR_ITEMS_REF.source, 'g');
    while ((m = re2.exec(value)) !== null) deps.add(m[1]);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      extractExpressionDeps(v, deps);
    }
  }
}

// ── Node category classification ─────────────────────────────────────────

export type N8nNodeCategory =
  | 'trigger' | 'code' | 'flow_control' | 'data_transform'
  | 'ai' | 'subworkflow' | 'http_request' | 'sticky_note' | 'action';

export function classifyNode(node: N8nNode): N8nNodeCategory {
  if (node.type === STICKY_NOTE_TYPE) return 'sticky_note';
  if (isTriggerNode(node)) return 'trigger';
  if (CODE_TYPES.has(node.type)) return 'code';
  if (FLOW_CONTROL_TYPES.has(node.type)) return 'flow_control';
  if (DATA_TRANSFORM_TYPES.has(node.type)) return 'data_transform';
  if (SUBWORKFLOW_TYPES.has(node.type)) return 'subworkflow';
  if (HTTP_REQUEST_TYPES.has(node.type)) return 'http_request';
  if (isAiNode(node)) return 'ai';
  return 'action';
}

export function isTriggerNode(node: N8nNode): boolean {
  return TRIGGER_TYPES.has(node.type)
    || node.type.toLowerCase().includes('trigger');
}

export function isAiNode(node: N8nNode): boolean {
  return node.type.startsWith('@n8n/n8n-nodes-langchain.')
    || node.type.includes('langchain');
}

// ── Framework role classification ────────────────────────────────────────

function classifyWorkflowRole(workflow: N8nWorkflow): string {
  const hasAi = workflow.nodes.some(isAiNode);
  const hasTrigger = workflow.nodes.some(isTriggerNode);
  const hasWebhook = workflow.nodes.some((n) => n.type === 'n8n-nodes-base.webhook');
  const hasSchedule = workflow.nodes.some((n) =>
    n.type === 'n8n-nodes-base.scheduleTrigger' || n.type === 'n8n-nodes-base.cron',
  );
  const isErrorHandler = workflow.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger');
  const isSubWorkflow = workflow.nodes.some((n) =>
    n.type === 'n8n-nodes-base.executeWorkflowTrigger' || n.type === 'n8n-nodes-base.workflowTrigger',
  );

  if (isErrorHandler) return 'n8n_error_workflow';
  if (hasAi) return 'n8n_ai_workflow';
  if (isSubWorkflow) return 'n8n_subworkflow';
  if (hasWebhook) return 'n8n_webhook_workflow';
  if (hasSchedule) return 'n8n_scheduled_workflow';
  if (hasTrigger) return 'n8n_triggered_workflow';
  return 'n8n_workflow';
}

// ── Parsing ──────────────────────────────────────────────────────────────

export function parseN8nWorkflow(content: Buffer): N8nWorkflow | null {
  try {
    const json = JSON.parse(content.toString('utf-8'));
    if (json && Array.isArray(json.nodes) && json.connections && typeof json.connections === 'object') {
      return json as N8nWorkflow;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Connection extraction ────────────────────────────────────────────────

export function extractConnections(workflow: N8nWorkflow): N8nConnection[] {
  const connections: N8nConnection[] = [];
  for (const [sourceName, outputs] of Object.entries(workflow.connections)) {
    for (const [connType, outputConns] of Object.entries(outputs)) {
      for (let outputIdx = 0; outputIdx < outputConns.length; outputIdx++) {
        const targets = outputConns[outputIdx];
        if (!targets) continue;
        for (const target of targets) {
          connections.push({
            sourceNode: sourceName,
            sourceOutput: outputIdx,
            targetNode: target.node,
            targetInput: target.index,
            connectionType: connType,
          });
        }
      }
    }
  }
  return connections;
}

// ── Trigger extraction ───────────────────────────────────────────────────

export function extractTriggers(workflow: N8nWorkflow): N8nNode[] {
  return workflow.nodes.filter(isTriggerNode);
}

// ── Route extraction (webhooks, schedules, forms, workflow triggers) ─────

export function extractRoutes(workflow: N8nWorkflow): RawRoute[] {
  const routes: RawRoute[] = [];
  for (const node of workflow.nodes) {
    if (node.disabled) continue;

    // Webhook endpoints
    if (node.type === 'n8n-nodes-base.webhook' && node.parameters) {
      const webhookPath = (node.parameters.path as string) ?? '/';
      const method = ((node.parameters.httpMethod as string) ?? 'GET').toUpperCase();
      routes.push({
        method,
        uri: webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`,
        name: node.name,
        metadata: { n8nNodeType: node.type, webhookId: node.webhookId },
      });
    }

    // Form trigger endpoints
    if (node.type === 'n8n-nodes-base.formTrigger' && node.parameters) {
      const formPath = (node.parameters.path as string) ?? (node.parameters.formTitle as string) ?? '/form';
      routes.push({
        method: 'FORM',
        uri: formPath.startsWith('/') ? formPath : `/${formPath}`,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }

    // Schedule triggers as CRON routes
    if ((node.type === 'n8n-nodes-base.scheduleTrigger' || node.type === 'n8n-nodes-base.cron') && node.parameters) {
      const rule = node.parameters.rule as Record<string, unknown> | undefined;
      const cronExpr = (node.parameters.cronExpression as string)
        ?? (rule ? JSON.stringify(rule) : 'schedule');
      routes.push({
        method: 'CRON',
        uri: cronExpr,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }

    // Sub-workflow entry points
    if (node.type === 'n8n-nodes-base.executeWorkflowTrigger' || node.type === 'n8n-nodes-base.workflowTrigger') {
      routes.push({
        method: 'WORKFLOW',
        uri: `trigger:${node.name}`,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }

    // Chat/MCP triggers
    if (node.type === '@n8n/n8n-nodes-langchain.chatTrigger'
      || node.type === '@n8n/n8n-nodes-langchain.manualChatTrigger') {
      routes.push({
        method: 'CHAT',
        uri: `/chat/${node.name.replace(/\s+/g, '-').toLowerCase()}`,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }

    if (node.type === '@n8n/n8n-nodes-langchain.mcpTrigger') {
      routes.push({
        method: 'MCP',
        uri: `/mcp/${node.name.replace(/\s+/g, '-').toLowerCase()}`,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }
  }
  return routes;
}

// ── Code node extraction ─────────────────────────────────────────────────

export function extractCodeNodes(workflow: N8nWorkflow): Array<{
  node: N8nNode;
  code: string;
  language: string;
  nodeDeps: string[];
}> {
  const results: Array<{ node: N8nNode; code: string; language: string; nodeDeps: string[] }> = [];
  for (const node of workflow.nodes) {
    if (!CODE_TYPES.has(node.type) || !node.parameters) continue;
    const code = (node.parameters.jsCode as string)
      ?? (node.parameters.functionCode as string)
      ?? (node.parameters.code as string)
      ?? (node.parameters.pythonCode as string)
      ?? '';
    if (!code.trim()) continue;

    const lang = (node.parameters.language as string) ?? 'javascript';
    const deps = new Set<string>();
    extractExpressionDeps(code, deps);
    results.push({ node, code, language: lang, nodeDeps: [...deps] });
  }
  return results;
}

// ── Sub-workflow extraction ──────────────────────────────────────────────

export function extractSubWorkflowCalls(workflow: N8nWorkflow): Array<{
  node: N8nNode;
  workflowId: string;
  source: 'id' | 'expression';
}> {
  const calls: Array<{ node: N8nNode; workflowId: string; source: 'id' | 'expression' }> = [];
  for (const node of workflow.nodes) {
    if (!SUBWORKFLOW_TYPES.has(node.type) || !node.parameters) continue;

    const rawId = node.parameters.workflowId;
    let wfId = '';
    let source: 'id' | 'expression' = 'id';

    if (typeof rawId === 'string') {
      wfId = rawId;
    } else if (rawId && typeof rawId === 'object') {
      const obj = rawId as Record<string, unknown>;
      wfId = (obj.value as string) ?? '';
      if (obj.__rl === true && obj.mode === 'expression') source = 'expression';
    }

    if (wfId) calls.push({ node, workflowId: wfId, source });
  }
  return calls;
}

// ── HTTP request extraction ──────────────────────────────────────────────

export function extractHttpRequests(workflow: N8nWorkflow): Array<{
  node: N8nNode;
  url: string;
  method: string;
  authentication?: string;
}> {
  const requests: Array<{ node: N8nNode; url: string; method: string; authentication?: string }> = [];
  for (const node of workflow.nodes) {
    if (!HTTP_REQUEST_TYPES.has(node.type) || !node.parameters) continue;
    const url = (node.parameters.url as string) ?? '';
    const method = ((node.parameters.method as string)
      ?? (node.parameters.requestMethod as string)
      ?? 'GET').toUpperCase();
    if (!url) continue;

    const authentication = node.parameters.authentication as string | undefined;
    requests.push({ node, url, method, ...(authentication ? { authentication } : {}) });
  }
  return requests;
}

// ── Sticky notes extraction ──────────────────────────────────────────────

export function extractStickyNotes(workflow: N8nWorkflow): Array<{
  node: N8nNode;
  content: string;
  width?: number;
  height?: number;
  color?: number;
}> {
  const notes: Array<{ node: N8nNode; content: string; width?: number; height?: number; color?: number }> = [];
  for (const node of workflow.nodes) {
    if (node.type !== STICKY_NOTE_TYPE || !node.parameters) continue;
    const content = (node.parameters.content as string) ?? '';
    if (!content.trim()) continue;
    notes.push({
      node,
      content,
      width: node.parameters.width as number | undefined,
      height: node.parameters.height as number | undefined,
      color: node.color ?? (node.parameters.color as number | undefined),
    });
  }
  return notes;
}

// ── AI node extraction ───────────────────────────────────────────────────

export type AiNodeRole = 'agent' | 'chain' | 'llm' | 'embedding' | 'memory'
  | 'vector_store' | 'retriever' | 'tool' | 'output_parser' | 'document_loader'
  | 'text_splitter' | 'reranker' | 'standalone';

export function classifyAiNode(nodeType: string): AiNodeRole {
  const t = nodeType.replace('@n8n/n8n-nodes-langchain.', '');
  if (t.startsWith('agent') || t === 'agent') return 'agent';
  if (t.startsWith('chain')) return 'chain';
  if (t.startsWith('lm') || t.startsWith('lmChat')) return 'llm';
  if (t.startsWith('embeddings')) return 'embedding';
  if (t.startsWith('memory')) return 'memory';
  if (t.startsWith('vectorStore')) return 'vector_store';
  if (t.startsWith('retriever')) return 'retriever';
  if (t.startsWith('tool') || t.endsWith('Tool')) return 'tool';
  if (t.startsWith('outputParser')) return 'output_parser';
  if (t.startsWith('document')) return 'document_loader';
  if (t.startsWith('textSplitter')) return 'text_splitter';
  if (t.startsWith('reranker')) return 'reranker';
  return 'standalone';
}

export function extractAiNodes(workflow: N8nWorkflow): Array<{
  node: N8nNode;
  role: AiNodeRole;
  model?: string;
}> {
  const results: Array<{ node: N8nNode; role: AiNodeRole; model?: string }> = [];
  for (const node of workflow.nodes) {
    if (!isAiNode(node)) continue;
    const role = classifyAiNode(node.type);
    let model: string | undefined;
    if (node.parameters) {
      model = (node.parameters.model as string)
        ?? (node.parameters.modelId as string)
        ?? (node.parameters.modelName as string)
        ?? undefined;
    }
    results.push({ node, role, ...(model ? { model } : {}) });
  }
  return results;
}

// ── Expression dependency extraction (workflow-wide) ─────────────────────

export function extractAllExpressionDeps(workflow: N8nWorkflow): Map<string, Set<string>> {
  const nodeDeps = new Map<string, Set<string>>();
  for (const node of workflow.nodes) {
    if (!node.parameters) continue;
    const deps = new Set<string>();
    extractExpressionDeps(node.parameters, deps);
    // Remove self-references
    deps.delete(node.name);
    if (deps.size > 0) {
      nodeDeps.set(node.name, deps);
    }
  }
  return nodeDeps;
}

// ── Credential extraction (full details) ─────────────────────────────────

export interface CredentialUsage {
  node: N8nNode;
  credentialType: string;
  credentialId: string | null;
  credentialName: string;
}

export function extractCredentialUsages(workflow: N8nWorkflow): CredentialUsage[] {
  const usages: CredentialUsage[] = [];
  for (const node of workflow.nodes) {
    if (!node.credentials) continue;
    for (const [credType, credRef] of Object.entries(node.credentials)) {
      const ref = credRef as N8nCredentialRef | undefined;
      usages.push({
        node,
        credentialType: credType,
        credentialId: ref?.id ?? null,
        credentialName: ref?.name ?? credType,
      });
    }
  }
  return usages;
}

// ── Flow control analysis ────────────────────────────────────────────────

export interface FlowControlInfo {
  node: N8nNode;
  controlType: 'conditional' | 'switch' | 'merge' | 'loop' | 'wait' | 'filter' | 'respond' | 'other';
  outputCount?: number;
  mergeMode?: string;
  batchSize?: number;
}

export function extractFlowControl(workflow: N8nWorkflow, connections: N8nConnection[]): FlowControlInfo[] {
  const results: FlowControlInfo[] = [];
  for (const node of workflow.nodes) {
    if (!FLOW_CONTROL_TYPES.has(node.type)) continue;

    const outputs = connections.filter((c) => c.sourceNode === node.name);
    const maxOutput = outputs.reduce((max, c) => Math.max(max, c.sourceOutput), -1);

    let controlType: FlowControlInfo['controlType'] = 'other';
    let mergeMode: string | undefined;
    let batchSize: number | undefined;

    switch (node.type) {
      case 'n8n-nodes-base.if':
        controlType = 'conditional';
        break;
      case 'n8n-nodes-base.switch':
        controlType = 'switch';
        break;
      case 'n8n-nodes-base.merge':
        controlType = 'merge';
        mergeMode = (node.parameters?.mode as string) ?? 'append';
        break;
      case 'n8n-nodes-base.splitInBatches':
        controlType = 'loop';
        batchSize = (node.parameters?.batchSize as number) ?? 10;
        break;
      case 'n8n-nodes-base.wait':
        controlType = 'wait';
        break;
      case 'n8n-nodes-base.filter':
      case 'n8n-nodes-base.limit':
        controlType = 'filter';
        break;
      case 'n8n-nodes-base.respondToWebhook':
        controlType = 'respond';
        break;
    }

    results.push({
      node,
      controlType,
      outputCount: maxOutput + 1,
      ...(mergeMode ? { mergeMode } : {}),
      ...(batchSize ? { batchSize } : {}),
    });
  }
  return results;
}

// ── Plugin ───────────────────────────────────────────────────────────────

export class N8nPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'n8n',
    version: '2.0.0',
    priority: 30,
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (Object.keys(deps).some((k) =>
        k.startsWith('n8n-nodes') || k === 'n8n-workflow' || k === 'n8n-core',
      )) {
        return true;
      }
    }

    try {
      if (fs.existsSync(path.join(ctx.rootPath, '.n8n'))) return true;
    } catch { /* ignore */ }

    const searchDirs = ['workflows', 'n8n', '.n8n', '.'];
    for (const dir of searchDirs) {
      try {
        const fullDir = path.join(ctx.rootPath, dir);
        if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) continue;
        const files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.json'));
        for (const file of files.slice(0, 5)) {
          try {
            const content = fs.readFileSync(path.join(fullDir, file));
            if (parseN8nWorkflow(content)) return true;
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    return ctx.configFiles.some(
      (f) => f.includes('n8n') || f.includes('.n8n'),
    );
  }

  registerSchema() {
    return {
      nodeTypes: [
        { name: 'n8n_workflow' },
        { name: 'n8n_node' },
        { name: 'n8n_trigger' },
        { name: 'n8n_webhook' },
        { name: 'n8n_code_node' },
        { name: 'n8n_subworkflow_call' },
        { name: 'n8n_ai_node' },
        { name: 'n8n_flow_control' },
        { name: 'n8n_data_transform' },
        { name: 'n8n_sticky_note' },
      ],
      edgeTypes: [
        { name: 'n8n_connection', category: 'n8n', description: 'Data flow between workflow nodes' },
        { name: 'n8n_ai_connection', category: 'n8n', description: 'AI/LangChain typed connection (model, tool, memory, etc.)' },
        { name: 'n8n_error_connection', category: 'n8n', description: 'Error output branch connection' },
        { name: 'n8n_triggers', category: 'n8n', description: 'Trigger initiates workflow execution' },
        { name: 'n8n_webhook_route', category: 'n8n', description: 'Webhook endpoint exposed by workflow' },
        { name: 'n8n_calls_subworkflow', category: 'n8n', description: 'Node invokes another workflow' },
        { name: 'n8n_http_request', category: 'n8n', description: 'HTTP request to external service' },
        { name: 'n8n_uses_credential', category: 'n8n', description: 'Node references a credential' },
        { name: 'n8n_expression_dep', category: 'n8n', description: 'Implicit data dependency via expression ($node["Name"])' },
        { name: 'n8n_error_workflow', category: 'n8n', description: 'Workflow-level error handler reference' },
        { name: 'n8n_conditional_branch', category: 'n8n', description: 'Conditional branch output (IF true/false, Switch cases)' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'json' && !filePath.endsWith('.json')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const workflow = parseN8nWorkflow(content);
    if (!workflow) {
      return ok({ status: 'ok', symbols: [] });
    }

    const connections = extractConnections(workflow);
    const role = classifyWorkflowRole(workflow);
    const tags = Array.isArray(workflow.tags)
      ? workflow.tags.map((t) => (typeof t === 'string' ? t : t.name))
      : [];
    const stickyNotes = extractStickyNotes(workflow);

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
      routes: [],
      frameworkRole: role,
      metadata: {
        workflowName: workflow.name ?? path.basename(filePath, '.json'),
        workflowId: workflow.id,
        active: workflow.active ?? false,
        nodeCount: workflow.nodes.length,
        tags,
        settings: workflow.settings ?? {},
        hasPinData: !!(workflow.pinData && Object.keys(workflow.pinData).length > 0),
        hasStaticData: !!(workflow.staticData && Object.keys(workflow.staticData).length > 0),
        templateId: workflow.meta?.templateId,
        stickyNoteCount: stickyNotes.length,
        stickyNotes: stickyNotes.map((s) => ({
          name: s.node.name,
          content: s.content.slice(0, 500),
        })),
      },
    };

    const source = content.toString('utf-8');
    const nodeNameSet = new Set(workflow.nodes.map((n) => n.name));

    // ── Symbols: one per workflow node ──
    for (const node of workflow.nodes) {
      if (node.type === STICKY_NOTE_TYPE) continue; // skip stickies as symbols

      const category = classifyNode(node);
      const byteStart = findNodeByteOffset(source, node.name);
      const byteEnd = byteStart >= 0 ? byteStart + node.name.length + 10 : 0;

      const errorHandling: Record<string, unknown> = {};
      if (node.onError) errorHandling.onError = node.onError;
      if (node.continueOnFail) errorHandling.continueOnFail = true;
      if (node.retryOnFail) {
        errorHandling.retryOnFail = true;
        if (node.maxTries) errorHandling.maxTries = node.maxTries;
        if (node.waitBetweenTries) errorHandling.waitBetweenTries = node.waitBetweenTries;
      }

      const meta: Record<string, unknown> = {
        n8nNodeType: node.type,
        n8nNodeId: node.id ?? node.name,
        category,
        isDisabled: node.disabled ?? false,
        typeVersion: node.typeVersion,
        position: node.position,
      };

      if (Object.keys(errorHandling).length > 0) meta.errorHandling = errorHandling;
      if (node.notes) meta.notes = node.notes;
      if (node.credentials) {
        meta.credentials = Object.entries(node.credentials).map(([type, ref]) => ({
          type,
          id: (ref as N8nCredentialRef)?.id,
          name: (ref as N8nCredentialRef)?.name,
        }));
      }
      if (node.alwaysOutputData) meta.alwaysOutputData = true;
      if (node.executeOnce) meta.executeOnce = true;
      if (node.webhookId) meta.webhookId = node.webhookId;

      // AI-specific metadata
      if (isAiNode(node)) {
        meta.aiRole = classifyAiNode(node.type);
        if (node.parameters) {
          const model = (node.parameters.model as string)
            ?? (node.parameters.modelId as string)
            ?? (node.parameters.modelName as string);
          if (model) meta.aiModel = model;
        }
      }

      // Flow control metadata
      if (FLOW_CONTROL_TYPES.has(node.type)) {
        const nodeConns = connections.filter((c) => c.sourceNode === node.name);
        const maxOutput = nodeConns.reduce((max, c) => Math.max(max, c.sourceOutput), -1);
        meta.outputCount = maxOutput + 1;
        if (node.type === 'n8n-nodes-base.merge' && node.parameters) {
          meta.mergeMode = (node.parameters.mode as string) ?? 'append';
        }
        if (node.type === 'n8n-nodes-base.splitInBatches' && node.parameters) {
          meta.batchSize = (node.parameters.batchSize as number) ?? 10;
        }
      }

      const symbol: RawSymbol = {
        symbolId: `${filePath}::${node.name}#constant`,
        name: node.name,
        kind: 'constant',
        signature: `[n8n:${node.type}${node.typeVersion ? '@' + node.typeVersion : ''}] ${node.name}`,
        byteStart: Math.max(byteStart, 0),
        byteEnd: Math.max(byteEnd, 0),
        metadata: meta,
      };
      result.symbols.push(symbol);
    }

    // ── Edges: typed connections ──
    for (const conn of connections) {
      if (!nodeNameSet.has(conn.sourceNode) || !nodeNameSet.has(conn.targetNode)) continue;
      // Skip sticky note connections (shouldn't exist but be safe)
      const srcNode = workflow.nodes.find((n) => n.name === conn.sourceNode);
      if (srcNode?.type === STICKY_NOTE_TYPE) continue;

      const isAiConn = AI_CONNECTION_TYPES.has(conn.connectionType);
      let edgeType = 'n8n_connection';

      if (isAiConn) {
        edgeType = 'n8n_ai_connection';
      }

      result.edges!.push({
        sourceSymbolId: `${filePath}::${conn.sourceNode}#constant`,
        targetSymbolId: `${filePath}::${conn.targetNode}#constant`,
        edgeType,
        metadata: {
          sourceOutput: conn.sourceOutput,
          targetInput: conn.targetInput,
          connectionType: conn.connectionType,
          ...(isAiConn ? { aiConnectionType: conn.connectionType } : {}),
        },
      });
    }

    // ── Edges: conditional branch labeling ──
    for (const node of workflow.nodes) {
      if (node.type === 'n8n-nodes-base.if') {
        const nodeConns = connections.filter(
          (c) => c.sourceNode === node.name && c.connectionType === 'main',
        );
        for (const conn of nodeConns) {
          result.edges!.push({
            sourceSymbolId: `${filePath}::${node.name}#constant`,
            targetSymbolId: `${filePath}::${conn.targetNode}#constant`,
            edgeType: 'n8n_conditional_branch',
            metadata: {
              branch: conn.sourceOutput === 0 ? 'true' : 'false',
              outputIndex: conn.sourceOutput,
            },
          });
        }
      } else if (node.type === 'n8n-nodes-base.switch') {
        const nodeConns = connections.filter(
          (c) => c.sourceNode === node.name && c.connectionType === 'main',
        );
        for (const conn of nodeConns) {
          result.edges!.push({
            sourceSymbolId: `${filePath}::${node.name}#constant`,
            targetSymbolId: `${filePath}::${conn.targetNode}#constant`,
            edgeType: 'n8n_conditional_branch',
            metadata: {
              branch: `case_${conn.sourceOutput}`,
              outputIndex: conn.sourceOutput,
            },
          });
        }
      }
    }

    // ── Edges: trigger → first connected nodes ──
    const triggers = extractTriggers(workflow);
    for (const trigger of triggers) {
      const triggerConns = connections.filter((c) => c.sourceNode === trigger.name);
      for (const conn of triggerConns) {
        result.edges!.push({
          sourceSymbolId: `${filePath}::${trigger.name}#constant`,
          targetSymbolId: `${filePath}::${conn.targetNode}#constant`,
          edgeType: 'n8n_triggers',
          metadata: { triggerType: trigger.type },
        });
      }
    }

    // ── Routes: all discoverable endpoints ──
    result.routes = extractRoutes(workflow);

    // ── Edges: sub-workflow calls ──
    const subWorkflowCalls = extractSubWorkflowCalls(workflow);
    for (const call of subWorkflowCalls) {
      result.edges!.push({
        sourceSymbolId: `${filePath}::${call.node.name}#constant`,
        edgeType: 'n8n_calls_subworkflow',
        metadata: { targetWorkflowId: call.workflowId, source: call.source },
      });
    }

    // ── Edges: HTTP requests ──
    const httpRequests = extractHttpRequests(workflow);
    for (const req of httpRequests) {
      result.edges!.push({
        sourceSymbolId: `${filePath}::${req.node.name}#constant`,
        edgeType: 'n8n_http_request',
        metadata: {
          url: req.url,
          method: req.method,
          ...(req.authentication ? { authentication: req.authentication } : {}),
        },
      });
    }

    // ── Edges: credential references (full detail) ──
    const credUsages = extractCredentialUsages(workflow);
    for (const usage of credUsages) {
      result.edges!.push({
        sourceSymbolId: `${filePath}::${usage.node.name}#constant`,
        edgeType: 'n8n_uses_credential',
        metadata: {
          credentialType: usage.credentialType,
          credentialId: usage.credentialId,
          credentialName: usage.credentialName,
        },
      });
    }

    // ── Edges: expression-based data dependencies ──
    const exprDeps = extractAllExpressionDeps(workflow);
    for (const [nodeName, deps] of exprDeps) {
      for (const dep of deps) {
        if (!nodeNameSet.has(dep)) continue;
        result.edges!.push({
          sourceSymbolId: `${filePath}::${dep}#constant`,
          targetSymbolId: `${filePath}::${nodeName}#constant`,
          edgeType: 'n8n_expression_dep',
          metadata: { referencedNode: dep },
        });
      }
    }

    // ── Edges: workflow-level error workflow reference ──
    if (workflow.settings?.errorWorkflow) {
      result.edges!.push({
        edgeType: 'n8n_error_workflow',
        metadata: {
          sourceWorkflow: workflow.name ?? filePath,
          targetWorkflowId: workflow.settings.errorWorkflow,
        },
      });
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    const allFiles = ctx.getAllFiles();
    const workflowFiles = allFiles.filter((f) => f.path.endsWith('.json'));

    // Build maps for cross-file resolution
    const workflowByName = new Map<string, { fileId: number; path: string }>();
    const workflowById = new Map<string, { fileId: number; path: string }>();
    const credentialUsers = new Map<string, Array<{ fileId: number; path: string; nodeName: string }>>();

    for (const file of workflowFiles) {
      const content = ctx.readFile(file.path);
      if (!content) continue;
      const wf = parseN8nWorkflow(Buffer.from(content));
      if (!wf) continue;

      if (wf.name) workflowByName.set(wf.name, { fileId: file.id, path: file.path });
      if (wf.id) workflowById.set(wf.id, { fileId: file.id, path: file.path });

      // Track credential usage across workflows
      const creds = extractCredentialUsages(wf);
      for (const cred of creds) {
        if (!cred.credentialId) continue;
        const key = `${cred.credentialType}:${cred.credentialId}`;
        if (!credentialUsers.has(key)) credentialUsers.set(key, []);
        credentialUsers.get(key)!.push({ fileId: file.id, path: file.path, nodeName: cred.node.name });
      }
    }

    // Resolve sub-workflow + error-workflow edges
    for (const file of workflowFiles) {
      const content = ctx.readFile(file.path);
      if (!content) continue;
      const wf = parseN8nWorkflow(Buffer.from(content));
      if (!wf) continue;

      // Sub-workflow resolution
      const calls = extractSubWorkflowCalls(wf);
      for (const call of calls) {
        const target = workflowByName.get(call.workflowId) ?? workflowById.get(call.workflowId);
        if (!target) continue;

        const symbols = ctx.getSymbolsByFile(target.fileId);
        if (symbols.length > 0) {
          edges.push({
            sourceSymbolId: `${file.path}::${call.node.name}#constant`,
            targetSymbolId: symbols[0].symbolId,
            edgeType: 'n8n_calls_subworkflow',
            resolved: true,
            metadata: {
              targetWorkflowId: call.workflowId,
              targetFile: target.path,
              source: call.source,
            },
          });
        }
      }

      // Error workflow resolution
      if (wf.settings?.errorWorkflow) {
        const target = workflowById.get(wf.settings.errorWorkflow)
          ?? workflowByName.get(wf.settings.errorWorkflow);
        if (target) {
          const symbols = ctx.getSymbolsByFile(target.fileId);
          if (symbols.length > 0) {
            edges.push({
              sourceSymbolId: `${file.path}::${wf.nodes[0]?.name}#constant`,
              targetSymbolId: symbols[0].symbolId,
              edgeType: 'n8n_error_workflow',
              resolved: true,
              metadata: {
                sourceWorkflow: wf.name ?? file.path,
                targetWorkflowId: wf.settings.errorWorkflow,
                targetFile: target.path,
              },
            });
          }
        }
      }
    }

    return ok(edges);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function findNodeByteOffset(source: string, nodeName: string): number {
  const escaped = nodeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`"name"\\s*:\\s*"${escaped}"`);
  const m = re.exec(source);
  return m ? m.index : -1;
}
