/**
 * Schema describing all ~/.trace-mcp/.config.json sections.
 * Drives the Settings UI — each section is a collapsible group,
 * each field renders the appropriate control.
 */

export type FieldType = 'boolean' | 'string' | 'number' | 'select' | 'array' | 'json';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];           // for 'select' type
  placeholder?: string;
  description?: string;
  sensitive?: boolean;          // mask value (api keys)
  nested?: string;              // dot-path parent, e.g. "otlp" for runtime.otlp.port
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
    case 'array':
      if (!Array.isArray(value)) return 'Must be a list';
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
      { key: 'provider', label: 'Provider', type: 'select', options: ['onnx', 'ollama', 'openai'], defaultValue: 'onnx', showIf: 'enabled', description: 'onnx = local embeddings (zero-config, no API key)' },
      { key: 'base_url', label: 'Base URL', type: 'string', placeholder: 'http://localhost:11434', showIf: 'provider=ollama', description: 'Custom endpoint for ollama/openai' },
      { key: 'api_key', label: 'API Key', type: 'string', placeholder: 'sk-...', sensitive: true, showIf: 'provider=openai', description: 'Required for OpenAI; or set OPENAI_API_KEY env' },
      { key: 'inference_model', label: 'Inference model', type: 'string', placeholder: 'gemma4-e4b', showIf: 'provider=ollama', description: 'Not available with onnx provider' },
      { key: 'fast_model', label: 'Fast model', type: 'string', placeholder: 'gemma4-e4b', showIf: 'provider=ollama', description: 'Not available with onnx provider' },
      { key: 'embedding_model', label: 'Embedding model', type: 'string', placeholder: 'Xenova/all-MiniLM-L6-v2', showIf: 'enabled' },
      { key: 'embedding_dimensions', label: 'Embedding dimensions', type: 'number', placeholder: '384', min: 1, showIf: 'enabled' },
      { key: 'summarize_on_index', label: 'Summarize on index', type: 'boolean', defaultValue: false, showIf: 'enabled', description: 'Requires ollama/openai provider with LLM model' },
      { key: 'summarize_batch_size', label: 'Summarize batch size', type: 'number', placeholder: '20', min: 1, defaultValue: 20, showIf: 'enabled' },
      { key: 'summarize_kinds', label: 'Summarize kinds', type: 'array', placeholder: 'class, function, method, ...', defaultValue: ['class', 'function', 'method', 'interface', 'trait', 'enum', 'type'], showIf: 'enabled' },
      { key: 'concurrency', label: 'Concurrency', type: 'number', placeholder: '1', min: 1, max: 32, defaultValue: 1, showIf: 'enabled', description: 'Match OLLAMA_NUM_PARALLEL for ollama' },
      { key: 'reranker_model', label: 'Reranker model', type: 'string', placeholder: 'bge-reranker-v2-m3', showIf: 'enabled' },
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
