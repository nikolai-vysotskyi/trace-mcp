/**
 * Shared SSE / NDJSON stream parsers.
 * Used by OpenAI-compatible providers (OpenAI, Groq) and Anthropic streaming.
 */

/**
 * Parse an SSE (Server-Sent Events) stream from an OpenAI-compatible endpoint.
 * Yields content delta strings as they arrive.
 */
export async function* parseOpenAIStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') return;

        try {
          const chunk = JSON.parse(payload) as {
            choices: { delta: { content?: string } }[];
          };
          const content = chunk.choices[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip malformed SSE chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse an SSE stream from the Anthropic Messages API.
 * Yields content delta text strings as they arrive.
 */
export async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);

        try {
          const event = JSON.parse(payload) as {
            type: string;
            delta?: { type?: string; text?: string };
          };
          if (event.type === 'content_block_delta' && event.delta?.text) {
            yield event.delta.text;
          }
          if (event.type === 'message_stop') return;
        } catch {
          // skip malformed SSE
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse an NDJSON stream from Ollama's chat API.
 * Yields content strings as they arrive.
 */
export async function* parseOllamaChatStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          if (chunk.done) return;
          if (chunk.message?.content) yield chunk.message.content;
        } catch {
          // skip malformed NDJSON lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
