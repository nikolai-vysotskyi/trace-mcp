/**
 * OpenAIPythonPlugin — detects the openai Python SDK and extracts
 * LLM API call edges (chat completions, completions, embeddings, images, audio).
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
import { hasPythonDep } from '../../_shared/python-deps.js';

const IMPORT_RE = /^\s*(?:from\s+openai(?:\.\w+)?\s+import|import\s+openai)\b/m;

// client.chat.completions.create(...) | openai.ChatCompletion.create(...) | client.embeddings.create(...)
const CHAT_RE = /\b\w+\s*\.\s*chat\s*\.\s*completions\s*\.\s*create\s*\(/g;
const LEGACY_CHAT_RE = /\bopenai\s*\.\s*ChatCompletion\s*\.\s*create\s*\(/g;
const COMPLETION_RE = /\b\w+\s*\.\s*completions\s*\.\s*create\s*\(/g;
const LEGACY_COMPLETION_RE = /\bopenai\s*\.\s*Completion\s*\.\s*create\s*\(/g;
const EMBEDDING_RE = /\b\w+\s*\.\s*embeddings\s*\.\s*create\s*\(/g;
const LEGACY_EMBEDDING_RE = /\bopenai\s*\.\s*Embedding\s*\.\s*create\s*\(/g;
const IMAGE_RE = /\b\w+\s*\.\s*images\s*\.\s*(?:generate|edit|create_variation)\s*\(/g;
const AUDIO_RE =
  /\b\w+\s*\.\s*audio\s*\.\s*(?:transcriptions|translations|speech)\s*\.\s*create\s*\(/g;
const RESPONSES_RE = /\b\w+\s*\.\s*responses\s*\.\s*create\s*\(/g;

const MODEL_KW_RE = /model\s*=\s*["']([^"']+)["']/;

export class OpenAIPythonPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'openai-py',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx, 'openai');
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'llm_call',
          category: 'llm',
          description: 'OpenAI API call (chat/completion/embedding/image/audio)',
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
    if (!IMPORT_RE.test(source) && !source.includes('openai')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;

    const emit = (kind: string, idx: number) => {
      const line = findLine(idx);
      // Look ahead ~300 chars for model kwarg to annotate the edge.
      const slice = source.slice(idx, idx + 300);
      const modelMatch = slice.match(MODEL_KW_RE);
      result.edges!.push({
        edgeType: 'llm_call',
        metadata: {
          provider: 'openai',
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

    scan(CHAT_RE, 'chat');
    scan(LEGACY_CHAT_RE, 'chat');
    scan(COMPLETION_RE, 'completion');
    scan(LEGACY_COMPLETION_RE, 'completion');
    scan(EMBEDDING_RE, 'embedding');
    scan(LEGACY_EMBEDDING_RE, 'embedding');
    scan(IMAGE_RE, 'image');
    scan(AUDIO_RE, 'audio');
    scan(RESPONSES_RE, 'responses');

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
