/**
 * Schema describing all ~/.trace-mcp/.config.json sections.
 * Drives the Settings UI — each section is a collapsible group,
 * each field renders the appropriate control.
 *
 * `label` and `description` hold catalogue KEYS, not prose (TRA-383). They are
 * resolved with `t()` at render time, never here: this module is evaluated once
 * at import, and a string captured then never sees a language switch.
 */
import { t } from '../i18n';

export type FieldType =
  | 'boolean'
  | 'string'
  | 'number'
  | 'select'
  | 'array'
  | 'json'
  | 'multiselect'
  | 'model-select';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[]; // for 'select' and 'multiselect' types
  placeholder?: string;
  description?: string;
  sensitive?: boolean; // mask value (api keys)
  nested?: string; // dot-path parent, e.g. "otlp" for runtime.otlp.port
  /** For 'model-select': which provider field to read to determine the model source.
   *  The value of that field determines which API to call (ollama / openai). */
  modelProvider?: string;
  /** For 'model-select': which field holds the base URL for the provider. */
  modelBaseUrlField?: string;
  min?: number; // for 'number' type
  max?: number; // for 'number' type
  pattern?: string; // regex for 'string' type
  defaultValue?: unknown; // default value for reset
  /** Show this field only when another field in the same section matches a value.
   *  Format: "field_key" (truthy check) or "field_key=value" (exact match). */
  showIf?: string;
}

export interface SectionDef {
  key: string;
  label: string;
  description?: string;
  fields: FieldDef[];
}

// ── Validation ─────────────────────────────────────────────────────────

/** Validate a field value against its schema definition. Returns error message or null. */
export function validateField(field: FieldDef, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;

  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return t('settings:validate.boolean');
      break;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('settings:validate.number');
      if (field.min != null && value < field.min) return t('settings:validate.min', { min: field.min });
      if (field.max != null && value > field.max) return t('settings:validate.max', { max: field.max });
      break;
    }
    case 'string': {
      if (typeof value !== 'string') return t('settings:validate.string');
      if (field.pattern) {
        // ReDoS guard: cap input length before regexing. These fields hold
        // short config values (paths, URLs, ids); nothing legitimate needs
        // more than this, and it bounds worst-case backtracking cost
        // regardless of how the field's pattern is authored.
        const MAX_PATTERN_INPUT_LENGTH = 500;
        if (value.length > MAX_PATTERN_INPUT_LENGTH) return t('settings:validate.tooLong', { max: MAX_PATTERN_INPUT_LENGTH });
        try {
          if (!new RegExp(field.pattern).test(value)) return t('settings:validate.pattern', { pattern: field.pattern }); // nosemgrep: ajinabraham.njsscan.dos.regex_injection.regex_injection_dos -- field.pattern is authored in this file's static schema, not user input; the length cap above bounds worst-case cost on the user-controlled value being tested.
        } catch {
          /* invalid pattern, skip */
        }
      }
      break;
    }
    case 'select':
      if (field.options && !field.options.includes(value as string)) {
        return t('settings:validate.oneOf', { options: field.options.join(', ') });
      }
      break;
    case 'multiselect':
    case 'array':
      if (!Array.isArray(value)) return t('settings:validate.list');
      break;
    case 'model-select':
      if (typeof value !== 'string') return t('settings:validate.string');
      break;
    case 'json':
      if (typeof value === 'string') return t('settings:validate.json');
      break;
  }
  return null;
}

/** Validate an entire section. Returns map of field keys to error messages. */
export function validateSection(
  section: SectionDef,
  data: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of section.fields) {
    let value: unknown;
    if (field.nested) {
      const parent = data[field.nested];
      value =
        parent && typeof parent === 'object'
          ? (parent as Record<string, unknown>)[field.key]
          : undefined;
    } else if (section.key === 'frameworks' && field.key === 'frameworks') {
      value = data;
    } else {
      value = data[field.key];
    }
    const err = validateField(field, value);
    if (err) errors[`${field.nested ? `${field.nested}.` : ''}${field.key}`] = err;
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
      value =
        parent && typeof parent === 'object'
          ? (parent as Record<string, unknown>)[f.key]
          : undefined;
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
    }
    /* An absent key is NOT "cleared" — the daemon applies the default when the
       key is missing, so undefined IS the default and counting it as modified
       marked almost every section. That was survivable while the signal was an
       unexplained 7px dot; the row now says the word "Modified", and the word
       has to be true (TRA-295). */
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
    const serverSection =
      section.key === '_root'
        ? serverConfig
        : ((serverConfig[section.key] as Record<string, unknown>) ?? {});
    const localSection =
      section.key === '_root'
        ? localConfig
        : ((localConfig[section.key] as Record<string, unknown>) ?? {});

    for (const field of section.fields) {
      let fromVal: unknown;
      let toVal: unknown;

      if (section.key === '_root') {
        fromVal = (serverSection as Record<string, unknown>)[field.key];
        toVal = (localSection as Record<string, unknown>)[field.key];
      } else if (field.nested) {
        const sp = (serverSection as Record<string, unknown>)?.[field.nested];
        const lp = (localSection as Record<string, unknown>)?.[field.nested];
        fromVal =
          sp && typeof sp === 'object' ? (sp as Record<string, unknown>)[field.key] : undefined;
        toVal =
          lp && typeof lp === 'object' ? (lp as Record<string, unknown>)[field.key] : undefined;
      } else {
        fromVal = (serverSection as Record<string, unknown>)?.[field.key];
        toVal = (localSection as Record<string, unknown>)?.[field.key];
      }

      if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
        entries.push({
          /* Resolved here, not stored: DiffEntry renders as-is and the schema
             carries catalogue keys. computeDiff runs on every render, so this
             follows a language switch. */
          section: t(section.label),
          field: field.nested ? `${field.nested}.${t(field.label)}` : t(field.label),
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
    label: 'settings:schema._root.label',
    description: 'settings:schema._root.description',
    fields: [
      {
        key: 'auto_update',
        label: 'settings:schema._root.auto_update.label',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'auto_update_check_interval_hours',
        label: 'settings:schema._root.interval.label',
        type: 'number',
        placeholder: '24',
        min: 1,
        defaultValue: 24,
        showIf: 'auto_update',
      },
      {
        key: 'logLevel',
        label: 'settings:schema._root.logLevel.label',
        type: 'select',
        options: ['debug', 'info', 'warn', 'error'],
        defaultValue: 'info',
      },
    ],
  },
  {
    key: 'ai',
    label: 'settings:schema.ai.label',
    description: 'settings:schema.ai.description',
    fields: [
      { key: 'enabled', label: 'settings:schema.f.enabled', type: 'boolean', defaultValue: false },
      {
        key: 'provider',
        label: 'settings:schema.ai.provider.label',
        type: 'select',
        options: [
          'onnx',
          'ollama',
          'lmstudio',
          'openai',
          'anthropic',
          'gemini',
          'vertex',
          'voyage',
          'mistral',
          'groq',
          'together',
          'deepseek',
          'xai',
        ],
        defaultValue: 'onnx',
        showIf: 'enabled',
        description: 'settings:schema.ai.provider.description',
      },

      // ── Per-capability enable flags ──
      // Lets users run embeddings without inference (or vice versa) without switching provider.
      // Disabled capabilities short-circuit to no-op services; no other code changes required.
      {
        key: 'embedding',
        label: 'settings:schema.ai.embedding.label',
        type: 'boolean',
        nested: 'features',
        defaultValue: true,
        showIf: 'enabled',
        description: 'settings:schema.ai.embedding.description',
      },
      {
        key: 'inference',
        label: 'settings:schema.ai.inference.label',
        type: 'boolean',
        nested: 'features',
        defaultValue: true,
        showIf: 'enabled',
        description: 'settings:schema.ai.inference.description',
      },
      {
        key: 'fast_inference',
        label: 'settings:schema.ai.fast_inference.label',
        type: 'boolean',
        nested: 'features',
        defaultValue: true,
        showIf: 'enabled',
        description: 'settings:schema.ai.fast_inference.description',
      },

      // ── Connection: Ollama ──
      {
        key: 'base_url',
        label: 'settings:schema.f.baseUrl',
        type: 'string',
        placeholder: 'http://localhost:11434',
        showIf: 'provider=ollama',
        description: 'settings:schema.ai.ollama.base_url.description',
      },
      // ── Connection: LM Studio ──
      {
        key: 'base_url',
        label: 'settings:schema.f.baseUrl',
        type: 'string',
        placeholder: 'http://localhost:1234/v1',
        showIf: 'provider=lmstudio',
        description: 'settings:schema.ai.lmstudio.base_url.description',
      },
      // ── Connection: OpenAI ──
      {
        key: 'base_url',
        label: 'settings:schema.f.baseUrl',
        type: 'string',
        placeholder: 'https://api.openai.com',
        showIf: 'provider=openai',
        description: 'settings:schema.ai.openai.base_url.description',
      },
      {
        key: 'api_key',
        label: 'settings:schema.f.apiKey',
        type: 'string',
        placeholder: 'sk-...',
        sensitive: true,
        showIf: 'provider=openai',
        description: 'settings:schema.ai.openai.api_key.description',
      },
      // ── Connection: Anthropic ──
      {
        key: 'api_key',
        label: 'settings:schema.f.apiKey',
        type: 'string',
        placeholder: 'sk-ant-...',
        sensitive: true,
        showIf: 'provider=anthropic',
        description: 'settings:schema.ai.anthropic.api_key.description',
      },
      // ── Connection: Gemini (Google Generative Language API — consumer endpoint) ──
      {
        key: 'api_key',
        label: 'settings:schema.f.apiKey',
        type: 'string',
        placeholder: 'AIza...',
        sensitive: true,
        showIf: 'provider=gemini',
        description: 'settings:schema.ai.gemini.api_key.description',
      },
      // ── Connection: Vertex AI (Google Cloud) ──
      {
        key: 'api_key',
        label: 'settings:schema.ai.vertex.api_key.label',
        type: 'string',
        placeholder: 'ya29....',
        sensitive: true,
        showIf: 'provider=vertex',
        description: 'settings:schema.ai.vertex.api_key.description',
      },
      {
        key: 'vertex_project',
        label: 'settings:schema.ai.vertex.project.label',
        type: 'string',
        placeholder: 'my-gcp-project',
        showIf: 'provider=vertex',
        description: 'settings:schema.ai.vertex.project.description',
      },
      {
        key: 'vertex_location',
        label: 'settings:schema.ai.vertex.location.label',
        type: 'string',
        placeholder: 'us-central1',
        defaultValue: 'us-central1',
        showIf: 'provider=vertex',
        description: 'settings:schema.ai.vertex.location.description',
      },
      // ── Connection: Voyage ──
      {
        key: 'base_url',
        label: 'settings:schema.f.baseUrl',
        type: 'string',
        placeholder: 'https://api.voyageai.com/v1',
        showIf: 'provider=voyage',
        description: 'settings:schema.ai.voyage.base_url.description',
      },
      {
        key: 'api_key',
        label: 'settings:schema.f.apiKey',
        type: 'string',
        placeholder: 'pa-...',
        sensitive: true,
        showIf: 'provider=voyage',
        description: 'settings:schema.ai.voyage.api_key.description',
      },
      // ── Connection: Mistral ──
      {
        key: 'base_url',
        label: 'settings:schema.f.baseUrl',
        type: 'string',
        placeholder: 'https://api.mistral.ai/v1',
        showIf: 'provider=mistral',
        description: 'settings:schema.ai.mistral.base_url.description',
      },
      {
        key: 'api_key',
        label: 'settings:schema.f.apiKey',
        type: 'string',
        placeholder: 'sk-...',
        sensitive: true,
        showIf: 'provider=mistral',
        description: 'settings:schema.ai.mistral.api_key.description',
      },
      // ── Connection: Groq ──
      {
        key: 'base_url',
        label: 'settings:schema.f.baseUrl',
        type: 'string',
        placeholder: 'https://api.groq.com/openai/v1',
        showIf: 'provider=groq',
        description: 'settings:schema.ai.groq.base_url.description',
      },
      {
        key: 'api_key',
        label: 'settings:schema.f.apiKey',
        type: 'string',
        placeholder: 'gsk_...',
        sensitive: true,
        showIf: 'provider=groq',
        description: 'settings:schema.ai.groq.api_key.description',
      },
      // ── Connection: Together ──
      {
        key: 'base_url',
        label: 'settings:schema.f.baseUrl',
        type: 'string',
        placeholder: 'https://api.together.xyz/v1',
        showIf: 'provider=together',
        description: 'settings:schema.ai.together.base_url.description',
      },
      {
        key: 'api_key',
        label: 'settings:schema.f.apiKey',
        type: 'string',
        placeholder: 'sk-...',
        sensitive: true,
        showIf: 'provider=together',
        description: 'settings:schema.ai.together.api_key.description',
      },
      // ── Connection: DeepSeek ──
      {
        key: 'base_url',
        label: 'settings:schema.f.baseUrl',
        type: 'string',
        placeholder: 'https://api.deepseek.com/v1',
        showIf: 'provider=deepseek',
        description: 'settings:schema.ai.deepseek.base_url.description',
      },
      {
        key: 'api_key',
        label: 'settings:schema.f.apiKey',
        type: 'string',
        placeholder: 'sk-...',
        sensitive: true,
        showIf: 'provider=deepseek',
        description: 'settings:schema.ai.deepseek.api_key.description',
      },
      // ── Connection: xAI ──
      {
        key: 'base_url',
        label: 'settings:schema.f.baseUrl',
        type: 'string',
        placeholder: 'https://api.x.ai/v1',
        showIf: 'provider=xai',
        description: 'settings:schema.ai.xai.base_url.description',
      },
      {
        key: 'api_key',
        label: 'settings:schema.f.apiKey',
        type: 'string',
        placeholder: 'xai-...',
        sensitive: true,
        showIf: 'provider=xai',
        description: 'settings:schema.ai.xai.api_key.description',
      },

      // ── Model fields: Ollama ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'model-select',
        placeholder: 'llama3.2',
        showIf: 'provider=ollama',
        description: 'settings:schema.ai.ollama.inference_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'model-select',
        placeholder: 'llama3.2',
        showIf: 'provider=ollama',
        description: 'settings:schema.ai.ollama.fast_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'embedding_model',
        label: 'settings:schema.f.embeddingModel',
        type: 'model-select',
        placeholder: 'nomic-embed-text',
        showIf: 'provider=ollama',
        description: 'settings:schema.ai.ollama.embedding_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'reranker_model',
        label: 'settings:schema.f.rerankerModel',
        type: 'model-select',
        placeholder: 'bge-reranker-v2-m3',
        showIf: 'provider=ollama',
        description: 'settings:schema.ai.ollama.reranker_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      // ── Model fields: LM Studio ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'model-select',
        placeholder: 'qwen2.5-coder-7b-instruct',
        showIf: 'provider=lmstudio',
        description: 'settings:schema.ai.lmstudio.inference_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'model-select',
        placeholder: 'qwen2.5-coder-7b-instruct',
        showIf: 'provider=lmstudio',
        description: 'settings:schema.ai.lmstudio.fast_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'embedding_model',
        label: 'settings:schema.f.embeddingModel',
        type: 'model-select',
        placeholder: 'nomic-embed-text-v1.5',
        showIf: 'provider=lmstudio',
        description: 'settings:schema.ai.lmstudio.embedding_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      // ── Model fields: OpenAI ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'model-select',
        placeholder: 'gpt-4o-mini',
        showIf: 'provider=openai',
        description: 'settings:schema.ai.openai.inference_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'model-select',
        placeholder: 'gpt-4o-mini',
        showIf: 'provider=openai',
        description: 'settings:schema.ai.openai.fast_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'embedding_model',
        label: 'settings:schema.f.embeddingModel',
        type: 'model-select',
        placeholder: 'text-embedding-3-small',
        showIf: 'provider=openai',
        description: 'settings:schema.ai.openai.embedding_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      // ── Model fields: Anthropic (inference only — no embeddings API) ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'model-select',
        placeholder: 'claude-sonnet-4-6',
        showIf: 'provider=anthropic',
        description: 'settings:schema.ai.anthropic.inference_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'model-select',
        placeholder: 'claude-haiku-4-5-20251001',
        showIf: 'provider=anthropic',
        description: 'settings:schema.ai.anthropic.fast_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      // ── Model fields: Gemini ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'model-select',
        placeholder: 'gemini-2.5-flash',
        showIf: 'provider=gemini',
        description: 'settings:schema.ai.gemini.inference_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'model-select',
        placeholder: 'gemini-2.5-flash',
        showIf: 'provider=gemini',
        description: 'settings:schema.ai.gemini.fast_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'embedding_model',
        label: 'settings:schema.f.embeddingModel',
        type: 'model-select',
        placeholder: 'text-embedding-004',
        showIf: 'provider=gemini',
        description: 'settings:schema.ai.gemini.embedding_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      // ── Model fields: Vertex AI ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'string',
        placeholder: 'gemini-2.5-flash',
        showIf: 'provider=vertex',
        description: 'settings:schema.ai.vertex.inference_model.description',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'string',
        placeholder: 'gemini-2.5-flash',
        showIf: 'provider=vertex',
        description: 'settings:schema.ai.vertex.fast_model.description',
      },
      {
        key: 'embedding_model',
        label: 'settings:schema.f.embeddingModel',
        type: 'string',
        placeholder: 'text-embedding-005',
        showIf: 'provider=vertex',
        description: 'settings:schema.ai.vertex.embedding_model.description',
      },
      // ── Model fields: Voyage ──
      {
        key: 'embedding_model',
        label: 'settings:schema.f.embeddingModel',
        type: 'string',
        placeholder: 'voyage-code-3',
        showIf: 'provider=voyage',
        description: 'settings:schema.ai.voyage.embedding_model.description',
      },
      // ── Model fields: Mistral ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'model-select',
        placeholder: 'mistral-small-latest',
        showIf: 'provider=mistral',
        description: 'settings:schema.ai.mistral.inference_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'model-select',
        placeholder: 'mistral-small-latest',
        showIf: 'provider=mistral',
        description: 'settings:schema.ai.mistral.fast_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'embedding_model',
        label: 'settings:schema.f.embeddingModel',
        type: 'model-select',
        placeholder: 'mistral-embed',
        showIf: 'provider=mistral',
        description: 'settings:schema.ai.mistral.embedding_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      // ── Model fields: Groq ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'model-select',
        placeholder: 'llama-3.3-70b-versatile',
        showIf: 'provider=groq',
        description: 'settings:schema.ai.groq.inference_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'model-select',
        placeholder: 'llama-3.1-8b-instant',
        showIf: 'provider=groq',
        description: 'settings:schema.ai.groq.fast_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'embedding_model',
        label: 'settings:schema.f.embeddingModel',
        type: 'model-select',
        placeholder: 'nomic-embed-text-v1.5',
        showIf: 'provider=groq',
        description: 'settings:schema.ai.groq.embedding_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      // ── Model fields: Together ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'model-select',
        placeholder: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        showIf: 'provider=together',
        description: 'settings:schema.ai.together.inference_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'model-select',
        placeholder: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
        showIf: 'provider=together',
        description: 'settings:schema.ai.together.fast_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'embedding_model',
        label: 'settings:schema.f.embeddingModel',
        type: 'model-select',
        placeholder: 'togethercomputer/m2-bert-80M-8k-retrieval',
        showIf: 'provider=together',
        description: 'settings:schema.ai.together.embedding_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      // ── Model fields: DeepSeek ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'model-select',
        placeholder: 'deepseek-chat',
        showIf: 'provider=deepseek',
        description: 'settings:schema.ai.deepseek.inference_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'model-select',
        placeholder: 'deepseek-chat',
        showIf: 'provider=deepseek',
        description: 'settings:schema.ai.deepseek.fast_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      // ── Model fields: xAI ──
      {
        key: 'inference_model',
        label: 'settings:schema.f.inferenceModel',
        type: 'model-select',
        placeholder: 'grok-4',
        showIf: 'provider=xai',
        description: 'settings:schema.ai.xai.inference_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      {
        key: 'fast_model',
        label: 'settings:schema.f.fastModel',
        type: 'model-select',
        placeholder: 'grok-4',
        showIf: 'provider=xai',
        description: 'settings:schema.ai.xai.fast_model.description',
        modelProvider: 'provider',
        modelBaseUrlField: 'base_url',
      },
      // ── Model fields: ONNX ──
      {
        key: 'embedding_model',
        label: 'settings:schema.f.embeddingModel',
        type: 'string',
        placeholder: 'Xenova/all-MiniLM-L6-v2',
        showIf: 'provider=onnx',
        description: 'settings:schema.ai.onnx.embedding_model.description',
      },

      // ── Common fields ──
      {
        key: 'embedding_dimensions',
        label: 'settings:schema.ai.dimensions.label',
        type: 'number',
        placeholder: '384',
        min: 1,
        showIf: 'enabled',
        description: 'settings:schema.ai.dimensions.description',
      },
      {
        key: 'summarize_on_index',
        label: 'settings:schema.ai.summarize.label',
        type: 'boolean',
        defaultValue: false,
        showIf: 'enabled',
        description: 'settings:schema.ai.summarize.description',
      },
      {
        key: 'summarize_batch_size',
        label: 'settings:schema.ai.summarize_batch.label',
        type: 'number',
        placeholder: '20',
        min: 1,
        defaultValue: 20,
        showIf: 'summarize_on_index',
        description: 'settings:schema.ai.summarize_batch.description',
      },
      {
        key: 'summarize_kinds',
        label: 'settings:schema.ai.summarize_kinds.label',
        type: 'multiselect',
        options: [
          'class',
          'function',
          'method',
          'interface',
          'trait',
          'enum',
          'type',
          'variable',
          'constant',
          'property',
          'module',
          'namespace',
        ],
        defaultValue: ['class', 'function', 'method', 'interface', 'trait', 'enum', 'type'],
        showIf: 'summarize_on_index',
        description: 'settings:schema.ai.summarize_kinds.description',
      },
      {
        key: 'concurrency',
        label: 'settings:schema.ai.concurrency.label',
        type: 'number',
        placeholder: '1',
        min: 1,
        max: 32,
        defaultValue: 1,
        showIf: 'enabled',
        description: 'settings:schema.ai.concurrency.description',
      },
    ],
  },
  {
    key: 'security',
    label: 'settings:schema.security.label',
    description: 'settings:schema.security.description',
    fields: [
      {
        key: 'secret_patterns',
        label: 'settings:schema.security.secret_patterns.label',
        type: 'array',
        placeholder: 'regex patterns',
      },
      {
        key: 'max_file_size_bytes',
        label: 'settings:schema.security.max_file_size.label',
        type: 'number',
        placeholder: '1048576',
        min: 1024,
        defaultValue: 1048576,
      },
      {
        key: 'max_files',
        label: 'settings:schema.security.max_files.label',
        type: 'number',
        placeholder: '10000',
        min: 1,
        defaultValue: 10000,
      },
    ],
  },
  {
    key: 'predictive',
    label: 'settings:schema.predictive.label',
    description: 'settings:schema.predictive.description',
    fields: [
      { key: 'enabled', label: 'settings:schema.f.enabled', type: 'boolean', defaultValue: true },
      {
        key: 'cache_ttl_minutes',
        label: 'settings:schema.predictive.cache_ttl.label',
        type: 'number',
        placeholder: '60',
        min: 1,
        defaultValue: 60,
        showIf: 'enabled',
      },
      {
        key: 'git_since_days',
        label: 'settings:schema.predictive.git_since.label',
        type: 'number',
        placeholder: '180',
        min: 1,
        defaultValue: 180,
        showIf: 'enabled',
      },
      {
        key: 'module_depth',
        label: 'settings:schema.predictive.module_depth.label',
        type: 'number',
        placeholder: '2',
        min: 1,
        max: 10,
        defaultValue: 2,
        showIf: 'enabled',
      },
      {
        key: 'weights',
        label: 'settings:schema.predictive.weights.label',
        type: 'json',
        description: 'settings:schema.predictive.weights.description',
        showIf: 'enabled',
      },
    ],
  },
  {
    key: 'intent',
    label: 'settings:schema.intent.label',
    description: 'settings:schema.intent.description',
    fields: [
      { key: 'enabled', label: 'settings:schema.f.enabled', type: 'boolean', defaultValue: false },
      {
        key: 'auto_classify_on_index',
        label: 'settings:schema.intent.auto_classify.label',
        type: 'boolean',
        defaultValue: true,
        showIf: 'enabled',
      },
      {
        key: 'classify_batch_size',
        label: 'settings:schema.f.batchSize',
        type: 'number',
        placeholder: '100',
        min: 1,
        defaultValue: 100,
        showIf: 'enabled',
      },
      {
        key: 'domain_hints',
        label: 'settings:schema.intent.domain_hints.label',
        type: 'json',
        description: 'settings:schema.intent.domain_hints.description',
        showIf: 'enabled',
      },
      {
        key: 'custom_domains',
        label: 'settings:schema.intent.custom_domains.label',
        type: 'json',
        description: 'settings:schema.intent.custom_domains.description',
        showIf: 'enabled',
      },
    ],
  },
  {
    key: 'runtime',
    label: 'settings:schema.runtime.label',
    description: 'settings:schema.runtime.description',
    fields: [
      { key: 'enabled', label: 'settings:schema.f.enabled', type: 'boolean', defaultValue: false },
      {
        key: 'port',
        label: 'settings:schema.runtime.port.label',
        type: 'number',
        placeholder: '4318',
        nested: 'otlp',
        min: 1,
        max: 65535,
        defaultValue: 4318,
        showIf: 'enabled',
      },
      {
        key: 'host',
        label: 'settings:schema.runtime.host.label',
        type: 'string',
        placeholder: '127.0.0.1',
        nested: 'otlp',
        defaultValue: '127.0.0.1',
        showIf: 'enabled',
      },
      {
        key: 'max_body_bytes',
        label: 'settings:schema.runtime.max_body.label',
        type: 'number',
        placeholder: '4194304',
        nested: 'otlp',
        min: 1024,
        defaultValue: 4194304,
        showIf: 'enabled',
      },
      {
        key: 'max_span_age_days',
        label: 'settings:schema.runtime.max_span_age.label',
        type: 'number',
        placeholder: '7',
        nested: 'retention',
        min: 1,
        defaultValue: 7,
        showIf: 'enabled',
      },
      {
        key: 'max_aggregate_age_days',
        label: 'settings:schema.runtime.max_aggregate_age.label',
        type: 'number',
        placeholder: '90',
        nested: 'retention',
        min: 1,
        defaultValue: 90,
        showIf: 'enabled',
      },
      {
        key: 'prune_interval',
        label: 'settings:schema.runtime.prune_interval.label',
        type: 'number',
        placeholder: '100',
        nested: 'retention',
        min: 1,
        defaultValue: 100,
        showIf: 'enabled',
      },
      {
        key: 'fqn_attributes',
        label: 'settings:schema.runtime.fqn_attributes.label',
        type: 'array',
        placeholder: 'code.function, code.namespace, ...',
        nested: 'mapping',
        showIf: 'enabled',
      },
      {
        key: 'route_patterns',
        label: 'settings:schema.runtime.route_patterns.label',
        type: 'array',
        placeholder: 'regex patterns',
        nested: 'mapping',
        showIf: 'enabled',
      },
    ],
  },
  {
    key: 'topology',
    label: 'settings:schema.topology.label',
    description: 'settings:schema.topology.description',
    fields: [
      { key: 'enabled', label: 'settings:schema.f.enabled', type: 'boolean', defaultValue: true },
      {
        key: 'auto_detect',
        label: 'settings:schema.topology.auto_detect.label',
        type: 'boolean',
        defaultValue: true,
        showIf: 'enabled',
      },
      {
        key: 'auto_discover',
        label: 'settings:schema.topology.auto_discover.label',
        type: 'boolean',
        defaultValue: true,
        showIf: 'enabled',
      },
      {
        key: 'repos',
        label: 'settings:schema.topology.repos.label',
        type: 'array',
        placeholder: '/path/to/repo',
        showIf: 'enabled',
      },
      {
        key: 'contract_globs',
        label: 'settings:schema.topology.contract_globs.label',
        type: 'array',
        placeholder: '**/*.proto, **/*.graphql',
        showIf: 'enabled',
      },
    ],
  },
  {
    key: 'lsp',
    label: 'settings:schema.lsp.label',
    description: 'settings:schema.lsp.description',
    fields: [
      {
        key: 'enabled',
        label: 'settings:schema.f.enabled',
        type: 'boolean',
        defaultValue: false,
        description: 'settings:schema.lsp.enabled.description',
      },
      {
        key: 'auto_detect',
        label: 'settings:schema.f.autoDetect',
        type: 'boolean',
        defaultValue: true,
        showIf: 'enabled',
        description: 'settings:schema.lsp.auto_detect.description',
      },
      {
        key: 'max_concurrent_servers',
        label: 'settings:schema.lsp.max_servers.label',
        type: 'number',
        placeholder: '2',
        min: 1,
        max: 4,
        defaultValue: 2,
        showIf: 'enabled',
        description: 'settings:schema.lsp.max_servers.description',
      },
      {
        key: 'enrichment_timeout_ms',
        label: 'settings:schema.lsp.timeout.label',
        type: 'number',
        placeholder: '120000',
        min: 5000,
        max: 600000,
        defaultValue: 120000,
        showIf: 'enabled',
        description: 'settings:schema.lsp.timeout.description',
      },
      {
        key: 'batch_size',
        label: 'settings:schema.f.batchSize',
        type: 'number',
        placeholder: '100',
        min: 10,
        max: 1000,
        defaultValue: 100,
        showIf: 'enabled',
        description: 'settings:schema.lsp.batch_size.description',
      },
      {
        key: 'servers',
        label: 'settings:schema.lsp.servers.label',
        type: 'json',
        showIf: 'enabled',
        description: 'settings:schema.lsp.servers.description',
      },
    ],
  },
  {
    key: 'quality_gates',
    label: 'settings:schema.quality_gates.label',
    description: 'settings:schema.quality_gates.description',
    fields: [
      { key: 'enabled', label: 'settings:schema.f.enabled', type: 'boolean', defaultValue: true },
      {
        key: 'fail_on',
        label: 'settings:schema.quality_gates.fail_on.label',
        type: 'select',
        options: ['error', 'warning', 'none'],
        defaultValue: 'error',
        showIf: 'enabled',
      },
      {
        key: 'rules',
        label: 'settings:schema.quality_gates.rules.label',
        type: 'json',
        description: 'settings:schema.quality_gates.rules.description',
        showIf: 'enabled',
      },
    ],
  },
  {
    key: 'tools',
    label: 'settings:schema.tools.label',
    description: 'settings:schema.tools.description',
    fields: [
      {
        key: 'preset',
        label: 'settings:schema.tools.preset.label',
        type: 'select',
        options: ['full', 'minimal'],
        defaultValue: 'full',
      },
      {
        key: 'include',
        label: 'settings:schema.tools.include.label',
        type: 'array',
        placeholder: 'tool_name',
      },
      {
        key: 'exclude',
        label: 'settings:schema.tools.exclude.label',
        type: 'array',
        placeholder: 'tool_name',
      },
      {
        key: 'description_verbosity',
        label: 'settings:schema.tools.description_verbosity.label',
        type: 'select',
        options: ['full', 'minimal', 'none'],
        defaultValue: 'full',
      },
      {
        key: 'instructions_verbosity',
        label: 'settings:schema.tools.instructions_verbosity.label',
        type: 'select',
        options: ['full', 'minimal', 'none'],
        defaultValue: 'full',
      },
      {
        key: 'meta_fields',
        label: 'settings:schema.tools.meta_fields.label',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'compact_schemas',
        label: 'settings:schema.tools.compact_schemas.label',
        type: 'boolean',
        defaultValue: false,
        description: 'settings:schema.tools.compact_schemas.description',
      },
      {
        key: 'descriptions',
        label: 'settings:schema.tools.descriptions.label',
        type: 'json',
        description: 'settings:schema.tools.descriptions.description',
      },
    ],
  },
  {
    key: 'ignore',
    label: 'settings:schema.ignore.label',
    description: 'settings:schema.ignore.description',
    fields: [
      {
        key: 'directories',
        label: 'settings:schema.ignore.directories.label',
        type: 'array',
        placeholder: 'node_modules, .git, ...',
      },
      {
        key: 'patterns',
        label: 'settings:schema.ignore.patterns.label',
        type: 'array',
        placeholder: '*.min.js, dist/**, ...',
      },
    ],
  },
  {
    key: 'frameworks',
    label: 'settings:schema.frameworks.label',
    description: 'settings:schema.frameworks.description',
    fields: [
      {
        key: 'frameworks',
        label: 'settings:schema.frameworks.config.label',
        type: 'json',
        description: 'settings:schema.frameworks.config.description',
      },
    ],
  },
  {
    key: 'logging',
    label: 'settings:schema.logging.label',
    description: 'settings:schema.logging.description',
    fields: [
      {
        key: 'file',
        label: 'settings:schema.logging.file.label',
        type: 'boolean',
        defaultValue: false,
      },
      {
        key: 'path',
        label: 'settings:schema.logging.path.label',
        type: 'string',
        placeholder: '~/.trace-mcp/run.log',
        defaultValue: '~/.trace-mcp/run.log',
        showIf: 'file',
      },
      {
        key: 'level',
        label: 'settings:schema.logging.level.label',
        type: 'select',
        options: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
        defaultValue: 'info',
      },
      {
        key: 'max_size_mb',
        label: 'settings:schema.logging.max_size.label',
        type: 'number',
        placeholder: '10',
        min: 1,
        defaultValue: 10,
        showIf: 'file',
      },
    ],
  },
  {
    key: 'watch',
    label: 'settings:schema.watch.label',
    description: 'settings:schema.watch.description',
    fields: [
      { key: 'enabled', label: 'settings:schema.f.enabled', type: 'boolean', defaultValue: true },
      {
        key: 'debounceMs',
        label: 'settings:schema.watch.debounce.label',
        type: 'number',
        placeholder: '2000',
        min: 100,
        max: 30000,
        defaultValue: 2000,
        showIf: 'enabled',
      },
    ],
  },
];
