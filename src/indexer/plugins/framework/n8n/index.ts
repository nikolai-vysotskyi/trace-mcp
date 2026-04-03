/**
 * N8nPlugin — detects n8n workflow projects and extracts workflow nodes,
 * connections, triggers, webhook endpoints, sub-workflow calls, and code nodes.
 *
 * n8n workflows are JSON files with a well-defined schema:
 *   { nodes: [...], connections: {...}, ... }
 *
 * The plugin also supports custom n8n node packages (n8n-nodes-* in package.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, err, type TraceMcpResult } from '../../../../errors.js';
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

export interface N8nNode {
  id?: string;
  name: string;
  type: string;
  position: [number, number];
  parameters?: Record<string, unknown>;
  typeVersion?: number;
  credentials?: Record<string, unknown>;
  disabled?: boolean;
}

export interface N8nConnection {
  sourceNode: string;
  sourceOutput: number;
  targetNode: string;
  targetInput: number;
}

export interface N8nWorkflow {
  name?: string;
  nodes: N8nNode[];
  connections: Record<string, Record<string, Array<Array<{ node: string; type: string; index: number }>>>>;
  active?: boolean;
  settings?: Record<string, unknown>;
  tags?: string[];
}

// ── Detection helpers ────────────────────────────────────────────────────

const N8N_TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.cronTrigger',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.emailTrigger',
  'n8n-nodes-base.httpTrigger',
  '@n8n/n8n-nodes-langchain.chatTrigger',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.workflowTrigger',
]);

const N8N_CODE_TYPES = new Set([
  'n8n-nodes-base.code',
  'n8n-nodes-base.function',
  'n8n-nodes-base.functionItem',
]);

const N8N_SUBWORKFLOW_TYPE = 'n8n-nodes-base.executeWorkflow';
const N8N_HTTP_REQUEST_TYPE = 'n8n-nodes-base.httpRequest';

// ── Parsing ──────────────────────────────────────────────────────────────

/** Try to parse a JSON buffer as an n8n workflow. Returns null if not a valid workflow. */
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

/** Extract flat connection list from n8n's nested connection format. */
export function extractConnections(workflow: N8nWorkflow): N8nConnection[] {
  const connections: N8nConnection[] = [];
  for (const [sourceName, outputs] of Object.entries(workflow.connections)) {
    for (const [outputType, outputConns] of Object.entries(outputs)) {
      for (let outputIdx = 0; outputIdx < outputConns.length; outputIdx++) {
        for (const target of outputConns[outputIdx]) {
          connections.push({
            sourceNode: sourceName,
            sourceOutput: outputIdx,
            targetNode: target.node,
            targetInput: target.index,
          });
        }
      }
    }
  }
  return connections;
}

/** Identify trigger nodes in a workflow. */
export function extractTriggers(workflow: N8nWorkflow): N8nNode[] {
  return workflow.nodes.filter(
    (n) => N8N_TRIGGER_TYPES.has(n.type) || n.type.toLowerCase().includes('trigger'),
  );
}

/** Extract webhook paths from webhook trigger nodes. */
export function extractWebhookPaths(workflow: N8nWorkflow): RawRoute[] {
  const routes: RawRoute[] = [];
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.webhook' && node.parameters) {
      const webhookPath = (node.parameters.path as string) ?? '/';
      const method = ((node.parameters.httpMethod as string) ?? 'GET').toUpperCase();
      routes.push({
        method,
        uri: webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }
  }
  return routes;
}

/** Extract code node sources for indexing. */
export function extractCodeNodes(workflow: N8nWorkflow): Array<{ node: N8nNode; code: string; language: string }> {
  const codeNodes: Array<{ node: N8nNode; code: string; language: string }> = [];
  for (const node of workflow.nodes) {
    if (N8N_CODE_TYPES.has(node.type) && node.parameters) {
      const code = (node.parameters.jsCode as string)
        ?? (node.parameters.functionCode as string)
        ?? (node.parameters.code as string)
        ?? '';
      if (code.trim()) {
        const lang = (node.parameters.language as string) ?? 'javascript';
        codeNodes.push({ node, code, language: lang });
      }
    }
  }
  return codeNodes;
}

/** Extract sub-workflow references (Execute Workflow nodes). */
export function extractSubWorkflowCalls(workflow: N8nWorkflow): Array<{ node: N8nNode; workflowId: string }> {
  const calls: Array<{ node: N8nNode; workflowId: string }> = [];
  for (const node of workflow.nodes) {
    if (node.type === N8N_SUBWORKFLOW_TYPE && node.parameters) {
      const wfId = (node.parameters.workflowId as string)
        ?? (node.parameters.workflowId as { value?: string })?.value
        ?? '';
      if (wfId) {
        calls.push({ node, workflowId: wfId });
      }
    }
  }
  return calls;
}

/** Extract HTTP request endpoints. */
export function extractHttpRequests(workflow: N8nWorkflow): Array<{ node: N8nNode; url: string; method: string }> {
  const requests: Array<{ node: N8nNode; url: string; method: string }> = [];
  for (const node of workflow.nodes) {
    if (node.type === N8N_HTTP_REQUEST_TYPE && node.parameters) {
      const url = (node.parameters.url as string) ?? '';
      const method = ((node.parameters.method as string) ?? 'GET').toUpperCase();
      if (url) {
        requests.push({ node, url, method });
      }
    }
  }
  return requests;
}

// ── Plugin ───────────────────────────────────────────────────────────────

export class N8nPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'n8n',
    version: '1.0.0',
    priority: 30,
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    // 1. Check for n8n-related deps in package.json (custom node packages)
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (Object.keys(deps).some((k) => k.startsWith('n8n-nodes') || k === 'n8n-workflow' || k === 'n8n-core')) {
        return true;
      }
    }

    // 2. Check for .n8n directory or workflow JSON files
    try {
      if (fs.existsSync(path.join(ctx.rootPath, '.n8n'))) return true;
    } catch { /* ignore */ }

    // 3. Scan for workflow JSON files in common locations
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

    // 4. Check configFiles for n8n-related configs
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
      ],
      edgeTypes: [
        { name: 'n8n_connection', category: 'n8n', description: 'Connection between n8n workflow nodes' },
        { name: 'n8n_triggers', category: 'n8n', description: 'Trigger initiates workflow execution' },
        { name: 'n8n_webhook_route', category: 'n8n', description: 'Webhook endpoint exposed by workflow' },
        { name: 'n8n_calls_subworkflow', category: 'n8n', description: 'Node executes another workflow' },
        { name: 'n8n_http_request', category: 'n8n', description: 'HTTP request to external service' },
        { name: 'n8n_uses_credential', category: 'n8n', description: 'Node references a credential' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    // Only process JSON files
    if (language !== 'json' && !filePath.endsWith('.json')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const workflow = parseN8nWorkflow(content);
    if (!workflow) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
      routes: [],
      frameworkRole: 'n8n_workflow',
      metadata: {
        workflowName: workflow.name ?? path.basename(filePath, '.json'),
        active: workflow.active ?? false,
        nodeCount: workflow.nodes.length,
        tags: workflow.tags ?? [],
      },
    };

    const source = content.toString('utf-8');

    // ── Symbols: one per workflow node ──
    for (const node of workflow.nodes) {
      const nodeId = node.id ?? node.name;
      const byteStart = source.indexOf(`"name":"${node.name}"`) !== -1
        ? source.indexOf(`"name":"${node.name}"`)
        : source.indexOf(`"name": "${node.name}"`);
      const byteEnd = byteStart >= 0 ? byteStart + node.name.length + 10 : 0;

      const isTrigger = N8N_TRIGGER_TYPES.has(node.type) || node.type.toLowerCase().includes('trigger');
      const isCode = N8N_CODE_TYPES.has(node.type);

      const symbol: RawSymbol = {
        symbolId: `${filePath}::${node.name}#constant`,
        name: node.name,
        kind: 'constant',
        signature: `[n8n:${node.type}] ${node.name}`,
        byteStart: Math.max(byteStart, 0),
        byteEnd: Math.max(byteEnd, 0),
        metadata: {
          n8nNodeType: node.type,
          n8nNodeId: nodeId,
          isTrigger,
          isCode,
          isDisabled: node.disabled ?? false,
          typeVersion: node.typeVersion,
          position: node.position,
          ...(node.credentials ? { credentials: Object.keys(node.credentials) } : {}),
        },
      };
      result.symbols.push(symbol);
    }

    // ── Edges: connections between nodes ──
    const connections = extractConnections(workflow);
    for (const conn of connections) {
      result.edges!.push({
        sourceSymbolId: `${filePath}::${conn.sourceNode}#constant`,
        targetSymbolId: `${filePath}::${conn.targetNode}#constant`,
        edgeType: 'n8n_connection',
        metadata: {
          sourceOutput: conn.sourceOutput,
          targetInput: conn.targetInput,
        },
      });
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

    // ── Routes: webhook endpoints ──
    result.routes = extractWebhookPaths(workflow);

    // ── Edges: sub-workflow calls ──
    const subWorkflowCalls = extractSubWorkflowCalls(workflow);
    for (const call of subWorkflowCalls) {
      result.edges!.push({
        sourceSymbolId: `${filePath}::${call.node.name}#constant`,
        edgeType: 'n8n_calls_subworkflow',
        metadata: { targetWorkflowId: call.workflowId },
      });
    }

    // ── Edges: HTTP requests ──
    const httpRequests = extractHttpRequests(workflow);
    for (const req of httpRequests) {
      result.edges!.push({
        sourceSymbolId: `${filePath}::${req.node.name}#constant`,
        edgeType: 'n8n_http_request',
        metadata: { url: req.url, method: req.method },
      });
    }

    // ── Edges: credential references ──
    for (const node of workflow.nodes) {
      if (node.credentials) {
        for (const [credType] of Object.entries(node.credentials)) {
          result.edges!.push({
            sourceSymbolId: `${filePath}::${node.name}#constant`,
            edgeType: 'n8n_uses_credential',
            metadata: { credentialType: credType },
          });
        }
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    // Cross-file resolution: link sub-workflow calls to their target workflow files
    const allFiles = ctx.getAllFiles();
    const workflowFiles = allFiles.filter((f) => f.path.endsWith('.json'));

    // Build a map of workflow name → file symbols for cross-referencing
    const workflowMap = new Map<string, { fileId: number; path: string }>();
    for (const file of workflowFiles) {
      const content = ctx.readFile(file.path);
      if (!content) continue;
      try {
        const wf = parseN8nWorkflow(Buffer.from(content));
        if (wf?.name) {
          workflowMap.set(wf.name, { fileId: file.id, path: file.path });
        }
      } catch { /* ignore */ }
    }

    // Resolve sub-workflow edges by matching workflow names
    for (const file of workflowFiles) {
      const content = ctx.readFile(file.path);
      if (!content) continue;
      const wf = parseN8nWorkflow(Buffer.from(content));
      if (!wf) continue;

      const calls = extractSubWorkflowCalls(wf);
      for (const call of calls) {
        const target = workflowMap.get(call.workflowId);
        if (target) {
          const symbols = ctx.getSymbolsByFile(target.fileId);
          if (symbols.length > 0) {
            edges.push({
              sourceSymbolId: `${file.path}::${call.node.name}#constant`,
              targetSymbolId: symbols[0].symbolId,
              edgeType: 'n8n_calls_subworkflow',
              resolved: true,
              metadata: { targetWorkflowId: call.workflowId, targetFile: target.path },
            });
          }
        }
      }
    }

    return ok(edges);
  }
}
