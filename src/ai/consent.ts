/**
 * Consent gate for outbound LLM traffic.
 *
 * trace-mcp's AI provider abstraction supports cloud providers (OpenAI,
 * Anthropic, Gemini, Vertex, Voyage, …) alongside fully-local ones (Ollama,
 * ONNX, LM Studio on localhost). When a cloud provider is configured the
 * indexer will send code excerpts and natural-language queries to that
 * service — which is fine, but it's a privacy decision and shouldn't happen
 * silently the first time a user runs `embed_repo` after dropping `provider:
 * "openai"` into their config.
 *
 * The consent file lives at `~/.trace-mcp/consent.json`:
 *   {
 *     "version": 1,
 *     "providers": {
 *       "openai":   { "granted_at": "2026-05-09T08:00:00Z", "granted_by": "cli" },
 *       "anthropic": { "granted_at": "...", "granted_by": "env" }
 *     }
 *   }
 *
 * `TRACE_MCP_AI_CONSENT=1` is an escape hatch for CI / Docker / scripted
 * setups — it grants consent for the current process only without writing
 * anything to disk.
 *
 * Mirrors mempalace v3.3.4 (#1233 + #1224).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureGlobalDirs, TRACE_MCP_HOME } from '../global.js';
import { atomicWriteJson } from '../utils/atomic-write.js';

export const CONSENT_PATH = path.join(TRACE_MCP_HOME, 'consent.json');

const ENV_CONSENT_VAR = 'TRACE_MCP_AI_CONSENT';

/** Provider names that send data to an external network endpoint. */
export const REMOTE_PROVIDERS = [
  'openai',
  'anthropic',
  'gemini',
  'voyage',
  'vertex',
  'azure',
  'mistral',
  'deepseek',
  'groq',
  'openrouter',
] as const;

/** Provider names that run fully locally (no consent required). */
export const LOCAL_PROVIDERS = ['onnx', 'ollama', 'lmstudio', 'llama-cpp'] as const;

export type RemoteProvider = (typeof REMOTE_PROVIDERS)[number];

export interface ConsentRecord {
  granted_at: string;
  granted_by: 'cli' | 'env' | 'unknown';
}

interface ConsentFile {
  version: 1;
  providers: Record<string, ConsentRecord>;
}

function emptyFile(): ConsentFile {
  return { version: 1, providers: {} };
}

export function loadConsentFile(filePath: string = CONSENT_PATH): ConsentFile {
  try {
    if (!fs.existsSync(filePath)) return emptyFile();
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ConsentFile>;
    if (parsed?.version === 1 && parsed.providers) return parsed as ConsentFile;
    return emptyFile();
  } catch {
    return emptyFile();
  }
}

function saveConsentFile(data: ConsentFile, filePath: string = CONSENT_PATH): void {
  ensureGlobalDirs();
  // 0o600 — consent file is per-user state, not shared.
  atomicWriteJson(filePath, data, { mode: 0o600 });
}

export interface ConsentDecision {
  /** Whether this call is allowed to send data to the provider. */
  allowed: boolean;
  /** Why — useful for diagnostics and tests. */
  reason: 'local' | 'env' | 'persisted' | 'missing' | 'unknown-provider';
  /** Provider name as passed in (lowercased). */
  provider: string;
}

/**
 * Decide whether outbound calls to `provider` are allowed.
 *
 * - Local providers (ollama / onnx / lmstudio / llama-cpp) are always allowed.
 * - When `TRACE_MCP_AI_CONSENT=1` is set, all remote providers are allowed.
 * - Otherwise, the consent file at `~/.trace-mcp/consent.json` must contain a
 *   record for the provider.
 */
export function checkConsent(
  provider: string,
  opts: { filePath?: string; env?: NodeJS.ProcessEnv } = {},
): ConsentDecision {
  const env = opts.env ?? process.env;
  const lower = provider.toLowerCase();

  if ((LOCAL_PROVIDERS as readonly string[]).includes(lower)) {
    return { allowed: true, reason: 'local', provider: lower };
  }

  const envRaw = env[ENV_CONSENT_VAR];
  const envGranted = envRaw === '1' || envRaw === 'true' || envRaw === 'yes';
  if (envGranted) {
    return { allowed: true, reason: 'env', provider: lower };
  }

  if (!(REMOTE_PROVIDERS as readonly string[]).includes(lower)) {
    return { allowed: false, reason: 'unknown-provider', provider: lower };
  }

  const file = loadConsentFile(opts.filePath);
  if (file.providers[lower]) {
    return { allowed: true, reason: 'persisted', provider: lower };
  }
  return { allowed: false, reason: 'missing', provider: lower };
}

/** Persist consent for a provider. */
export function grantConsent(
  provider: string,
  opts: { filePath?: string; grantedBy?: ConsentRecord['granted_by'] } = {},
): ConsentRecord {
  const lower = provider.toLowerCase();
  const file = loadConsentFile(opts.filePath);
  const record: ConsentRecord = {
    granted_at: new Date().toISOString(),
    granted_by: opts.grantedBy ?? 'cli',
  };
  file.providers[lower] = record;
  saveConsentFile(file, opts.filePath);
  return record;
}

/** Remove a previously-granted consent. Returns true if a record was removed. */
export function revokeConsent(provider: string, filePath: string = CONSENT_PATH): boolean {
  const file = loadConsentFile(filePath);
  const lower = provider.toLowerCase();
  if (!file.providers[lower]) return false;
  delete file.providers[lower];
  saveConsentFile(file, filePath);
  return true;
}

/** List all providers with persisted consent. */
export function listConsent(filePath: string = CONSENT_PATH): Record<string, ConsentRecord> {
  return loadConsentFile(filePath).providers;
}

/**
 * Build a one-line, user-actionable instruction for a missing-consent path.
 * The wording mirrors mempalace's "warn before sending content to external
 * API" so the user knows exactly which command unlocks the provider.
 */
export function consentInstruction(provider: string): string {
  return (
    `Outbound LLM traffic to provider "${provider}" requires consent. ` +
    `Run "trace-mcp consent grant ${provider}" to allow it, or set ` +
    `${ENV_CONSENT_VAR}=1 for the current process only.`
  );
}
