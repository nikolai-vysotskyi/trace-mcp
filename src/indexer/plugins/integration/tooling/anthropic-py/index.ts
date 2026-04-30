/**
 * AnthropicPythonPlugin — detects the anthropic Python SDK and extracts
 * LLM API call edges (messages, completions, batches, files, vertex/bedrock variants).
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

const KNOWN_PACKAGES = ['anthropic', 'anthropic-bedrock', 'anthropic-vertex'] as const;

const IMPORT_RE = /^\s*(?:from\s+anthropic(?:\.\w+)?\s+import|import\s+anthropic)\b/m;

// Modern Messages API: client.messages.create(...) / client.messages.stream(...)
const MESSAGES_CREATE_RE = /\b\w+\s*\.\s*messages\s*\.\s*create\s*\(/g;
const MESSAGES_STREAM_RE = /\b\w+\s*\.\s*messages\s*\.\s*stream\s*\(/g;

// Batches API: client.messages.batches.create(...) / client.beta.messages.batches.create(...)
const BATCHES_RE = /\b\w+\s*(?:\.\s*beta)?\s*\.\s*messages\s*\.\s*batches\s*\.\s*create\s*\(/g;

// Legacy Completions API: client.completions.create(...)
const COMPLETIONS_RE = /\b\w+\s*\.\s*completions\s*\.\s*create\s*\(/g;

// Files API: client.beta.files.upload(...) / client.files.list(...)
const FILES_RE = /\b\w+\s*(?:\.\s*beta)?\s*\.\s*files\s*\.\s*\w+\s*\(/g;

// Token-count utility: client.messages.count_tokens(...)
const COUNT_TOKENS_RE = /\b\w+\s*\.\s*messages\s*\.\s*count_tokens\s*\(/g;

const MODEL_KW_RE = /model\s*=\s*["']([^"']+)["']/;

export class AnthropicPythonPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'anthropic-py',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, KNOWN_PACKAGES);
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'llm_call',
          category: 'llm',
          description: 'Anthropic API call (messages/completion/batch/files)',
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
    if (!IMPORT_RE.test(source) && !source.includes('anthropic')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;

    const emit = (kind: string, idx: number) => {
      const line = findLine(idx);
      const slice = source.slice(idx, idx + 300);
      const modelMatch = slice.match(MODEL_KW_RE);
      result.edges!.push({
        edgeType: 'llm_call',
        metadata: {
          provider: 'anthropic',
          kind,
          model: modelMatch?.[1] ?? '',
          filePath,
          line,
        },
      });
    };

    const scan = (re: RegExp, kind: string) => {
      for (const m of source.matchAll(re)) emit(kind, m.index ?? 0);
    };

    scan(MESSAGES_CREATE_RE, 'messages');
    scan(MESSAGES_STREAM_RE, 'messages_stream');
    scan(BATCHES_RE, 'batch');
    scan(COMPLETIONS_RE, 'completion');
    scan(FILES_RE, 'files');
    scan(COUNT_TOKENS_RE, 'count_tokens');

    if (result.edges!.length > 0) {
      result.frameworkRole = 'llm_client';
    } else if (IMPORT_RE.test(source)) {
      result.frameworkRole = 'llm_client_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
