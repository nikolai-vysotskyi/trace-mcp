/**
 * Shared LLM provider resolution, context retrieval, and chat helpers.
 * Used by both the CLI `trace-mcp ask` command and the daemon HTTP `/api/ask` endpoint.
 */

import type { TraceMcpConfig } from '../config.js';
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { ChatMessage } from './interfaces.js';
import { parseAnthropicStream, parseGeminiStream, parseOpenAIStream } from './sse.js';

// ---------------------------------------------------------------------------
// LLM provider interface + factories
// ---------------------------------------------------------------------------

export interface LLMProvider {
  name: string;
  streamChat(
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number },
  ): AsyncIterable<string>;
}

export function createOpenAICompatibleProvider(
  name: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): LLMProvider {
  return {
    name: `${name} (${model})`,
    async *streamChat(messages, options) {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`${name} API error: ${resp.status} — ${body.slice(0, 300)}`);
      }

      yield* parseOpenAIStream(resp.body!);
    },
  };
}

export function createVertexAIProvider(
  accessToken: string,
  project: string,
  location: string,
  model: string,
): LLMProvider {
  const host = `https://${location}-aiplatform.googleapis.com`;
  const url = `${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:streamGenerateContent?alt=sse`;
  return {
    name: `vertex (${model})`,
    async *streamChat(messages, options) {
      const systemMsg = messages.find((m) => m.role === 'system');
      const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
      const contents = nonSystemMsgs.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          contents,
          ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
          generationConfig: {
            ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
            ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Vertex AI API error: ${resp.status} — ${body.slice(0, 300)}`);
      }

      yield* parseGeminiStream(resp.body!);
    },
  };
}

export function createAnthropicProvider(apiKey: string, model: string): LLMProvider {
  return {
    name: `anthropic (${model})`,
    async *streamChat(messages, options) {
      const systemMsg = messages.find((m) => m.role === 'system');
      const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: options?.maxTokens ?? 4096,
          stream: true,
          ...(systemMsg ? { system: systemMsg.content } : {}),
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Anthropic API error: ${resp.status} — ${body.slice(0, 300)}`);
      }

      yield* parseAnthropicStream(resp.body!);
    },
  };
}

// ---------------------------------------------------------------------------
// Provider resolution — env vars → config fallback
// ---------------------------------------------------------------------------

/** Treat empty/whitespace strings as unset. */
const pick = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v : fallback;

export function resolveProvider(
  opts: { model?: string; provider?: string },
  config?: TraceMcpConfig,
): LLMProvider {
  // Respect per-capability gates: Ask requires inference.
  if (config?.ai?.enabled && config.ai.features && config.ai.features.inference === false) {
    throw new Error(
      'AI inference is disabled in settings (ai.features.inference = false). Enable it to use Ask.',
    );
  }
  // 1. Explicit --provider flag or env vars
  if (opts.provider === 'groq' || (!opts.provider && process.env.GROQ_API_KEY)) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY environment variable is required for Groq provider');
    return createOpenAICompatibleProvider(
      'groq',
      'https://api.groq.com/openai/v1',
      key,
      pick(opts.model, 'llama-3.3-70b-versatile'),
    );
  }

  if (opts.provider === 'anthropic' || (!opts.provider && process.env.ANTHROPIC_API_KEY)) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key)
      throw new Error('ANTHROPIC_API_KEY environment variable is required for Anthropic provider');
    return createAnthropicProvider(key, pick(opts.model, 'claude-sonnet-4-6'));
  }

  if (opts.provider === 'openai' || (!opts.provider && process.env.OPENAI_API_KEY)) {
    const key = process.env.OPENAI_API_KEY;
    if (!key)
      throw new Error('OPENAI_API_KEY environment variable is required for OpenAI provider');
    return createOpenAICompatibleProvider(
      'openai',
      'https://api.openai.com/v1',
      key,
      pick(opts.model, 'gpt-4o-mini'),
    );
  }

  if (
    opts.provider === 'vertex' ||
    (!opts.provider && process.env.GOOGLE_ACCESS_TOKEN && process.env.GOOGLE_CLOUD_PROJECT)
  ) {
    const token = process.env.GOOGLE_ACCESS_TOKEN ?? config?.ai?.api_key ?? '';
    const project = process.env.GOOGLE_CLOUD_PROJECT ?? config?.ai?.vertex_project ?? '';
    const location = pick(
      process.env.GOOGLE_CLOUD_LOCATION,
      pick(config?.ai?.vertex_location, 'us-central1'),
    );
    if (!token)
      throw new Error(
        'GOOGLE_ACCESS_TOKEN environment variable (or ai.api_key) is required for Vertex AI provider',
      );
    if (!project)
      throw new Error(
        'GOOGLE_CLOUD_PROJECT environment variable (or ai.vertex_project) is required for Vertex AI provider',
      );
    return createVertexAIProvider(token, project, location, pick(opts.model, 'gemini-2.5-flash'));
  }

  // 2. Fallback: config-level AI provider
  if (config?.ai?.enabled && config.ai.provider !== 'onnx') {
    const provider = config.ai.provider;
    const model = pick(opts.model, pick(config.ai.inference_model, ''));

    if (provider === 'openai') {
      const key = config.ai.api_key ?? process.env.OPENAI_API_KEY ?? '';
      if (key) {
        return createOpenAICompatibleProvider(
          'openai',
          pick(config.ai.base_url, 'https://api.openai.com/v1'),
          key,
          pick(model, 'gpt-4o-mini'),
        );
      }
    }

    if (provider === 'ollama') {
      const baseUrl = pick(config.ai.base_url, 'http://localhost:11434');
      return createOpenAICompatibleProvider('ollama', `${baseUrl}/v1`, '', pick(model, 'llama3.2'));
    }

    if (provider === 'vertex') {
      const token = config.ai.api_key ?? process.env.GOOGLE_ACCESS_TOKEN ?? '';
      const project = config.ai.vertex_project ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
      const location = pick(
        config.ai.vertex_location,
        pick(process.env.GOOGLE_CLOUD_LOCATION, 'us-central1'),
      );
      if (token && project) {
        return createVertexAIProvider(token, project, location, pick(model, 'gemini-2.5-flash'));
      }
    }
  }

  throw new Error(
    'No LLM provider found. Set one of these environment variables:\n' +
      '  GROQ_API_KEY     — Groq (fast, free tier)\n' +
      '  ANTHROPIC_API_KEY — Anthropic (Claude)\n' +
      '  OPENAI_API_KEY   — OpenAI (GPT)\n' +
      '  GOOGLE_ACCESS_TOKEN + GOOGLE_CLOUD_PROJECT — Google Vertex AI\n' +
      '\nOr configure ai.provider + ai.api_key in trace-mcp.config.json\n' +
      'Or use --provider <groq|anthropic|openai|vertex>',
  );
}

// ---------------------------------------------------------------------------
// Context retrieval
// ---------------------------------------------------------------------------

export async function gatherContext(
  projectRoot: string,
  store: Store,
  pluginRegistry: PluginRegistry,
  question: string,
  tokenBudget: number,
): Promise<string> {
  const { packContext } = await import('../tools/refactoring/pack-context.js');
  const result = packContext(store, pluginRegistry, {
    scope: 'feature',
    query: question,
    maxTokens: tokenBudget,
    format: 'markdown',
    strategy: 'most_relevant',
    compress: false,
    include: ['outlines', 'source'],
    projectRoot,
  });

  return result.content;
}

// ---------------------------------------------------------------------------
// System prompt + message helpers
// ---------------------------------------------------------------------------

export function buildSystemPrompt(projectRoot: string): string {
  return [
    'You are a code expert answering questions about a software project.',
    `Project root: ${projectRoot}`,
    '',
    "You will be given relevant code context retrieved from the project's dependency graph.",
    'Use the provided context to give accurate, specific answers.',
    'Reference file paths and symbol names when relevant.',
    "If the context doesn't contain enough information, say so honestly.",
    'Keep answers concise but thorough.',
  ].join('\n');
}

/** Strip code context from a message, keeping only the question. */
export function stripContextFromMessage(msg: ChatMessage): ChatMessage {
  if (msg.role !== 'user') return msg;
  const marker = '## Question\n\n';
  const idx = msg.content.indexOf(marker);
  if (idx === -1) return msg;
  return { ...msg, content: msg.content.slice(idx + marker.length) };
}
