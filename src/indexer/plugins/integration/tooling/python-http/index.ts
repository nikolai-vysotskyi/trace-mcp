/**
 * PythonHttpClientsPlugin — detects Python HTTP clients (requests, httpx, aiohttp)
 * and extracts outgoing HTTP call edges.
 */
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { hasAnyPythonDep } from '../../_shared/python-deps.js';

const PACKAGES = ['requests', 'httpx', 'aiohttp'] as const;

// requests.get(url, ...), requests.post(url, ...), requests.Session().get(url, ...)
const REQUESTS_CALL_RE =
  /\brequests\s*\.\s*(get|post|put|patch|delete|head|options|request)\s*\(\s*(?:(?:f|r|b)?["']([^"']+)["'])?/g;

// httpx.get(url) / httpx.AsyncClient().get(url) / client.get(url) inside httpx scope
const HTTPX_CALL_RE =
  /\bhttpx\s*\.\s*(?:Async)?Client\s*\(|httpx\s*\.\s*(get|post|put|patch|delete|head|options|request)\s*\(\s*(?:(?:f|r|b)?["']([^"']+)["'])?/g;

// aiohttp.ClientSession().get(url) / session.get(url) (inside aiohttp scope)
const AIOHTTP_SESSION_RE = /\baiohttp\s*\.\s*ClientSession\s*\(/g;
const AIOHTTP_CALL_RE =
  /\b(?:await\s+)?(?:session|client)\s*\.\s*(get|post|put|patch|delete|head|options|request)\s*\(\s*(?:(?:f|r|b)?["']([^"']+)["'])?/g;

// import patterns
const IMPORT_RE =
  /^\s*(?:from\s+(requests|httpx|aiohttp)(?:\.\w+)?\s+import|import\s+(requests|httpx|aiohttp))\b/m;

export class PythonHttpClientsPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'python-http',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, PACKAGES);
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'http_outbound',
          category: 'http',
          description: 'Outgoing HTTP call (requests/httpx/aiohttp)',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    if (
      !IMPORT_RE.test(source) &&
      !source.includes('requests.') &&
      !source.includes('httpx.') &&
      !source.includes('aiohttp.')
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const lines = source.split('\n');

    const emit = (library: string, method: string, url: string | undefined, line: number) => {
      result.edges!.push({
        edgeType: 'http_outbound',
        metadata: {
          library,
          method: method.toUpperCase(),
          url: url ?? '',
          filePath,
          line,
        },
      });
    };

    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;

    for (const m of source.matchAll(REQUESTS_CALL_RE)) {
      emit('requests', m[1], m[2], findLine(m.index ?? 0));
    }
    for (const m of source.matchAll(HTTPX_CALL_RE)) {
      if (!m[1]) continue;
      emit('httpx', m[1], m[2], findLine(m.index ?? 0));
    }

    // aiohttp is more context-sensitive: only emit method calls if file imports aiohttp
    if (/\baiohttp\b/.test(source)) {
      // Track session/client variable via aiohttp.ClientSession()
      const hasSession =
        AIOHTTP_SESSION_RE.test(source) || /\baiohttp\s*\.\s*request\s*\(/.test(source);
      if (hasSession) {
        for (const m of source.matchAll(AIOHTTP_CALL_RE)) {
          emit('aiohttp', m[1], m[2], findLine(m.index ?? 0));
        }
      }
      // Also support top-level aiohttp.request('GET', url)
      for (const m of source.matchAll(
        /\baiohttp\s*\.\s*request\s*\(\s*["']([A-Z]+)["']\s*,\s*(?:(?:f|r|b)?["']([^"']+)["'])?/g,
      )) {
        emit('aiohttp', m[1], m[2], findLine(m.index ?? 0));
      }
    }

    if (result.edges!.length > 0) {
      result.frameworkRole = 'http_client';
    } else if (IMPORT_RE.test(source)) {
      result.frameworkRole = 'http_client_import';
    }
    // Unused var — keeping for potential future line-based extraction
    void lines;

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
