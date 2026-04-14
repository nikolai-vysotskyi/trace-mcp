/**
 * Shared LLM provider resolution, context retrieval, and chat helpers.
 * Used by both the CLI `trace-mcp ask` command and the daemon HTTP `/api/ask` endpoint.
 */

import type { TraceMcpConfig } from '../config.js';
import type { Store } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { ChatMessage } from './interfaces.js';
import { parseOpenAIStream, parseAnthropicStream } from './sse.js';

// ---------------------------------------------------------------------------
// LLM provider interface + factories
// ---------------------------------------------------------------------------

export interface LLMProvider {
  name: string;
  streamChat(messages: ChatMessage[], options?: { maxTokens?: number; temperature?: number }): AsyncIterable<string>;
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

export function createAnthropicProvider(apiKey: string, model: string): LLMProvider {
  return {
    name: `anthropic (${model})`,
    async *streamChat(messages, options) {
      const systemMsg = messages.find(m => m.role === 'system');
      const nonSystemMsgs = messages.filter(m => m.role !== 'system');

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
          messages: nonSystemMsgs.map(m => ({ role: m.role, content: m.content })),
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

export function resolveProvider(opts: { model?: string; provider?: string }, config?: TraceMcpConfig): LLMProvider {
  // 1. Explicit --provider flag or env vars
  if (opts.provider === 'groq' || (!opts.provider && process.env.GROQ_API_KEY)) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY environment variable is required for Groq provider');
    return createOpenAICompatibleProvider(
      'groq', 'https://api.groq.com/openai/v1', key,
      opts.model ?? 'llama-3.3-70b-versatile',
    );
  }

  if (opts.provider === 'anthropic' || (!opts.provider && process.env.ANTHROPIC_API_KEY)) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY environment variable is required for Anthropic provider');
    return createAnthropicProvider(key, opts.model ?? 'claude-sonnet-4-20250514');
  }

  if (opts.provider === 'openai' || (!opts.provider && process.env.OPENAI_API_KEY)) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY environment variable is required for OpenAI provider');
    return createOpenAICompatibleProvider(
      'openai', 'https://api.openai.com/v1', key,
      opts.model ?? 'gpt-4o-mini',
    );
  }

  // 2. Fallback: config-level AI provider
  if (config?.ai?.enabled && config.ai.provider !== 'onnx') {
    const provider = config.ai.provider;
    const model = opts.model ?? config.ai.inference_model;

    if (provider === 'openai') {
      const key = config.ai.api_key ?? process.env.OPENAI_API_KEY ?? '';
      if (key) {
        return createOpenAICompatibleProvider(
          'openai', config.ai.base_url ?? 'https://api.openai.com/v1', key,
          model ?? 'gpt-4o-mini',
        );
      }
    }

    if (provider === 'ollama') {
      const baseUrl = config.ai.base_url ?? 'http://localhost:11434';
      return createOpenAICompatibleProvider(
        'ollama', `${baseUrl}/v1`, '',
        model ?? 'gemma4-e4b',
      );
    }
  }

  throw new Error(
    'No LLM provider found. Set one of these environment variables:\n' +
    '  GROQ_API_KEY     — Groq (fast, free tier)\n' +
    '  ANTHROPIC_API_KEY — Anthropic (Claude)\n' +
    '  OPENAI_API_KEY   — OpenAI (GPT)\n' +
    '\nOr configure ai.provider + ai.api_key in trace-mcp.config.json\n' +
    'Or use --provider <groq|anthropic|openai>',
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
    'You will be given relevant code context retrieved from the project\'s dependency graph.',
    'Use the provided context to give accurate, specific answers.',
    'Reference file paths and symbol names when relevant.',
    'If the context doesn\'t contain enough information, say so honestly.',
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
