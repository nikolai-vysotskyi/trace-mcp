/**
 * One-shot stderr notice when embeddings are about to be sent to a cloud
 * provider. Borrowed from CRG v2.3.0 (#174).
 *
 * Cloud embedding providers (OpenAI, Gemini, Voyage, Vertex, MiniMax,
 * OpenAI-compatible endpoints) ship the source-code text being embedded
 * across the wire to a third party. Users running on a local-only setup
 * (Ollama, ONNX, fallback) are sometimes surprised to discover their code
 * left the machine when they flipped a config flag. The warning is the
 * canonical mitigation — quiet, single-line, easy to suppress, but firmly
 * on the path before the first vector goes out.
 *
 * Invariants:
 *   - stderr only. Never stdout, never stdin. The MCP server uses stdio
 *     for protocol traffic; corrupting stdout would break the client.
 *   - One-shot per process. Polling/scripted callers don't see a warning
 *     storm.
 *   - Suppressible via `TRACE_MCP_ACCEPT_CLOUD_EMBEDDINGS=1` for CI and
 *     scripted workflows that already understand the trade-off.
 */

const CLOUD_PROVIDERS = new Set<string>([
  'openai',
  'openai-compatible',
  'gemini',
  'voyage',
  'vertex',
  'minimax',
  'azure-openai',
  'groq',
  'anthropic-noop', // no-op but the wrapper itself reaches Anthropic for inference
]);

const LOCAL_PROVIDERS = new Set<string>(['ollama', 'onnx', 'fallback']);

let warned = false;

export function isCloudProvider(provider: string): boolean {
  return CLOUD_PROVIDERS.has(provider.toLowerCase());
}

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Fire the one-shot stderr warning for cloud embedding providers.
 *
 * Returns true if the warning was emitted on this call, false if it was
 * suppressed (already shown, env var set, or non-cloud provider). Tests
 * use the return value; callers can ignore it.
 */
export function warnIfCloudEmbeddingProvider(
  provider: string,
  options: {
    /** Override the stderr writer — used by tests. */
    write?: (msg: string) => void;
    /** Override the env var lookup — used by tests. */
    env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
  const env = options.env ?? process.env;
  if (env.TRACE_MCP_ACCEPT_CLOUD_EMBEDDINGS === '1') return false;
  if (warned) return false;
  if (!isCloudProvider(provider)) return false;

  warned = true;
  const write = options.write ?? ((msg: string) => process.stderr.write(msg));
  write(
    `trace-mcp: embedding provider "${provider}" sends source-code text to an external API. ` +
      `Set TRACE_MCP_ACCEPT_CLOUD_EMBEDDINGS=1 to suppress this warning, or switch to a local ` +
      `provider (ollama, onnx) in trace-mcp.config.json to keep code on-machine.\n`,
  );
  return true;
}

/** Test-only: clear the one-shot guard so the next call re-warns. */
export function _resetCloudWarningForTests(): void {
  warned = false;
}
