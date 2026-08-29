/* Settings: the menu window's configuration surface and the schema that drives
   it. Wording is unchanged from Settings.tsx / configSchema.ts — this namespace
   moved the strings, it did not rewrite them.

   Keys are flat with dotted names, not nested objects: i18next resolves a
   namespace to one string map, and the parity test compares those maps.

   `schema.*` holds the labels and help text of ~/.trace-mcp/.config.json's
   fields. Flags, paths, model names and environment variables inside those
   sentences stay in English in every language — they are identifiers the user
   types back into a config file, not prose. */

export const settings = {
  /* ── Screen chrome ─────────────────────────────────────────────────── */
  title: 'Settings',
  back: 'Back',
  moreActions: 'More actions',
  search: 'Search settings',
  copyDaemon: 'Copy daemon details',
  editConfigFile: 'Edit config file…',
  noMatches: 'No settings match “{{query}}”.',

  /* ── Groups on the section list ────────────────────────────────────── */
  'group.general': 'General',
  'group.intelligence': 'Intelligence',
  'group.quality': 'Quality and security',
  'group.infrastructure': 'Infrastructure',
  'group.development': 'Development',
  'group.monitoring': 'Monitoring',
  'group.advanced': 'Advanced',

  /* ── Daemon card ───────────────────────────────────────────────────── */
  'daemon.title': 'Daemon',
  'daemon.state': 'Running',
  'daemon.summary': 'Running · port {{port}} · up {{uptime}}',
  'uptime.seconds': '{{value}}s',
  'uptime.minutes': '{{value}}m',
  'uptime.hours': '{{value}}h',
  'uptime.hoursMinutes': '{{hours}}h {{minutes}}m',

  /* ── Appearance (an app preference, not a daemon setting) ──────────── */
  'appearance.title': 'Appearance',
  'appearance.theme': 'Theme',

  /* ── Daemon-down and loading states ────────────────────────────────── */
  'empty.loading': 'Loading settings…',
  'empty.unreadableTitle': "Couldn't read the settings",
  'empty.unreadableBody':
    "The daemon is running but didn't return its configuration. Restarting it usually clears this.",
  'empty.unreachableTitle': 'Daemon not reachable',
  'empty.unreachableBody':
    "Settings live in the daemon's config file, so they can't be read until it is running.",
  'empty.starting': 'Starting…',
  'empty.restart': 'Restart daemon',
  'empty.start': 'Start daemon',

  /* ── Section list ──────────────────────────────────────────────────── */
  modified: 'Modified',
  issues_one: '{{count}} issue',
  issues_other: '{{count}} issues',

  /* ── Section detail ────────────────────────────────────────────────── */
  reset: 'Reset',
  resetSection: 'Reset this section to defaults',
  notSet: 'Not set',
  // The accessible name of a picker row: "Provider: ollama".
  'field.aria': '{{label}}: {{value}}',
  'field.ariaUnset': '{{label}}: not set',
  invalidJson: 'Invalid JSON',

  /* ── Model picker ──────────────────────────────────────────────────── */
  'models.select': 'Select model…',
  'models.filter': 'Filter models',
  'models.loading': 'Loading models…',
  'models.retry': 'Retry',
  'models.none': 'No models found',
  'models.noMatches': 'No matches',
  'models.clear': 'Clear selection',
  'models.type': 'Or type a model name…',
  'models.typeAria': 'Type a model name',
  'models.failed': 'Failed to fetch models',
  'models.httpError': '{{provider}}: {{status}}',
  'models.authError': '{{provider}}: {{status}} (check API key)',

  /* ── Per-project overrides ─────────────────────────────────────────── */
  'projects.title': 'Per-project overrides',
  'projects.intro':
    'Override global settings for specific projects. Values merge on top of the global config.',
  'projects.done': 'Done',
  'projects.edit': 'Edit',
  'projects.remove': 'Remove',
  'projects.apply': 'Apply',
  'projects.add': 'Add',
  'projects.pathAria': 'Project path',
  'projects.overridesAria': 'Overrides for {{path}}',

  /* ── Pending changes and the unsaved-changes bar ───────────────────── */
  'diff.title': 'Pending changes',
  'diff.hide': 'Hide',
  'bar.hasErrors': 'Fix the issues above before saving',
  'bar.saved': 'Saved',
  'bar.saveFailed': "Couldn't save — the daemon rejected the change",
  'bar.unsaved_one': '{{count}} unsaved change',
  'bar.unsaved_other': '{{count}} unsaved changes',
  'bar.hideChanges': 'Hide changes',
  'bar.reviewChanges': 'Review changes',
  'bar.discard': 'Discard',
  'bar.saving': 'Saving…',
  'bar.save': 'Save',

  /* ── AI activity link-out ──────────────────────────────────────────── */
  'activity.title': 'AI activity',
  'activity.armed': 'The next project window you open will land on Activity → AI calls.',
  'activity.idle': 'Recent embed, LLM and rerank requests live in a project window, under Activity.',
  'activity.ready': 'Ready',
  'activity.open': 'Open there next',

  /* ── Field validation (configSchema.ts) ────────────────────────────── */
  'validate.boolean': 'Must be true or false',
  'validate.number': 'Must be a number',
  'validate.min': 'Min: {{min}}',
  'validate.max': 'Max: {{max}}',
  'validate.string': 'Must be a string',
  'validate.tooLong': 'Too long (max {{max}} chars)',
  'validate.pattern': 'Must match: {{pattern}}',
  'validate.oneOf': 'Must be one of: {{options}}',
  'validate.list': 'Must be a list',
  'validate.json': 'Must be valid JSON (not a string)',

  /* ── Schema: sections ──────────────────────────────────────────────── */
  'schema._root.label': 'General',
  'schema._root.description': 'Auto-update and top-level settings',
  'schema.ai.label': 'AI and embeddings',
  'schema.ai.description':
    'AI provider for semantic search, summaries, and intent classification',
  'schema.security.label': 'Security',
  'schema.security.description': 'Secret detection and file limits',
  'schema.predictive.label': 'Predictive analysis',
  'schema.predictive.description': 'Bug prediction, tech debt scoring, change risk',
  'schema.intent.label': 'Intent and domains',
  'schema.intent.description': 'Domain classification and auto-tagging',
  'schema.runtime.label': 'Runtime tracing (OTLP)',
  'schema.runtime.description': 'OpenTelemetry span ingestion and trace analysis',
  'schema.topology.label': 'Cross-repo topology',
  'schema.topology.description': 'Subprojects and cross-service dependency tracking',
  'schema.lsp.label': 'LSP enrichment',
  'schema.lsp.description': 'Compiler-grade call graph resolution via Language Server Protocol',
  'schema.quality_gates.label': 'Quality gates',
  'schema.quality_gates.description': 'Automated quality checks on commits and PRs',
  'schema.tools.label': 'Tool exposure',
  'schema.tools.description': 'Control which MCP tools are exposed and how',
  'schema.ignore.label': 'Ignore rules',
  'schema.ignore.description': 'Extra directories and patterns to skip during indexing',
  'schema.frameworks.label': 'Frameworks',
  'schema.frameworks.description': 'Framework-specific settings (Laravel, etc.)',
  'schema.logging.label': 'Logging',
  'schema.logging.description': 'File logging and rotation',
  'schema.watch.label': 'File watcher',
  'schema.watch.description': 'Auto-reindex on file changes',

  /* ── Schema: field labels reused across sections and providers ─────── */
  'schema.f.enabled': 'Enabled',
  'schema.f.baseUrl': 'Base URL',
  'schema.f.apiKey': 'API key',
  'schema.f.inferenceModel': 'Inference model',
  'schema.f.fastModel': 'Fast model',
  'schema.f.embeddingModel': 'Embedding model',
  'schema.f.rerankerModel': 'Reranker model',
  'schema.f.autoDetect': 'Auto-detect servers',
  'schema.f.batchSize': 'Batch size',

  /* ── Schema: General ───────────────────────────────────────────────── */
  'schema._root.auto_update.label': 'Auto-update',
  'schema._root.interval.label': 'Update check interval (hours)',
  'schema._root.logLevel.label': 'Daemon log level',

  /* ── Schema: AI and embeddings ─────────────────────────────────────── */
  'schema.ai.provider.label': 'Provider',
  'schema.ai.provider.description':
    'onnx = local zero-config. ollama/lmstudio = local with model choice. gemini = Google Generative Language API (consumer, AIza key). vertex = Google Vertex AI (GCP, OAuth bearer token + project/location). voyage = Voyage AI embeddings only. Others = cloud APIs.',
  'schema.ai.embedding.label': 'Use embeddings',
  'schema.ai.embedding.description':
    'Generate vector embeddings for semantic search and reranking. Turn off to disable semantic search while keeping inference.',
  'schema.ai.inference.label': 'Use inference',
  'schema.ai.inference.description':
    'Call the LLM for summarization, intent classification, and Ask. Turn off to skip all LLM calls while keeping embeddings.',
  'schema.ai.fast_inference.label': 'Use fast inference',
  'schema.ai.fast_inference.description':
    'Use the fast model for low-latency tasks. When off, fast-path callers receive empty responses — leave on unless debugging.',

  'schema.ai.ollama.base_url.description':
    'Ollama server endpoint. Change if running on a different host or port.',
  'schema.ai.lmstudio.base_url.description': 'LM Studio local server endpoint.',
  'schema.ai.openai.base_url.description':
    'OpenAI API endpoint. Change for Azure OpenAI or compatible providers.',
  'schema.ai.openai.api_key.description': 'Required. Or set OPENAI_API_KEY env var.',
  'schema.ai.anthropic.api_key.description':
    'Anthropic API key from console.anthropic.com. Or set ANTHROPIC_API_KEY env var.',
  'schema.ai.gemini.api_key.description':
    'Google Generative Language API key from ai.google.dev (starts with AIza). Or set GEMINI_API_KEY env var. For GCP/Vertex use the "vertex" provider instead.',
  'schema.ai.vertex.api_key.label': 'Access token',
  'schema.ai.vertex.api_key.description':
    'OAuth2 bearer token (short-lived, ~1h). Generate via: gcloud auth print-access-token. Or set GOOGLE_ACCESS_TOKEN env var.',
  'schema.ai.vertex.project.label': 'GCP project',
  'schema.ai.vertex.project.description':
    'Google Cloud project ID hosting Vertex AI. Or set GOOGLE_CLOUD_PROJECT env var.',
  'schema.ai.vertex.location.label': 'GCP location',
  'schema.ai.vertex.location.description':
    'Vertex AI region (e.g. us-central1, europe-west4, asia-northeast1). Or set GOOGLE_CLOUD_LOCATION env var.',
  'schema.ai.voyage.base_url.description': 'Voyage AI endpoint. Usually the default.',
  'schema.ai.voyage.api_key.description':
    'Voyage API key from dash.voyageai.com. Or set VOYAGE_API_KEY env var. Embeddings only — no inference.',
  'schema.ai.mistral.base_url.description': 'Mistral API endpoint.',
  'schema.ai.mistral.api_key.description':
    'Mistral API key from console.mistral.ai. Or set MISTRAL_API_KEY env var.',
  'schema.ai.groq.base_url.description': 'Groq API endpoint.',
  'schema.ai.groq.api_key.description': 'Groq API key from console.groq.com. Or set GROQ_API_KEY env var.',
  'schema.ai.together.base_url.description': 'Together AI API endpoint.',
  'schema.ai.together.api_key.description':
    'Together API key from api.together.ai. Or set TOGETHER_API_KEY env var.',
  'schema.ai.deepseek.base_url.description': 'DeepSeek API endpoint.',
  'schema.ai.deepseek.api_key.description':
    'DeepSeek API key from platform.deepseek.com. Or set DEEPSEEK_API_KEY env var.',
  'schema.ai.xai.base_url.description': 'xAI (Grok) API endpoint.',
  'schema.ai.xai.api_key.description': 'xAI API key from console.x.ai. Or set XAI_API_KEY env var.',

  'schema.ai.ollama.inference_model.description': 'LLM for summarization and intent classification.',
  'schema.ai.ollama.fast_model.description':
    'Smaller/faster LLM for low-latency tasks. Falls back to inference model.',
  'schema.ai.ollama.embedding_model.description':
    'Embedding model for semantic search. Must match embedding_dimensions.',
  'schema.ai.ollama.reranker_model.description': 'Cross-encoder for re-ranking search results.',
  'schema.ai.lmstudio.inference_model.description': 'LLM loaded in LM Studio.',
  'schema.ai.lmstudio.fast_model.description': 'Fast LLM for low-latency tasks.',
  'schema.ai.lmstudio.embedding_model.description': 'Embedding model loaded in LM Studio.',
  'schema.ai.openai.inference_model.description': 'LLM for summarization and intent classification.',
  'schema.ai.openai.fast_model.description': 'Faster/cheaper LLM. Falls back to inference model.',
  'schema.ai.openai.embedding_model.description':
    'text-embedding-3-small (cheap) or text-embedding-3-large (accurate).',
  'schema.ai.anthropic.inference_model.description': 'Claude model for summarization and reasoning.',
  'schema.ai.anthropic.fast_model.description': 'Fastest Claude model for low-latency tasks.',
  'schema.ai.gemini.inference_model.description': 'Gemini model for summarization.',
  'schema.ai.gemini.fast_model.description': 'Fast Gemini model for low-latency tasks.',
  'schema.ai.gemini.embedding_model.description':
    'Gemini embedding model. text-embedding-004 (768d) is recommended.',
  'schema.ai.vertex.inference_model.description':
    'Vertex-hosted model for summarization (e.g. gemini-2.5-flash, gemini-2.5-pro).',
  'schema.ai.vertex.fast_model.description': 'Fast Vertex model for low-latency tasks.',
  'schema.ai.vertex.embedding_model.description':
    'Vertex embedding model (e.g. text-embedding-005 768d, gemini-embedding-001 3072d).',
  'schema.ai.voyage.embedding_model.description':
    'Voyage embedding model. voyage-code-3 (1024d) is tuned for source code.',
  'schema.ai.mistral.inference_model.description': 'Mistral LLM for summarization.',
  'schema.ai.mistral.fast_model.description': 'Fast Mistral model.',
  'schema.ai.mistral.embedding_model.description': 'Mistral embedding model (1024d).',
  'schema.ai.groq.inference_model.description': 'Groq-hosted LLM. Ultra-fast inference.',
  'schema.ai.groq.fast_model.description': 'Fastest Groq model for low-latency tasks.',
  'schema.ai.groq.embedding_model.description': 'Groq embedding model.',
  'schema.ai.together.inference_model.description': 'Together-hosted LLM.',
  'schema.ai.together.fast_model.description': 'Fast Together model.',
  'schema.ai.together.embedding_model.description': 'Together embedding model.',
  'schema.ai.deepseek.inference_model.description': 'DeepSeek V3 for summarization and reasoning.',
  'schema.ai.deepseek.fast_model.description': 'DeepSeek fast model.',
  'schema.ai.xai.inference_model.description': 'Grok model for summarization.',
  'schema.ai.xai.fast_model.description': 'Fast Grok model.',
  'schema.ai.onnx.embedding_model.description':
    'ONNX model for local embeddings. Default works out of the box.',

  'schema.ai.dimensions.label': 'Embedding dimensions',
  'schema.ai.dimensions.description':
    'Vector size. Must match the model (384 for MiniLM, 768 for nomic/Gemini/Vertex text-embedding-005, 1024 for Mistral/voyage-code-3, 1536 for OpenAI, 3072 for gemini-embedding-001).',
  'schema.ai.summarize.label': 'Summarize on index',
  'schema.ai.summarize.description':
    'Generate natural-language summaries during indexing. Requires a provider with inference model.',
  'schema.ai.summarize_batch.label': 'Summarize batch size',
  'schema.ai.summarize_batch.description': 'Symbols to summarize in parallel per batch.',
  'schema.ai.summarize_kinds.label': 'Summarize kinds',
  'schema.ai.summarize_kinds.description': 'Which symbol kinds to generate summaries for.',
  'schema.ai.concurrency.label': 'Concurrency',
  'schema.ai.concurrency.description': 'Parallel AI requests. For Ollama, match OLLAMA_NUM_PARALLEL.',

  /* ── Schema: Security ──────────────────────────────────────────────── */
  'schema.security.secret_patterns.label': 'Secret patterns',
  'schema.security.max_file_size.label': 'Max file size (bytes)',
  'schema.security.max_files.label': 'Max files per project',

  /* ── Schema: Predictive analysis ───────────────────────────────────── */
  'schema.predictive.cache_ttl.label': 'Cache TTL (minutes)',
  'schema.predictive.git_since.label': 'Git history (days)',
  'schema.predictive.module_depth.label': 'Module depth',
  'schema.predictive.weights.label': 'Weights',
  'schema.predictive.weights.description': 'Bug/debt/risk scoring weights',

  /* ── Schema: Intent and domains ────────────────────────────────────── */
  'schema.intent.auto_classify.label': 'Auto-classify on index',
  'schema.intent.domain_hints.label': 'Domain hints',
  'schema.intent.domain_hints.description': '{ "domain": ["path/**"] }',
  'schema.intent.custom_domains.label': 'Custom domains',
  'schema.intent.custom_domains.description': '[{ name, path_patterns }]',

  /* ── Schema: Runtime tracing ───────────────────────────────────────── */
  'schema.runtime.port.label': 'OTLP port',
  'schema.runtime.host.label': 'OTLP host',
  'schema.runtime.max_body.label': 'Max body bytes',
  'schema.runtime.max_span_age.label': 'Max span age (days)',
  'schema.runtime.max_aggregate_age.label': 'Max aggregate age (days)',
  'schema.runtime.prune_interval.label': 'Prune interval',
  'schema.runtime.fqn_attributes.label': 'FQN attributes',
  'schema.runtime.route_patterns.label': 'Route patterns',

  /* ── Schema: Cross-repo topology ───────────────────────────────────── */
  'schema.topology.auto_detect.label': 'Auto-detect repos',
  'schema.topology.auto_discover.label': 'Auto-discover subprojects',
  'schema.topology.repos.label': 'Extra repo paths',
  'schema.topology.contract_globs.label': 'Contract globs',

  /* ── Schema: LSP enrichment ────────────────────────────────────────── */
  'schema.lsp.enabled.description': 'Enable LSP enrichment pass after indexing',
  'schema.lsp.auto_detect.description':
    'Auto-detect available LSP servers (tsserver, pyright, gopls, rust-analyzer)',
  'schema.lsp.max_servers.label': 'Max concurrent servers',
  'schema.lsp.max_servers.description': 'Limit parallel LSP server processes',
  'schema.lsp.timeout.label': 'Enrichment timeout (ms)',
  'schema.lsp.timeout.description': 'Overall timeout for the LSP enrichment pass',
  'schema.lsp.batch_size.description': 'Symbols processed per batch',
  'schema.lsp.servers.label': 'Server overrides',
  'schema.lsp.servers.description':
    '{ "typescript": { "command": "npx", "args": ["typescript-language-server", "--stdio"], "timeout_ms": 30000 } }',

  /* ── Schema: Quality gates ─────────────────────────────────────────── */
  'schema.quality_gates.fail_on.label': 'Fail on',
  'schema.quality_gates.rules.label': 'Rules',
  'schema.quality_gates.rules.description': 'Rule thresholds and severities',

  /* ── Schema: Tool exposure ─────────────────────────────────────────── */
  'schema.tools.preset.label': 'Preset',
  'schema.tools.include.label': 'Include tools',
  'schema.tools.exclude.label': 'Exclude tools',
  'schema.tools.description_verbosity.label': 'Description verbosity',
  'schema.tools.instructions_verbosity.label': 'Instructions verbosity',
  'schema.tools.meta_fields.label': 'Meta fields',
  'schema.tools.compact_schemas.label': 'Compact schemas',
  'schema.tools.compact_schemas.description':
    'Strip advanced parameters from tool schemas to reduce token overhead (~42%)',
  'schema.tools.descriptions.label': 'Custom descriptions',
  'schema.tools.descriptions.description': '{ "tool_name": "description" }',

  /* ── Schema: Ignore rules ──────────────────────────────────────────── */
  'schema.ignore.directories.label': 'Directories',
  'schema.ignore.patterns.label': 'Patterns',

  /* ── Schema: Frameworks ────────────────────────────────────────────── */
  'schema.frameworks.config.label': 'Configuration',
  'schema.frameworks.config.description': 'Framework overrides',

  /* ── Schema: Logging ───────────────────────────────────────────────── */
  'schema.logging.file.label': 'Enable file logging',
  'schema.logging.path.label': 'Log file path',
  'schema.logging.level.label': 'Log level',
  'schema.logging.max_size.label': 'Max log size (MB)',

  /* ── Schema: File watcher ──────────────────────────────────────────── */
  'schema.watch.debounce.label': 'Debounce (ms)',
} as const;
