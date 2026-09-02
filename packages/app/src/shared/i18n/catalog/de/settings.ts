export const settings = {
  /* ── Screen chrome ─────────────────────────────────────────────────── */
  title: 'Einstellungen',
  back: 'Zurück',
  moreActions: 'Weitere Aktionen',
  search: 'Einstellungen durchsuchen',
  copyDaemon: 'Daemon-Details kopieren',
  editConfigFile: 'Konfigurationsdatei bearbeiten…',
  noMatches: 'Keine Einstellung passt zu „{{query}}“.',

  /* ── Groups on the section list ────────────────────────────────────── */
  'group.general': 'Allgemein',
  'group.intelligence': 'Intelligenz',
  'group.quality': 'Qualität und Sicherheit',
  'group.infrastructure': 'Infrastruktur',
  'group.development': 'Entwicklung',
  'group.monitoring': 'Überwachung',
  'group.advanced': 'Erweitert',

  /* ── Daemon card ───────────────────────────────────────────────────── */
  'daemon.title': 'Daemon',
  'daemon.state': 'Läuft',
  'daemon.summary': 'Läuft · Port {{port}} · seit {{uptime}}',
  'uptime.seconds': '{{value}} s',
  'uptime.minutes': '{{value}} Min.',
  'uptime.hours': '{{value}} Std.',
  'uptime.hoursMinutes': '{{hours}} Std. {{minutes}} Min.',

  /* ── App preferences (not daemon settings) ─────────────────────────── */
  'app.title': 'App',
  'app.language': 'Sprache',
  'appearance.theme': 'Erscheinungsbild',

  /* ── Daemon-down and loading states ────────────────────────────────── */
  'empty.loading': 'Einstellungen werden geladen…',
  'empty.unreadableTitle': 'Die Einstellungen konnten nicht gelesen werden',
  'empty.unreadableBody':
    'Der Daemon läuft, hat seine Konfiguration aber nicht zurückgegeben. Ein Neustart behebt das in der Regel.',
  'empty.unreachableTitle': 'Daemon nicht erreichbar',
  'empty.unreachableBody':
    'Die Einstellungen liegen in der Konfigurationsdatei des Daemons und können erst gelesen werden, wenn er läuft.',
  'empty.starting': 'Wird gestartet…',
  'empty.restart': 'Daemon neu starten',
  'empty.start': 'Daemon starten',

  /* ── Section list ──────────────────────────────────────────────────── */
  modified: 'Geändert',
  issues_one: '{{count}} Problem',
  issues_other: '{{count}} Probleme',

  /* ── Section detail ────────────────────────────────────────────────── */
  reset: 'Zurücksetzen',
  resetSection: 'Diesen Bereich auf die Standardwerte zurücksetzen',
  notSet: 'Nicht gesetzt',
  'field.aria': '{{label}}: {{value}}',
  'field.ariaUnset': '{{label}}: nicht gesetzt',
  invalidJson: 'Ungültiges JSON',

  /* ── Model picker ──────────────────────────────────────────────────── */
  'models.select': 'Modell auswählen…',
  'models.filter': 'Modelle filtern',
  'models.loading': 'Modelle werden geladen…',
  'models.retry': 'Erneut versuchen',
  'models.none': 'Keine Modelle gefunden',
  'models.noMatches': 'Keine Treffer',
  'models.clear': 'Auswahl aufheben',
  'models.type': 'Oder Modellnamen eingeben…',
  'models.typeAria': 'Modellnamen eingeben',
  'models.failed': 'Modelle konnten nicht abgerufen werden',
  'models.httpError': '{{provider}}: {{status}}',
  'models.authError': '{{provider}}: {{status}} (API-Schlüssel prüfen)',

  /* ── Per-project overrides ─────────────────────────────────────────── */
  'projects.title': 'Projektspezifische Überschreibungen',
  'projects.intro':
    'Globale Einstellungen für einzelne Projekte überschreiben. Die Werte werden über die globale Konfiguration gelegt.',
  'projects.done': 'Fertig',
  'projects.edit': 'Bearbeiten',
  'projects.remove': 'Entfernen',
  'projects.apply': 'Anwenden',
  'projects.add': 'Hinzufügen',
  'projects.pathAria': 'Projektpfad',
  'projects.overridesAria': 'Überschreibungen für {{path}}',

  /* ── Pending changes and the unsaved-changes bar ───────────────────── */
  'diff.title': 'Ausstehende Änderungen',
  'diff.hide': 'Ausblenden',
  'bar.hasErrors': 'Behebe die Probleme oben, bevor du sicherst',
  'bar.saved': 'Gesichert',
  'bar.saveFailed': 'Sichern fehlgeschlagen — der Daemon hat die Änderung abgelehnt',
  'bar.unsaved_one': '{{count}} ungesicherte Änderung',
  'bar.unsaved_other': '{{count}} ungesicherte Änderungen',
  'bar.hideChanges': 'Änderungen ausblenden',
  'bar.reviewChanges': 'Änderungen prüfen',
  'bar.discard': 'Verwerfen',
  'bar.saving': 'Wird gesichert…',
  'bar.save': 'Sichern',

  /* ── AI activity link-out ──────────────────────────────────────────── */
  'activity.title': 'KI-Aktivität',
  'activity.armed': 'Das nächste Projektfenster, das du öffnest, startet mit Aktivität → KI-Aufrufe.',
  'activity.idle': 'Aktuelle Embedding-, LLM- und Rerank-Anfragen findest du im Projektfenster unter „Aktivität“.',
  'activity.ready': 'Bereit',
  'activity.open': 'Beim nächsten Mal dort öffnen',

  /* ── Field validation (configSchema.ts) ────────────────────────────── */
  'validate.boolean': 'Muss true oder false sein',
  'validate.number': 'Muss eine Zahl sein',
  'validate.min': 'Min.: {{min}}',
  'validate.max': 'Max.: {{max}}',
  'validate.string': 'Muss eine Zeichenkette sein',
  'validate.tooLong': 'Zu lang (max. {{max}} Zeichen)',
  'validate.pattern': 'Muss passen zu: {{pattern}}',
  'validate.oneOf': 'Muss eines davon sein: {{options}}',
  'validate.list': 'Muss eine Liste sein',
  'validate.json': 'Muss gültiges JSON sein (keine Zeichenkette)',

  /* ── Schema: sections ──────────────────────────────────────────────── */
  'schema._root.label': 'Allgemein',
  'schema._root.description': 'Automatische Updates und übergeordnete Einstellungen',
  'schema.ai.label': 'KI und Embeddings',
  'schema.ai.description':
    'KI-Anbieter für semantische Suche, Zusammenfassungen und Intent-Klassifizierung',
  'schema.security.label': 'Sicherheit',
  'schema.security.description': 'Secret-Erkennung und Dateilimits',
  'schema.predictive.label': 'Prädiktive Analyse',
  'schema.predictive.description': 'Fehlerprognose, Tech-Debt-Bewertung, Änderungsrisiko',
  'schema.intent.label': 'Intent und Domänen',
  'schema.intent.description': 'Domänenklassifizierung und automatisches Tagging',
  'schema.runtime.label': 'Laufzeit-Tracing (OTLP)',
  'schema.runtime.description': 'Aufnahme von OpenTelemetry-Spans und Trace-Analyse',
  'schema.topology.label': 'Repo-übergreifende Topologie',
  'schema.topology.description': 'Teilprojekte und dienstübergreifende Abhängigkeiten',
  'schema.lsp.label': 'LSP-Anreicherung',
  'schema.lsp.description': 'Compilergenaue Auflösung des Call-Graphs über das Language Server Protocol',
  'schema.quality_gates.label': 'Quality Gates',
  'schema.quality_gates.description': 'Automatische Qualitätsprüfungen bei Commits und PRs',
  'schema.tools.label': 'Tool-Bereitstellung',
  'schema.tools.description': 'Steuern, welche MCP-Tools bereitgestellt werden und wie',
  'schema.ignore.label': 'Ignorierregeln',
  'schema.ignore.description': 'Zusätzliche Verzeichnisse und Muster, die beim Indexieren übersprungen werden',
  'schema.frameworks.label': 'Frameworks',
  'schema.frameworks.description': 'Framework-spezifische Einstellungen (Laravel usw.)',
  'schema.logging.label': 'Protokollierung',
  'schema.logging.description': 'Dateiprotokollierung und Rotation',
  'schema.watch.label': 'Dateiüberwachung',
  'schema.watch.description': 'Automatische Neuindexierung bei Dateiänderungen',

  /* ── Schema: field labels reused across sections and providers ─────── */
  'schema.f.enabled': 'Aktiviert',
  'schema.f.baseUrl': 'Basis-URL',
  'schema.f.apiKey': 'API-Schlüssel',
  'schema.f.inferenceModel': 'Inferenzmodell',
  'schema.f.fastModel': 'Schnelles Modell',
  'schema.f.embeddingModel': 'Embedding-Modell',
  'schema.f.rerankerModel': 'Reranker-Modell',
  'schema.f.autoDetect': 'Server automatisch erkennen',
  'schema.f.batchSize': 'Batch-Größe',

  /* ── Schema: General ───────────────────────────────────────────────── */
  'schema._root.auto_update.label': 'Automatische Updates',
  'schema._root.interval.label': 'Intervall der Update-Prüfung (Stunden)',
  'schema._root.logLevel.label': 'Log-Level des Daemons',

  /* ── Schema: AI and embeddings ─────────────────────────────────────── */
  'schema.ai.provider.label': 'Anbieter',
  'schema.ai.provider.description':
    'onnx = lokal, ohne Konfiguration. ollama/lmstudio = lokal mit Modellauswahl. gemini = Google Generative Language API (Consumer, AIza-Schlüssel). vertex = Google Vertex AI (GCP, OAuth-Bearer-Token + Projekt/Region). voyage = nur Voyage-AI-Embeddings. Übrige = Cloud-APIs.',
  'schema.ai.embedding.label': 'Embeddings verwenden',
  'schema.ai.embedding.description':
    'Vektor-Embeddings für semantische Suche und Reranking erzeugen. Ausschalten, um die semantische Suche zu deaktivieren und die Inferenz zu behalten.',
  'schema.ai.inference.label': 'Inferenz verwenden',
  'schema.ai.inference.description':
    'Das LLM für Zusammenfassungen, Intent-Klassifizierung und „Fragen“ aufrufen. Ausschalten, um alle LLM-Aufrufe zu überspringen und die Embeddings zu behalten.',
  'schema.ai.fast_inference.label': 'Schnelle Inferenz verwenden',
  'schema.ai.fast_inference.description':
    'Das schnelle Modell für latenzarme Aufgaben nutzen. Ist es aus, erhalten Fast-Path-Aufrufer leere Antworten — außer beim Debuggen eingeschaltet lassen.',

  'schema.ai.ollama.base_url.description':
    'Endpunkt des Ollama-Servers. Ändern, wenn er auf einem anderen Host oder Port läuft.',
  'schema.ai.lmstudio.base_url.description': 'Endpunkt des lokalen LM-Studio-Servers.',
  'schema.ai.openai.base_url.description':
    'Endpunkt der OpenAI-API. Für Azure OpenAI oder kompatible Anbieter ändern.',
  'schema.ai.openai.api_key.description': 'Erforderlich. Alternativ die Umgebungsvariable OPENAI_API_KEY setzen.',
  'schema.ai.anthropic.api_key.description':
    'Anthropic-API-Schlüssel von console.anthropic.com. Alternativ die Umgebungsvariable ANTHROPIC_API_KEY setzen.',
  'schema.ai.gemini.api_key.description':
    'Schlüssel für die Google Generative Language API von ai.google.dev (beginnt mit AIza). Alternativ die Umgebungsvariable GEMINI_API_KEY setzen. Für GCP/Vertex stattdessen den Anbieter „vertex“ nutzen.',
  'schema.ai.vertex.api_key.label': 'Zugriffstoken',
  'schema.ai.vertex.api_key.description':
    'OAuth2-Bearer-Token (kurzlebig, ca. 1 Std.). Erzeugen mit: gcloud auth print-access-token. Alternativ die Umgebungsvariable GOOGLE_ACCESS_TOKEN setzen.',
  'schema.ai.vertex.project.label': 'GCP-Projekt',
  'schema.ai.vertex.project.description':
    'ID des Google-Cloud-Projekts, in dem Vertex AI läuft. Alternativ die Umgebungsvariable GOOGLE_CLOUD_PROJECT setzen.',
  'schema.ai.vertex.location.label': 'GCP-Region',
  'schema.ai.vertex.location.description':
    'Vertex-AI-Region (z. B. us-central1, europe-west4, asia-northeast1). Alternativ die Umgebungsvariable GOOGLE_CLOUD_LOCATION setzen.',
  'schema.ai.voyage.base_url.description': 'Endpunkt von Voyage AI. Üblicherweise der Standardwert.',
  'schema.ai.voyage.api_key.description':
    'Voyage-API-Schlüssel von dash.voyageai.com. Alternativ die Umgebungsvariable VOYAGE_API_KEY setzen. Nur Embeddings — keine Inferenz.',
  'schema.ai.mistral.base_url.description': 'Endpunkt der Mistral-API.',
  'schema.ai.mistral.api_key.description':
    'Mistral-API-Schlüssel von console.mistral.ai. Alternativ die Umgebungsvariable MISTRAL_API_KEY setzen.',
  'schema.ai.groq.base_url.description': 'Endpunkt der Groq-API.',
  'schema.ai.groq.api_key.description': 'Groq-API-Schlüssel von console.groq.com. Alternativ die Umgebungsvariable GROQ_API_KEY setzen.',
  'schema.ai.together.base_url.description': 'Endpunkt der Together-AI-API.',
  'schema.ai.together.api_key.description':
    'Together-API-Schlüssel von api.together.ai. Alternativ die Umgebungsvariable TOGETHER_API_KEY setzen.',
  'schema.ai.deepseek.base_url.description': 'Endpunkt der DeepSeek-API.',
  'schema.ai.deepseek.api_key.description':
    'DeepSeek-API-Schlüssel von platform.deepseek.com. Alternativ die Umgebungsvariable DEEPSEEK_API_KEY setzen.',
  'schema.ai.xai.base_url.description': 'Endpunkt der xAI-API (Grok).',
  'schema.ai.xai.api_key.description': 'xAI-API-Schlüssel von console.x.ai. Alternativ die Umgebungsvariable XAI_API_KEY setzen.',

  'schema.ai.ollama.inference_model.description': 'LLM für Zusammenfassungen und Intent-Klassifizierung.',
  'schema.ai.ollama.fast_model.description':
    'Kleineres/schnelleres LLM für latenzarme Aufgaben. Fällt auf das Inferenzmodell zurück.',
  'schema.ai.ollama.embedding_model.description':
    'Embedding-Modell für die semantische Suche. Muss zu embedding_dimensions passen.',
  'schema.ai.ollama.reranker_model.description': 'Cross-Encoder zum Neuordnen von Suchergebnissen.',
  'schema.ai.lmstudio.inference_model.description': 'In LM Studio geladenes LLM.',
  'schema.ai.lmstudio.fast_model.description': 'Schnelles LLM für latenzarme Aufgaben.',
  'schema.ai.lmstudio.embedding_model.description': 'In LM Studio geladenes Embedding-Modell.',
  'schema.ai.openai.inference_model.description': 'LLM für Zusammenfassungen und Intent-Klassifizierung.',
  'schema.ai.openai.fast_model.description': 'Schnelleres/günstigeres LLM. Fällt auf das Inferenzmodell zurück.',
  'schema.ai.openai.embedding_model.description':
    'text-embedding-3-small (günstig) oder text-embedding-3-large (genau).',
  'schema.ai.anthropic.inference_model.description': 'Claude-Modell für Zusammenfassungen und Schlussfolgerungen.',
  'schema.ai.anthropic.fast_model.description': 'Schnellstes Claude-Modell für latenzarme Aufgaben.',
  'schema.ai.gemini.inference_model.description': 'Gemini-Modell für Zusammenfassungen.',
  'schema.ai.gemini.fast_model.description': 'Schnelles Gemini-Modell für latenzarme Aufgaben.',
  'schema.ai.gemini.embedding_model.description':
    'Gemini-Embedding-Modell. Empfohlen wird text-embedding-004 (768d).',
  'schema.ai.vertex.inference_model.description':
    'Auf Vertex gehostetes Modell für Zusammenfassungen (z. B. gemini-2.5-flash, gemini-2.5-pro).',
  'schema.ai.vertex.fast_model.description': 'Schnelles Vertex-Modell für latenzarme Aufgaben.',
  'schema.ai.vertex.embedding_model.description':
    'Vertex-Embedding-Modell (z. B. text-embedding-005 768d, gemini-embedding-001 3072d).',
  'schema.ai.voyage.embedding_model.description':
    'Voyage-Embedding-Modell. voyage-code-3 (1024d) ist auf Quellcode abgestimmt.',
  'schema.ai.mistral.inference_model.description': 'Mistral-LLM für Zusammenfassungen.',
  'schema.ai.mistral.fast_model.description': 'Schnelles Mistral-Modell.',
  'schema.ai.mistral.embedding_model.description': 'Mistral-Embedding-Modell (1024d).',
  'schema.ai.groq.inference_model.description': 'Auf Groq gehostetes LLM. Ultraschnelle Inferenz.',
  'schema.ai.groq.fast_model.description': 'Schnellstes Groq-Modell für latenzarme Aufgaben.',
  'schema.ai.groq.embedding_model.description': 'Groq-Embedding-Modell.',
  'schema.ai.together.inference_model.description': 'Auf Together gehostetes LLM.',
  'schema.ai.together.fast_model.description': 'Schnelles Together-Modell.',
  'schema.ai.together.embedding_model.description': 'Together-Embedding-Modell.',
  'schema.ai.deepseek.inference_model.description': 'DeepSeek V3 für Zusammenfassungen und Schlussfolgerungen.',
  'schema.ai.deepseek.fast_model.description': 'Schnelles DeepSeek-Modell.',
  'schema.ai.xai.inference_model.description': 'Grok-Modell für Zusammenfassungen.',
  'schema.ai.xai.fast_model.description': 'Schnelles Grok-Modell.',
  'schema.ai.onnx.embedding_model.description':
    'ONNX-Modell für lokale Embeddings. Der Standardwert funktioniert sofort.',

  'schema.ai.dimensions.label': 'Embedding-Dimensionen',
  'schema.ai.dimensions.description':
    'Vektorgröße. Muss zum Modell passen (384 für MiniLM, 768 für nomic/Gemini/Vertex text-embedding-005, 1024 für Mistral/voyage-code-3, 1536 für OpenAI, 3072 für gemini-embedding-001).',
  'schema.ai.summarize.label': 'Beim Indexieren zusammenfassen',
  'schema.ai.summarize.description':
    'Beim Indexieren natürlichsprachliche Zusammenfassungen erzeugen. Erfordert einen Anbieter mit Inferenzmodell.',
  'schema.ai.summarize_batch.label': 'Batch-Größe für Zusammenfassungen',
  'schema.ai.summarize_batch.description': 'Symbole, die je Batch parallel zusammengefasst werden.',
  'schema.ai.summarize_kinds.label': 'Arten für Zusammenfassungen',
  'schema.ai.summarize_kinds.description': 'Für welche Symbolarten Zusammenfassungen erzeugt werden.',
  'schema.ai.concurrency.label': 'Parallelität',
  'schema.ai.concurrency.description': 'Parallele KI-Anfragen. Bei Ollama an OLLAMA_NUM_PARALLEL angleichen.',

  /* ── Schema: Security ──────────────────────────────────────────────── */
  'schema.security.secret_patterns.label': 'Secret-Muster',
  'schema.security.max_file_size.label': 'Maximale Dateigröße (Bytes)',
  'schema.security.max_files.label': 'Maximale Dateizahl pro Projekt',

  /* ── Schema: Predictive analysis ───────────────────────────────────── */
  'schema.predictive.cache_ttl.label': 'Cache-TTL (Minuten)',
  'schema.predictive.git_since.label': 'Git-Historie (Tage)',
  'schema.predictive.module_depth.label': 'Modultiefe',
  'schema.predictive.weights.label': 'Gewichtungen',
  'schema.predictive.weights.description': 'Gewichtungen für Fehler-, Debt- und Risikobewertung',

  /* ── Schema: Intent and domains ────────────────────────────────────── */
  'schema.intent.auto_classify.label': 'Beim Indexieren automatisch klassifizieren',
  'schema.intent.domain_hints.label': 'Domänen-Hinweise',
  'schema.intent.domain_hints.description': '{ "domain": ["path/**"] }',
  'schema.intent.custom_domains.label': 'Eigene Domänen',
  'schema.intent.custom_domains.description': '[{ name, path_patterns }]',

  /* ── Schema: Runtime tracing ───────────────────────────────────────── */
  'schema.runtime.port.label': 'OTLP-Port',
  'schema.runtime.host.label': 'OTLP-Host',
  'schema.runtime.max_body.label': 'Maximale Body-Größe (Bytes)',
  'schema.runtime.max_span_age.label': 'Maximales Span-Alter (Tage)',
  'schema.runtime.max_aggregate_age.label': 'Maximales Aggregat-Alter (Tage)',
  'schema.runtime.prune_interval.label': 'Bereinigungsintervall',
  'schema.runtime.fqn_attributes.label': 'FQN-Attribute',
  'schema.runtime.route_patterns.label': 'Routen-Muster',

  /* ── Schema: Cross-repo topology ───────────────────────────────────── */
  'schema.topology.auto_detect.label': 'Repos automatisch erkennen',
  'schema.topology.auto_discover.label': 'Teilprojekte automatisch finden',
  'schema.topology.repos.label': 'Zusätzliche Repo-Pfade',
  'schema.topology.contract_globs.label': 'Contract-Globs',

  /* ── Schema: LSP enrichment ────────────────────────────────────────── */
  'schema.lsp.enabled.description': 'LSP-Anreicherung nach dem Indexieren aktivieren',
  'schema.lsp.auto_detect.description':
    'Verfügbare LSP-Server automatisch erkennen (tsserver, pyright, gopls, rust-analyzer)',
  'schema.lsp.max_servers.label': 'Maximale Zahl paralleler Server',
  'schema.lsp.max_servers.description': 'Parallele LSP-Serverprozesse begrenzen',
  'schema.lsp.timeout.label': 'Timeout der Anreicherung (ms)',
  'schema.lsp.timeout.description': 'Gesamt-Timeout für den LSP-Anreicherungsdurchlauf',
  'schema.lsp.batch_size.description': 'Symbole, die je Batch verarbeitet werden',
  'schema.lsp.servers.label': 'Server-Überschreibungen',
  'schema.lsp.servers.description':
    '{ "typescript": { "command": "npx", "args": ["typescript-language-server", "--stdio"], "timeout_ms": 30000 } }',

  /* ── Schema: Quality gates ─────────────────────────────────────────── */
  'schema.quality_gates.fail_on.label': 'Fehlschlagen bei',
  'schema.quality_gates.rules.label': 'Regeln',
  'schema.quality_gates.rules.description': 'Schwellenwerte und Schweregrade der Regeln',

  /* ── Schema: Tool exposure ─────────────────────────────────────────── */
  'schema.tools.preset.label': 'Voreinstellung',
  'schema.tools.include.label': 'Tools einschließen',
  'schema.tools.exclude.label': 'Tools ausschließen',
  'schema.tools.description_verbosity.label': 'Ausführlichkeit der Beschreibungen',
  'schema.tools.instructions_verbosity.label': 'Ausführlichkeit der Anweisungen',
  'schema.tools.meta_fields.label': 'Meta-Felder',
  'schema.tools.compact_schemas.label': 'Kompakte Schemas',
  'schema.tools.compact_schemas.description':
    'Erweiterte Parameter aus den Tool-Schemas entfernen, um Token zu sparen (ca. 42 %)',
  'schema.tools.descriptions.label': 'Eigene Beschreibungen',
  'schema.tools.descriptions.description': '{ "tool_name": "description" }',

  /* ── Schema: Ignore rules ──────────────────────────────────────────── */
  'schema.ignore.directories.label': 'Verzeichnisse',
  'schema.ignore.patterns.label': 'Muster',

  /* ── Schema: Frameworks ────────────────────────────────────────────── */
  'schema.frameworks.config.label': 'Konfiguration',
  'schema.frameworks.config.description': 'Framework-Überschreibungen',

  /* ── Schema: Logging ───────────────────────────────────────────────── */
  'schema.logging.file.label': 'Dateiprotokollierung aktivieren',
  'schema.logging.path.label': 'Pfad der Logdatei',
  'schema.logging.level.label': 'Log-Level',
  'schema.logging.max_size.label': 'Maximale Loggröße (MB)',

  /* ── Schema: File watcher ──────────────────────────────────────────── */
  'schema.watch.debounce.label': 'Entprellung (ms)',

  /* ── Setup wizard ── */
  'app.setupWizard': "Einrichtungsassistent",
  'app.runSetupWizard': "Assistent starten…",
} as const;
