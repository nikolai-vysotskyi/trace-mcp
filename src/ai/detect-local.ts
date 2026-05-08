/**
 * Local-LLM auto-detection.
 *
 * Probes the three endpoints that are most commonly used for fully-local
 * inference in dev environments:
 *   - Ollama        — http://localhost:11434/api/tags
 *   - LM Studio     — http://localhost:1234/v1/models  (OpenAI-compatible)
 *   - llama.cpp     — http://localhost:8080/v1/models  (server with --api)
 *
 * The probes run in parallel with a short timeout (default 800ms) so a
 * `trace-mcp init` doesn't block the user when nothing is running. The
 * detector reports which providers responded, the model list each surfaced,
 * and the recommended config snippet to drop into trace-mcp.config.json.
 *
 * Mirrors mempalace v3.3.4's "init got smart and a local language model
 * does the work for free" behaviour.
 */

export type LocalProviderKind = 'ollama' | 'lm-studio' | 'llama-cpp';

export interface LocalProviderProbe {
  kind: LocalProviderKind;
  baseUrl: string;
  /** Whether the endpoint responded with HTTP 200 + a parseable model list. */
  reachable: boolean;
  /** Names of models reported by the endpoint (empty when none surfaced). */
  models: string[];
  /** Roundtrip in ms. Set even on failure for visibility. */
  latencyMs: number;
  /** Error message when reachable=false. */
  error?: string;
}

export interface DetectLocalLlmOptions {
  /** Per-endpoint timeout (ms). Default 800. */
  timeoutMs?: number;
  /** Override probes; defaults to the three known endpoints. */
  endpoints?: ReadonlyArray<{ kind: LocalProviderKind; baseUrl: string; modelsPath: string }>;
}

const DEFAULT_ENDPOINTS = [
  { kind: 'ollama' as const, baseUrl: 'http://localhost:11434', modelsPath: '/api/tags' },
  { kind: 'lm-studio' as const, baseUrl: 'http://localhost:1234', modelsPath: '/v1/models' },
  { kind: 'llama-cpp' as const, baseUrl: 'http://localhost:8080', modelsPath: '/v1/models' },
] as const;

interface OpenAiCompatibleModelList {
  data?: Array<{ id?: string }>;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

function extractModels(kind: LocalProviderKind, body: unknown): string[] {
  if (kind === 'ollama') {
    const list = (body as OllamaTagsResponse)?.models ?? [];
    return list.map((m) => m.name ?? m.model ?? '').filter((s): s is string => s.length > 0);
  }
  // OpenAI-compatible (LM Studio, llama.cpp)
  const list = (body as OpenAiCompatibleModelList)?.data ?? [];
  return list.map((m) => m.id ?? '').filter((s): s is string => s.length > 0);
}

async function probeOne(
  kind: LocalProviderKind,
  baseUrl: string,
  modelsPath: string,
  timeoutMs: number,
): Promise<LocalProviderProbe> {
  const url = baseUrl + modelsPath;
  const startedAt = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return {
        kind,
        baseUrl,
        reachable: false,
        models: [],
        latencyMs,
        error: `HTTP ${res.status}`,
      };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON — treat as a half-reachable probe (port answers but isn't
      // the expected provider).
      return {
        kind,
        baseUrl,
        reachable: false,
        models: [],
        latencyMs,
        error: 'non-JSON body',
      };
    }
    return {
      kind,
      baseUrl,
      reachable: true,
      models: extractModels(kind, body),
      latencyMs,
    };
  } catch (e) {
    return {
      kind,
      baseUrl,
      reachable: false,
      models: [],
      latencyMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface DetectLocalLlmResult {
  /** All probe results, in stable order (ollama, lm-studio, llama-cpp). */
  probes: LocalProviderProbe[];
  /** First reachable probe, or null when nothing answered. */
  recommended: LocalProviderProbe | null;
  /** Config snippet you can paste into trace-mcp.config.json. */
  configSnippet: Record<string, unknown> | null;
}

/**
 * Probe known local-LLM endpoints in parallel and return what's reachable.
 */
export async function detectLocalLlm(
  opts: DetectLocalLlmOptions = {},
): Promise<DetectLocalLlmResult> {
  const timeoutMs = opts.timeoutMs ?? 800;
  const endpoints = opts.endpoints ?? DEFAULT_ENDPOINTS;
  const probes = await Promise.all(
    endpoints.map((e) => probeOne(e.kind, e.baseUrl, e.modelsPath, timeoutMs)),
  );
  const recommended = probes.find((p) => p.reachable) ?? null;
  return {
    probes,
    recommended,
    configSnippet: recommended ? buildConfigSnippet(recommended) : null,
  };
}

function buildConfigSnippet(probe: LocalProviderProbe): Record<string, unknown> {
  // Ollama uses its own provider; LM Studio / llama.cpp speak OpenAI-compat
  // and are surfaced as `provider: openai` with a custom baseURL.
  if (probe.kind === 'ollama') {
    return {
      ai: {
        enabled: true,
        provider: 'ollama',
        ollama: {
          baseUrl: probe.baseUrl,
          // Picks a reasonable default — caller can override after install.
          model: probe.models[0] ?? 'llama3.2',
        },
      },
    };
  }
  return {
    ai: {
      enabled: true,
      provider: 'openai',
      openai: {
        baseUrl: `${probe.baseUrl}/v1`,
        // LM Studio / llama.cpp ignore the API key but the SDK requires one.
        apiKey: 'local-no-key',
        model: probe.models[0] ?? 'auto',
      },
    },
  };
}
