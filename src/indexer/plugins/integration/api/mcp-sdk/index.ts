/**
 * McpSdkPlugin — detects MCP (Model Context Protocol) server projects and
 * extracts tool, resource, and prompt registrations.
 *
 * Recognises the `@modelcontextprotocol/sdk` package and its common
 * `server.tool(...)`, `server.resource(...)`, `server.prompt(...)` patterns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// --- Detection -----------------------------------------------------------------

const MCP_SDK_PKG = '@modelcontextprotocol/sdk';

// --- Extraction patterns -------------------------------------------------------

// server.tool("name", "description", { schema }, handler)
// server.tool("name", { schema }, handler)
// server.tool("name", handler)
const TOOL_RE =
  /\.tool\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?/g;

// server.resource("name", template, handler)  — resource with template
// server.resource("name", handler)
const RESOURCE_RE =
  /\.resource\(\s*['"]([^'"]+)['"]/g;

// server.prompt("name", ...)
const PROMPT_RE =
  /\.prompt\(\s*['"]([^'"]+)['"]/g;

// McpServer import detection
const MCP_SERVER_IMPORT_RE =
  /(?:import|require)\s*(?:\(|{)?\s*.*McpServer.*from\s+['"]@modelcontextprotocol\/sdk/;

const MCP_TRANSPORT_IMPORT_RE =
  /(?:import|require)\s*(?:\(|{)?\s*.*Transport.*from\s+['"]@modelcontextprotocol\/sdk/;

// --- Helpers -------------------------------------------------------------------

export interface McpRegistration {
  kind: 'tool' | 'resource' | 'prompt';
  name: string;
  description?: string;
}

export function extractMcpRegistrations(source: string): McpRegistration[] {
  const results: McpRegistration[] = [];

  let m: RegExpExecArray | null;

  const toolRe = new RegExp(TOOL_RE.source, 'g');
  while ((m = toolRe.exec(source)) !== null) {
    results.push({ kind: 'tool', name: m[1], description: m[2] || undefined });
  }

  const resourceRe = new RegExp(RESOURCE_RE.source, 'g');
  while ((m = resourceRe.exec(source)) !== null) {
    results.push({ kind: 'resource', name: m[1] });
  }

  const promptRe = new RegExp(PROMPT_RE.source, 'g');
  while ((m = promptRe.exec(source)) !== null) {
    results.push({ kind: 'prompt', name: m[1] });
  }

  return results;
}

// --- Plugin --------------------------------------------------------------------

export class McpSdkPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'mcp-sdk',
    version: '1.0.0',
    priority: 25,
    category: 'api',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (MCP_SDK_PKG in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return MCP_SDK_PKG in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'mcp_tool', category: 'mcp', description: 'MCP tool registration' },
        { name: 'mcp_resource', category: 'mcp', description: 'MCP resource registration' },
        { name: 'mcp_prompt', category: 'mcp', description: 'MCP prompt registration' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    const hasServerImport = MCP_SERVER_IMPORT_RE.test(source);
    const hasTransportImport = MCP_TRANSPORT_IMPORT_RE.test(source);

    const registrations = extractMcpRegistrations(source);

    if (registrations.length > 0) {
      result.frameworkRole = 'mcp_server';

      for (const reg of registrations) {
        result.routes!.push({
          method: reg.kind.toUpperCase() as string,
          uri: reg.name,
        });
      }
    } else if (hasServerImport) {
      result.frameworkRole = 'mcp_server';
    } else if (hasTransportImport) {
      result.frameworkRole = 'mcp_transport';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    return ok(edges);
  }
}
