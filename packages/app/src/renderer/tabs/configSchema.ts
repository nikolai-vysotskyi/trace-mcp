/**
 * Schema describing all ~/.trace-mcp/.config.json sections.
 * Drives the Settings UI — each section is a collapsible group,
 * each field renders the appropriate control.
 */

export type FieldType = 'boolean' | 'string' | 'number' | 'select' | 'array' | 'json' | 'multiselect' | 'model-select';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];           // for 'select' and 'multiselect' types
  placeholder?: string;
  description?: string;
  sensitive?: boolean;          // mask value (api keys)
  nested?: string;              // dot-path parent, e.g. "otlp" for runtime.otlp.port
  /** For 'model-select': which provider field to read to determine the model source.
   *  The value of that field determines which API to call (ollama / openai). */
  modelProvider?: string;
  /** For 'model-select': which field holds the base URL for the provider. */
  modelBaseUrlField?: string;
  min?: number;                 // for 'number' type
  max?: number;                 // for 'number' type
  pattern?: string;             // regex for 'string' type
  defaultValue?: unknown;       // default value for reset
  /** Show this field only when another field in the same section matches a value.
   *  Format: "field_key" (truthy check) or "field_key=value" (exact match). */
  showIf?: string;
}

export interface SectionDef {
  key: string;
  label: string;
  icon: string;
  description?: string;
  fields: FieldDef[];
}

// ── Validation ─────────────────────────────────────────────────────────

/** Validate a field value against its schema definition. Returns error message or null. */
export function validateField(field: FieldDef, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;

  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return 'Must be true or false';
      break;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number';
      if (field.min != null && value < field.min) return `Min: ${field.min}`;
      if (field.max != null && value > field.max) return `Max: ${field.max}`;
      break;
    }
    case 'string': {
      if (typeof value !== 'string') return 'Must be a string';
      if (field.pattern) {
        try { if (!new RegExp(field.pattern).test(value)) return `Must match: ${field.pattern}`; }
        catch { /* invalid pattern, skip */ }
      }
      break;
    }
    case 'select':
      if (field.options && !field.options.includes(value as string)) {
        return `Must be one of: ${field.options.join(', ')}`;
      }
      break;
    case 'multiselect':
    case 'array':
      if (!Array.isArray(value)) return 'Must be a list';
      break;
    case 'model-select':
      if (typeof value !== 'string') return 'Must be a string';
      break;
    case 'json':
      if (typeof value === 'string') return 'Must be valid JSON (not a string)';
      break;
  }
  return null;
}

/** Validate an entire section. Returns map of field keys to error messages. */
export function validateSection(section: SectionDef, data: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of section.fields) {
    let value: unknown;
    if (field.nested) {
      const parent = data[field.nested];
      value = (parent && typeof parent === 'object') ? (parent as Record<string, unknown>)[field.key] : undefined;
    } else if (section.key === 'frameworks' && field.key === 'frameworks') {
      value = data;
    } else {
      value = data[field.key];
    }
    const err = validateField(field, value);
    if (err) errors[`${field.nested ? field.nested + '.' : ''}${field.key}`] = err;
  }
  return errors;
}

// ── showIf evaluation ──────────────────────────────────────────────────

/** Check if a field should be visible given the section data. */
export function isFieldVisible(field: FieldDef, sectionData: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  const eqIndex = field.showIf.indexOf('=');
  if (eqIndex !== -1) {
    const depKey = field.showIf.slice(0, eqIndex);
    const depVal = field.showIf.slice(eqIndex + 1);
    return String(sectionData[depKey] ?? '') === depVal;
  }
  return !!sectionData[field.showIf];
}

// ── Defaults ───────────────────────────────────────────────────────────

/** Get the default values for a section as a flat record. */
export function getSectionDefaults(section: SectionDef): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const f of section.fields) {
    if (f.defaultValue !== undefined) {
      if (f.nested) {
        if (!defaults[f.nested] || typeof defaults[f.nested] !== 'object') defaults[f.nested] = {};
        (defaults[f.nested] as Record<string, unknown>)[f.key] = f.defaultValue;
      } else {
        defaults[f.key] = f.defaultValue;
      }
    }
  }
  return defaults;
}

/** Count how many fields differ from defaults in a section. */
export function countModifiedFields(section: SectionDef, data: Record<string, unknown>): number {
  let count = 0;
  for (const f of section.fields) {
    let value: unknown;
    if (f.nested) {
      const parent = data[f.nested];
      value = (parent && typeof parent === 'object') ? (parent as Record<string, unknown>)[f.key] : undefined;
    } else {
      value = data[f.key];
    }
    const def = f.defaultValue;
    // Count as modified if value is set and differs from default
    if (value !== undefined && value !== null && value !== '') {
      if (def === undefined) {
        count++; // no default = any value is "modified"
      } else if (JSON.stringify(value) !== JSON.stringify(def)) {
        count++;
      }
    } else if (def !== undefined && def !== null && def !== '' && def !== false) {
      // Default exists but value is empty = also modified (cleared)
      count++;
    }
  }
  return count;
}

// ── Diff ───────────────────────────────────────────────────────────────

export interface DiffEntry {
  section: string;
  field: string;
  from: unknown;
  to: unknown;
}

/** Compute diff between server config and local config. */
export function computeDiff(
  serverConfig: Record<string, unknown>,
  localConfig: Record<string, unknown>,
): DiffEntry[] {
  const entries: DiffEntry[] = [];

  for (const section of CONFIG_SCHEMA) {
    const serverSection = section.key === '_root' ? serverConfig : (serverConfig[section.key] as Record<string, unknown>) ?? {};
    const localSection = section.key === '_root' ? localConfig : (localConfig[section.key] as Record<string, unknown>) ?? {};

    for (const field of section.fields) {
      let fromVal: unknown;
      let toVal: unknown;

      if (section.key === '_root') {
        fromVal = (serverSection as Record<string, unknown>)[field.key];
        toVal = (localSection as Record<string, unknown>)[field.key];
      } else if (field.nested) {
        const sp = (serverSection as Record<string, unknown>)?.[field.nested];
        const lp = (localSection as Record<string, unknown>)?.[field.nested];
        fromVal = sp && typeof sp === 'object' ? (sp as Record<string, unknown>)[field.key] : undefined;
        toVal = lp && typeof lp === 'object' ? (lp as Record<string, unknown>)[field.key] : undefined;
      } else {
        fromVal = (serverSection as Record<string, unknown>)?.[field.key];
        toVal = (localSection as Record<string, unknown>)?.[field.key];
      }

      if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
        entries.push({
          section: section.label,
          field: field.nested ? `${field.nested}.${field.label}` : field.label,
          from: fromVal,
          to: toVal,
        });
      }
    }
  }
  return entries;
}

// ── Schema ─────────────────────────────────────────────────────────────

export const CONFIG_SCHEMA: SectionDef[] = [
  {
    key: '_root',
    label: 'General',
    icon: '⚡',
    description: 'Auto-update and top-level settings',
    fields: [
      { key: 'auto_update', label: 'Auto-update', type: 'boolean', defaultValue: true },
      { key: 'auto_update_check_interval_hours', label: 'Update check interval (hours)', type: 'number', placeholder: '24', min: 1, defaultValue: 24, showIf: 'auto_update' },
      { key: 'logLevel', label: 'Daemon log level', type: 'select', options: ['debug', 'info', 'warn', 'error'], defaultValue: 'info' },
    ],
  },
  {
    key: 'ai',
    label: 'AI / Embeddings',
    icon: '🧠',
    description: 'AI provider for semantic search, summaries, and intent classification',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: false },
      { key: 'provider', label: 'Provider', type: 'select', options: ['onnx', 'ollama', 'lmstudio', 'openai', 'anthropic', 'gemini', 'vertex', 'voyage', 'mistral', 'groq', 'together', 'deepseek', 'xai'], defaultValue: 'onnx', showIf: 'enabled', description: 'onnx = local zero-config. ollama/lmstudio = local with model choice. gemini = Google Generative Language API (consumer, AIza key). vertex = Google Vertex AI (GCP, OAuth bearer token + project/location). voyage = Voyage AI embeddings only. Others = cloud APIs.' },

      // ── Per-capability enable flags ──
      // Lets users run embeddings without inference (or vice versa) without switching provider.
      // Disabled capabilities short-circuit to no-op services; no other code changes required.
      { key: 'embedding', label: 'Use embeddings', type: 'boolean', nested: 'features', defaultValue: true, showIf: 'enabled', description: 'Generate vector embeddings for semantic search and reranking. Turn off to disable semantic search while keeping inference.' },
      { key: 'inference', label: 'Use inference', type: 'boolean', nested: 'features', defaultValue: true, showIf: 'enabled', description: 'Call the LLM for summarization, intent classification, and Ask. Turn off to skip all LLM calls while keeping embeddings.' },
      { key: 'fast_inference', label: 'Use fast inference', type: 'boolean', nested: 'features', defaultValue: true, showIf: 'enabled', description: 'Use the fast model for low-latency tasks. When off, fast-path callers receive empty responses — leave on unless debugging.' },

      // ── Connection: Ollama ──
      { key: 'base_url', label: 'Base URL', type: 'string', placeholder: 'http://localhost:11434', showIf: 'provider=ollama', description: 'Ollama server endpoint. Change if running on a different host or port.' },
      // ── Connection: LM Studio ──
      { key: 'base_url', label: 'Base URL', type: 'string', placeholder: 'http://localhost:1234/v1', showIf: 'provider=lmstudio', description: 'LM Studio local server endpoint.' },
      // ── Connection: OpenAI ──
      { key: 'base_url', label: 'Base URL', type: 'string', placeholder: 'https://api.openai.com', showIf: 'provider=openai', description: 'OpenAI API endpoint. Change for Azure OpenAI or compatible providers.' },
      { key: 'api_key', label: 'API Key', type: 'string', placeholder: 'sk-...', sensitive: true, showIf: 'provider=openai', description: 'Required. Or set OPENAI_API_KEY env var.' },
      // ── Connection: Anthropic ──
      { key: 'api_key', label: 'API Key', type: 'string', placeholder: 'sk-ant-...', sensitive: true, showIf: 'provider=anthropic', description: 'Anthropic API key from console.anthropic.com. Or set ANTHROPIC_API_KEY env var.' },
      // ── Connection: Gemini (Google Generative Language API — consumer endpoint) ──
      { key: 'api_key', label: 'API Key', type: 'string', placeholder: 'AIza...', sensitive: true, showIf: 'provider=gemini', description: 'Google Generative Language API key from ai.google.dev (starts with AIza). Or set GEMINI_API_KEY env var. For GCP/Vertex use the "vertex" provider instead.' },
      // ── Connection: Vertex AI (Google Cloud) ──
      { key: 'api_key', label: 'Access Token', type: 'string', placeholder: 'ya29....', sensitive: true, showIf: 'provider=vertex', description: 'OAuth2 bearer token (short-lived, ~1h). Generate via: gcloud auth print-access-token. Or set GOOGLE_ACCESS_TOKEN env var.' },
      { key: 'vertex_project', label: 'GCP Project', type: 'string', placeholder: 'my-gcp-project', showIf: 'provider=vertex', description: 'Google Cloud project ID hosting Vertex AI. Or set GOOGLE_CLOUD_PROJECT env var.' },
      { key: 'vertex_location', label: 'GCP Location', type: 'string', placeholder: 'us-central1', defaultValue: 'us-central1', showIf: 'provider=vertex', description: 'Vertex AI region (e.g. us-central1, europe-west4, asia-northeast1). Or set GOOGLE_CLOUD_LOCATION env var.' },
      // ── Connection: Voyage ──
      { key: 'base_url', label: 'Base URL', type: 'string', placeholder: 'https://api.voyageai.com/v1', showIf: 'provider=voyage', description: 'Voyage AI endpoint. Usually the default.' },
      { key: 'api_key', label: 'API Key', type: 'string', placeholder: 'pa-...', sensitive: true, showIf: 'provider=voyage', description: 'Voyage API key from dash.voyageai.com. Or set VOYAGE_API_KEY env var. Embeddings only — no inference.' },
      // ── Connection: Mistral ──
      { key: 'base_url', label: 'Base URL', type: 'string', placeholder: 'https://api.mistral.ai/v1', showIf: 'provider=mistral', description: 'Mistral API endpoint.' },
      { key: 'api_key', label: 'API Key', type: 'string', placeholder: 'sk-...', sensitive: true, showIf: 'provider=mistral', description: 'Mistral API key from console.mistral.ai. Or set MISTRAL_API_KEY env var.' },
      // ── Connection: Groq ──
      { key: 'base_url', label: 'Base URL', type: 'string', placeholder: 'https://api.groq.com/openai/v1', showIf: 'provider=groq', description: 'Groq API endpoint.' },
      { key: 'api_key', label: 'API Key', type: 'string', placeholder: 'gsk_...', sensitive: true, showIf: 'provider=groq', description: 'Groq API key from console.groq.com. Or set GROQ_API_KEY env var.' },
      // ── Connection: Together ──
      { key: 'base_url', label: 'Base URL', type: 'string', placeholder: 'https://api.together.xyz/v1', showIf: 'provider=together', description: 'Together AI API endpoint.' },
      { key: 'api_key', label: 'API Key', type: 'string', placeholder: 'sk-...', sensitive: true, showIf: 'provider=together', description: 'Together API key from api.together.ai. Or set TOGETHER_API_KEY env var.' },
      // ── Connection: DeepSeek ──
      { key: 'base_url', label: 'Base URL', type: 'string', placeholder: 'https://api.deepseek.com/v1', showIf: 'provider=deepseek', description: 'DeepSeek API endpoint.' },
      { key: 'api_key', label: 'API Key', type: 'string', placeholder: 'sk-...', sensitive: true, showIf: 'provider=deepseek', description: 'DeepSeek API key from platform.deepseek.com. Or set DEEPSEEK_API_KEY env var.' },
      // ── Connection: xAI ──
      { key: 'base_url', label: 'Base URL', type: 'string', placeholder: 'https://api.x.ai/v1', showIf: 'provider=xai', description: 'xAI (Grok) API endpoint.' },
      { key: 'api_key', label: 'API Key', type: 'string', placeholder: 'xai-...', sensitive: true, showIf: 'provider=xai', description: 'xAI API key from console.x.ai. Or set XAI_API_KEY env var.' },

      // ── Model fields: Ollama ──
      { key: 'inference_model', label: 'Inference model', type: 'model-select', placeholder: 'llama3.2', showIf: 'provider=ollama', description: 'LLM for summarization and intent classification.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'fast_model', label: 'Fast model', type: 'model-select', placeholder: 'llama3.2', showIf: 'provider=ollama', description: 'Smaller/faster LLM for low-latency tasks. Falls back to inference model.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'embedding_model', label: 'Embedding model', type: 'model-select', placeholder: 'nomic-embed-text', showIf: 'provider=ollama', description: 'Embedding model for semantic search. Must match embedding_dimensions.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'reranker_model', label: 'Reranker model', type: 'model-select', placeholder: 'bge-reranker-v2-m3', showIf: 'provider=ollama', description: 'Cross-encoder for re-ranking search results.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      // ── Model fields: LM Studio ──
      { key: 'inference_model', label: 'Inference model', type: 'model-select', placeholder: 'qwen2.5-coder-7b-instruct', showIf: 'provider=lmstudio', description: 'LLM loaded in LM Studio.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'fast_model', label: 'Fast model', type: 'model-select', placeholder: 'qwen2.5-coder-7b-instruct', showIf: 'provider=lmstudio', description: 'Fast LLM for low-latency tasks.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'embedding_model', label: 'Embedding model', type: 'model-select', placeholder: 'nomic-embed-text-v1.5', showIf: 'provider=lmstudio', description: 'Embedding model loaded in LM Studio.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      // ── Model fields: OpenAI ──
      { key: 'inference_model', label: 'Inference model', type: 'model-select', placeholder: 'gpt-4o-mini', showIf: 'provider=openai', description: 'LLM for summarization and intent classification.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'fast_model', label: 'Fast model', type: 'model-select', placeholder: 'gpt-4o-mini', showIf: 'provider=openai', description: 'Faster/cheaper LLM. Falls back to inference model.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'embedding_model', label: 'Embedding model', type: 'model-select', placeholder: 'text-embedding-3-small', showIf: 'provider=openai', description: 'text-embedding-3-small (cheap) or text-embedding-3-large (accurate).', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      // ── Model fields: Anthropic (inference only — no embeddings API) ──
      { key: 'inference_model', label: 'Inference model', type: 'model-select', placeholder: 'claude-sonnet-4-6', showIf: 'provider=anthropic', description: 'Claude model for summarization and reasoning.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'fast_model', label: 'Fast model', type: 'model-select', placeholder: 'claude-haiku-4-5-20251001', showIf: 'provider=anthropic', description: 'Fastest Claude model for low-latency tasks.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      // ── Model fields: Gemini ──
      { key: 'inference_model', label: 'Inference model', type: 'model-select', placeholder: 'gemini-2.5-flash', showIf: 'provider=gemini', description: 'Gemini model for summarization.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'fast_model', label: 'Fast model', type: 'model-select', placeholder: 'gemini-2.5-flash', showIf: 'provider=gemini', description: 'Fast Gemini model for low-latency tasks.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'embedding_model', label: 'Embedding model', type: 'model-select', placeholder: 'text-embedding-004', showIf: 'provider=gemini', description: 'Gemini embedding model. text-embedding-004 (768d) is recommended.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      // ── Model fields: Vertex AI ──
      { key: 'inference_model', label: 'Inference model', type: 'string', placeholder: 'gemini-2.5-flash', showIf: 'provider=vertex', description: 'Vertex-hosted model for summarization (e.g. gemini-2.5-flash, gemini-2.5-pro).' },
      { key: 'fast_model', label: 'Fast model', type: 'string', placeholder: 'gemini-2.5-flash', showIf: 'provider=vertex', description: 'Fast Vertex model for low-latency tasks.' },
      { key: 'embedding_model', label: 'Embedding model', type: 'string', placeholder: 'text-embedding-005', showIf: 'provider=vertex', description: 'Vertex embedding model (e.g. text-embedding-005 768d, gemini-embedding-001 3072d).' },
      // ── Model fields: Voyage ──
      { key: 'embedding_model', label: 'Embedding model', type: 'string', placeholder: 'voyage-code-3', showIf: 'provider=voyage', description: 'Voyage embedding model. voyage-code-3 (1024d) is tuned for source code.' },
      // ── Model fields: Mistral ──
      { key: 'inference_model', label: 'Inference model', type: 'model-select', placeholder: 'mistral-small-latest', showIf: 'provider=mistral', description: 'Mistral LLM for summarization.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'fast_model', label: 'Fast model', type: 'model-select', placeholder: 'mistral-small-latest', showIf: 'provider=mistral', description: 'Fast Mistral model.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'embedding_model', label: 'Embedding model', type: 'model-select', placeholder: 'mistral-embed', showIf: 'provider=mistral', description: 'Mistral embedding model (1024d).', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      // ── Model fields: Groq ──
      { key: 'inference_model', label: 'Inference model', type: 'model-select', placeholder: 'llama-3.3-70b-versatile', showIf: 'provider=groq', description: 'Groq-hosted LLM. Ultra-fast inference.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'fast_model', label: 'Fast model', type: 'model-select', placeholder: 'llama-3.1-8b-instant', showIf: 'provider=groq', description: 'Fastest Groq model for low-latency tasks.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'embedding_model', label: 'Embedding model', type: 'model-select', placeholder: 'nomic-embed-text-v1.5', showIf: 'provider=groq', description: 'Groq embedding model.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      // ── Model fields: Together ──
      { key: 'inference_model', label: 'Inference model', type: 'model-select', placeholder: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', showIf: 'provider=together', description: 'Together-hosted LLM.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'fast_model', label: 'Fast model', type: 'model-select', placeholder: 'meta-llama/Llama-3.1-8B-Instruct-Turbo', showIf: 'provider=together', description: 'Fast Together model.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'embedding_model', label: 'Embedding model', type: 'model-select', placeholder: 'togethercomputer/m2-bert-80M-8k-retrieval', showIf: 'provider=together', description: 'Together embedding model.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      // ── Model fields: DeepSeek ──
      { key: 'inference_model', label: 'Inference model', type: 'model-select', placeholder: 'deepseek-chat', showIf: 'provider=deepseek', description: 'DeepSeek V3 for summarization and reasoning.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'fast_model', label: 'Fast model', type: 'model-select', placeholder: 'deepseek-chat', showIf: 'provider=deepseek', description: 'DeepSeek fast model.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      // ── Model fields: xAI ──
      { key: 'inference_model', label: 'Inference model', type: 'model-select', placeholder: 'grok-4', showIf: 'provider=xai', description: 'Grok model for summarization.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      { key: 'fast_model', label: 'Fast model', type: 'model-select', placeholder: 'grok-4', showIf: 'provider=xai', description: 'Fast Grok model.', modelProvider: 'provider', modelBaseUrlField: 'base_url' },
      // ── Model fields: ONNX ──
      { key: 'embedding_model', label: 'Embedding model', type: 'string', placeholder: 'Xenova/all-MiniLM-L6-v2', showIf: 'provider=onnx', description: 'ONNX model for local embeddings. Default works out of the box.' },

      // ── Common fields ──
      { key: 'embedding_dimensions', label: 'Embedding dimensions', type: 'number', placeholder: '384', min: 1, showIf: 'enabled', description: 'Vector size. Must match the model (384 for MiniLM, 768 for nomic/Gemini/Vertex text-embedding-005, 1024 for Mistral/voyage-code-3, 1536 for OpenAI, 3072 for gemini-embedding-001).' },
      { key: 'summarize_on_index', label: 'Summarize on index', type: 'boolean', defaultValue: false, showIf: 'enabled', description: 'Generate natural-language summaries during indexing. Requires a provider with inference model.' },
      { key: 'summarize_batch_size', label: 'Summarize batch size', type: 'number', placeholder: '20', min: 1, defaultValue: 20, showIf: 'summarize_on_index', description: 'Symbols to summarize in parallel per batch.' },
      { key: 'summarize_kinds', label: 'Summarize kinds', type: 'multiselect', options: ['class', 'function', 'method', 'interface', 'trait', 'enum', 'type', 'variable', 'constant', 'property', 'module', 'namespace'], defaultValue: ['class', 'function', 'method', 'interface', 'trait', 'enum', 'type'], showIf: 'summarize_on_index', description: 'Which symbol kinds to generate summaries for.' },
      { key: 'concurrency', label: 'Concurrency', type: 'number', placeholder: '1', min: 1, max: 32, defaultValue: 1, showIf: 'enabled', description: 'Parallel AI requests. For Ollama, match OLLAMA_NUM_PARALLEL.' },
    ],
  },
  {
    key: 'security',
    label: 'Security',
    icon: '🔒',
    description: 'Secret detection and file limits',
    fields: [
      { key: 'secret_patterns', label: 'Secret patterns', type: 'array', placeholder: 'regex patterns' },
      { key: 'max_file_size_bytes', label: 'Max file size (bytes)', type: 'number', placeholder: '1048576', min: 1024, defaultValue: 1048576 },
      { key: 'max_files', label: 'Max files per project', type: 'number', placeholder: '10000', min: 1, defaultValue: 10000 },
    ],
  },
  {
    key: 'predictive',
    label: 'Predictive Analysis',
    icon: '📊',
    description: 'Bug prediction, tech debt scoring, change risk',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: true },
      { key: 'cache_ttl_minutes', label: 'Cache TTL (minutes)', type: 'number', placeholder: '60', min: 1, defaultValue: 60, showIf: 'enabled' },
      { key: 'git_since_days', label: 'Git history (days)', type: 'number', placeholder: '180', min: 1, defaultValue: 180, showIf: 'enabled' },
      { key: 'module_depth', label: 'Module depth', type: 'number', placeholder: '2', min: 1, max: 10, defaultValue: 2, showIf: 'enabled' },
      { key: 'weights', label: 'Weights', type: 'json', description: 'Bug/debt/risk scoring weights', showIf: 'enabled' },
    ],
  },
  {
    key: 'intent',
    label: 'Intent / Domains',
    icon: '🏷️',
    description: 'Domain classification and auto-tagging',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: false },
      { key: 'auto_classify_on_index', label: 'Auto-classify on index', type: 'boolean', defaultValue: true, showIf: 'enabled' },
      { key: 'classify_batch_size', label: 'Batch size', type: 'number', placeholder: '100', min: 1, defaultValue: 100, showIf: 'enabled' },
      { key: 'domain_hints', label: 'Domain hints', type: 'json', description: '{ "domain": ["path/**"] }', showIf: 'enabled' },
      { key: 'custom_domains', label: 'Custom domains', type: 'json', description: '[{ name, path_patterns }]', showIf: 'enabled' },
    ],
  },
  {
    key: 'runtime',
    label: 'Runtime Tracing (OTLP)',
    icon: '📡',
    description: 'OpenTelemetry span ingestion and trace analysis',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: false },
      { key: 'port', label: 'OTLP port', type: 'number', placeholder: '4318', nested: 'otlp', min: 1, max: 65535, defaultValue: 4318, showIf: 'enabled' },
      { key: 'host', label: 'OTLP host', type: 'string', placeholder: '127.0.0.1', nested: 'otlp', defaultValue: '127.0.0.1', showIf: 'enabled' },
      { key: 'max_body_bytes', label: 'Max body bytes', type: 'number', placeholder: '4194304', nested: 'otlp', min: 1024, defaultValue: 4194304, showIf: 'enabled' },
      { key: 'max_span_age_days', label: 'Max span age (days)', type: 'number', placeholder: '7', nested: 'retention', min: 1, defaultValue: 7, showIf: 'enabled' },
      { key: 'max_aggregate_age_days', label: 'Max aggregate age (days)', type: 'number', placeholder: '90', nested: 'retention', min: 1, defaultValue: 90, showIf: 'enabled' },
      { key: 'prune_interval', label: 'Prune interval', type: 'number', placeholder: '100', nested: 'retention', min: 1, defaultValue: 100, showIf: 'enabled' },
      { key: 'fqn_attributes', label: 'FQN attributes', type: 'array', placeholder: 'code.function, code.namespace, ...', nested: 'mapping', showIf: 'enabled' },
      { key: 'route_patterns', label: 'Route patterns', type: 'array', placeholder: 'regex patterns', nested: 'mapping', showIf: 'enabled' },
    ],
  },
  {
    key: 'topology',
    label: 'Cross-repo Topology',
    icon: '🔗',
    description: 'Subprojects and cross-service dependency tracking',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: true },
      { key: 'auto_detect', label: 'Auto-detect repos', type: 'boolean', defaultValue: true, showIf: 'enabled' },
      { key: 'auto_discover', label: 'Auto-discover subprojects', type: 'boolean', defaultValue: true, showIf: 'enabled' },
      { key: 'repos', label: 'Extra repo paths', type: 'array', placeholder: '/path/to/repo', showIf: 'enabled' },
      { key: 'contract_globs', label: 'Contract globs', type: 'array', placeholder: '**/*.proto, **/*.graphql', showIf: 'enabled' },
    ],
  },
  {
    key: 'lsp',
    label: 'LSP Enrichment',
    icon: '🔬',
    description: 'Compiler-grade call graph resolution via Language Server Protocol',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: false, description: 'Enable LSP enrichment pass after indexing' },
      { key: 'auto_detect', label: 'Auto-detect servers', type: 'boolean', defaultValue: true, showIf: 'enabled', description: 'Auto-detect available LSP servers (tsserver, pyright, gopls, rust-analyzer)' },
      { key: 'max_concurrent_servers', label: 'Max concurrent servers', type: 'number', placeholder: '2', min: 1, max: 4, defaultValue: 2, showIf: 'enabled', description: 'Limit parallel LSP server processes' },
      { key: 'enrichment_timeout_ms', label: 'Enrichment timeout (ms)', type: 'number', placeholder: '120000', min: 5000, max: 600000, defaultValue: 120000, showIf: 'enabled', description: 'Overall timeout for the LSP enrichment pass' },
      { key: 'batch_size', label: 'Batch size', type: 'number', placeholder: '100', min: 10, max: 1000, defaultValue: 100, showIf: 'enabled', description: 'Symbols processed per batch' },
      { key: 'servers', label: 'Server overrides', type: 'json', showIf: 'enabled', description: '{ "typescript": { "command": "npx", "args": ["typescript-language-server", "--stdio"], "timeout_ms": 30000 } }' },
    ],
  },
  {
    key: 'quality_gates',
    label: 'Quality Gates',
    icon: '✅',
    description: 'Automated quality checks on commits and PRs',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: true },
      { key: 'fail_on', label: 'Fail on', type: 'select', options: ['error', 'warning', 'none'], defaultValue: 'error', showIf: 'enabled' },
      { key: 'rules', label: 'Rules', type: 'json', description: 'Rule thresholds and severities', showIf: 'enabled' },
    ],
  },
  {
    key: 'tools',
    label: 'Tool Exposure',
    icon: '🔧',
    description: 'Control which MCP tools are exposed and how',
    fields: [
      { key: 'preset', label: 'Preset', type: 'select', options: ['full', 'minimal'], defaultValue: 'full' },
      { key: 'include', label: 'Include tools', type: 'array', placeholder: 'tool_name' },
      { key: 'exclude', label: 'Exclude tools', type: 'array', placeholder: 'tool_name' },
      { key: 'description_verbosity', label: 'Description verbosity', type: 'select', options: ['full', 'minimal', 'none'], defaultValue: 'full' },
      { key: 'instructions_verbosity', label: 'Instructions verbosity', type: 'select', options: ['full', 'minimal', 'none'], defaultValue: 'full' },
      { key: 'meta_fields', label: 'Meta fields', type: 'boolean', defaultValue: true },
      { key: 'compact_schemas', label: 'Compact schemas', type: 'boolean', defaultValue: false, description: 'Strip advanced parameters from tool schemas to reduce token overhead (~40-60%)' },
      { key: 'descriptions', label: 'Custom descriptions', type: 'json', description: '{ "tool_name": "description" }' },
    ],
  },
  {
    key: 'ignore',
    label: 'Ignore Rules',
    icon: '🚫',
    description: 'Extra directories and patterns to skip during indexing',
    fields: [
      { key: 'directories', label: 'Directories', type: 'array', placeholder: 'node_modules, .git, ...' },
      { key: 'patterns', label: 'Patterns', type: 'array', placeholder: '*.min.js, dist/**, ...' },
    ],
  },
  {
    key: 'frameworks',
    label: 'Frameworks',
    icon: '⚙️',
    description: 'Framework-specific settings (Laravel, etc.)',
    fields: [
      { key: 'frameworks', label: 'Configuration', type: 'json', description: 'Framework overrides' },
    ],
  },
  {
    key: 'logging',
    label: 'Logging',
    icon: '📝',
    description: 'File logging and rotation',
    fields: [
      { key: 'file', label: 'Enable file logging', type: 'boolean', defaultValue: false },
      { key: 'path', label: 'Log file path', type: 'string', placeholder: '~/.trace-mcp/run.log', defaultValue: '~/.trace-mcp/run.log', showIf: 'file' },
      { key: 'level', label: 'Log level', type: 'select', options: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], defaultValue: 'info' },
      { key: 'max_size_mb', label: 'Max log size (MB)', type: 'number', placeholder: '10', min: 1, defaultValue: 10, showIf: 'file' },
    ],
  },
  {
    key: 'watch',
    label: 'File Watcher',
    icon: '👁️',
    description: 'Auto-reindex on file changes',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: true },
      { key: 'debounceMs', label: 'Debounce (ms)', type: 'number', placeholder: '2000', min: 100, max: 30000, defaultValue: 2000, showIf: 'enabled' },
    ],
  },
];
