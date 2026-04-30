/**
 * AnthropicSdkPlugin — detects @anthropic-ai/sdk (and Vertex/Bedrock variants) and
 * extracts LLM API call edges (messages, completions, batches, files).
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

const KNOWN_PACKAGES = [
  '@anthropic-ai/sdk',
  '@anthropic-ai/vertex-sdk',
  '@anthropic-ai/bedrock-sdk',
];

const IMPORT_RE = /\bfrom\s+["']@anthropic-ai\/(?:sdk|vertex-sdk|bedrock-sdk)["']/;

// client.messages.create({...}) / client.messages.stream({...})
const MESSAGES_CREATE_RE = /\b\w+\s*\.\s*messages\s*\.\s*create\s*\(/g;
const MESSAGES_STREAM_RE = /\b\w+\s*\.\s*messages\s*\.\s*stream\s*\(/g;

// client.messages.batches.create(...) / client.beta.messages.batches.create(...)
const BATCHES_RE = /\b\w+\s*(?:\.\s*beta)?\s*\.\s*messages\s*\.\s*batches\s*\.\s*create\s*\(/g;

// client.completions.create(...)
const COMPLETIONS_RE = /\b\w+\s*\.\s*completions\s*\.\s*create\s*\(/g;

// client.beta.files.upload(...) / client.files.list(...)
const FILES_RE = /\b\w+\s*(?:\.\s*beta)?\s*\.\s*files\s*\.\s*\w+\s*\(/g;

// client.messages.countTokens({...})
const COUNT_TOKENS_RE = /\b\w+\s*\.\s*messages\s*\.\s*countTokens\s*\(/g;

// model: "claude-3-5-sonnet-..."
const MODEL_KW_RE = /\bmodel\s*:\s*["']([^"']+)["']/;

export class AnthropicSdkPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'anthropic-sdk',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };
    return KNOWN_PACKAGES.some((pkg) => pkg in deps);
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
    if (!['typescript', 'javascript', 'typescriptreact', 'javascriptreact'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    if (!IMPORT_RE.test(source)) {
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
    } else {
      result.frameworkRole = 'llm_client_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
