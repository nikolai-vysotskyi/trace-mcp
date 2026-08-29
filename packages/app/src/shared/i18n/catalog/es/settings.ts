export const settings = {
  title: 'Ajustes',
  back: 'Atrás',
  moreActions: 'Más acciones',
  search: 'Buscar en los ajustes',
  copyDaemon: 'Copiar los datos del daemon',
  editConfigFile: 'Editar el archivo de configuración…',
  noMatches: 'Ningún ajuste coincide con “{{query}}”.',

  'group.general': 'General',
  'group.intelligence': 'Inteligencia',
  'group.quality': 'Calidad y seguridad',
  'group.infrastructure': 'Infraestructura',
  'group.development': 'Desarrollo',
  'group.monitoring': 'Monitorización',
  'group.advanced': 'Avanzado',

  'daemon.title': 'Daemon',
  'daemon.state': 'En marcha',
  'daemon.summary': 'En marcha · puerto {{port}} · lleva {{uptime}}',
  'uptime.seconds': '{{value}} s',
  'uptime.minutes': '{{value}} min',
  'uptime.hours': '{{value}} h',
  'uptime.hoursMinutes': '{{hours}} h {{minutes}} min',

  'app.title': 'App',
  'app.language': 'Idioma',
  'appearance.theme': 'Tema',

  'empty.loading': 'Cargando los ajustes…',
  'empty.unreadableTitle': 'No se pudieron leer los ajustes',
  'empty.unreadableBody':
    'El daemon está en marcha pero no devolvió su configuración. Reiniciarlo suele bastar.',
  'empty.unreachableTitle': 'Daemon inaccesible',
  'empty.unreachableBody':
    'Los ajustes viven en el archivo de configuración del daemon, así que no pueden leerse hasta que esté en marcha.',
  'empty.starting': 'Arrancando…',
  'empty.restart': 'Reiniciar el daemon',
  'empty.start': 'Arrancar el daemon',

  modified: 'Modificado',
  issues_one: '{{count}} problema',
  issues_many: '{{count}} de problemas',
  issues_other: '{{count}} problemas',

  reset: 'Restablecer',
  resetSection: 'Restablecer esta sección a los valores por defecto',
  notSet: 'Sin definir',
  'field.aria': '{{label}}: {{value}}',
  'field.ariaUnset': '{{label}}: sin definir',
  invalidJson: 'JSON no válido',

  'models.select': 'Selecciona un modelo…',
  'models.filter': 'Filtrar los modelos',
  'models.loading': 'Cargando los modelos…',
  'models.retry': 'Reintentar',
  'models.none': 'No se han encontrado modelos',
  'models.noMatches': 'Sin coincidencias',
  'models.clear': 'Quitar la selección',
  'models.type': 'O escribe el nombre de un modelo…',
  'models.typeAria': 'Escribe el nombre de un modelo',
  'models.failed': 'No se pudieron obtener los modelos',
  'models.httpError': '{{provider}}: {{status}}',
  'models.authError': '{{provider}}: {{status}} (revisa la clave de API)',

  'projects.title': 'Ajustes por proyecto',
  'projects.intro':
    'Sobrescribe los ajustes globales para proyectos concretos. Los valores se combinan sobre la configuración global.',
  'projects.done': 'Hecho',
  'projects.edit': 'Editar',
  'projects.remove': 'Quitar',
  'projects.apply': 'Aplicar',
  'projects.add': 'Añadir',
  'projects.pathAria': 'Ruta del proyecto',
  'projects.overridesAria': 'Ajustes propios de {{path}}',

  'diff.title': 'Cambios pendientes',
  'diff.hide': 'Ocultar',
  'bar.hasErrors': 'Corrige los problemas de arriba antes de guardar',
  'bar.saved': 'Guardado',
  'bar.saveFailed': 'No se pudo guardar — el daemon rechazó el cambio',
  'bar.unsaved_one': '{{count}} cambio sin guardar',
  'bar.unsaved_many': '{{count}} de cambios sin guardar',
  'bar.unsaved_other': '{{count}} cambios sin guardar',
  'bar.hideChanges': 'Ocultar los cambios',
  'bar.reviewChanges': 'Revisar los cambios',
  'bar.discard': 'Descartar',
  'bar.saving': 'Guardando…',
  'bar.save': 'Guardar',

  'activity.title': 'Actividad de IA',
  'activity.armed': 'La próxima ventana de proyecto que abras se abrirá en Actividad → IA.',
  'activity.idle':
    'Las peticiones recientes de embedding, LLM y rerank viven en una ventana de proyecto, dentro de Actividad.',
  'activity.ready': 'Listo',
  'activity.open': 'Abrir ahí la próxima vez',

  'validate.boolean': 'Debe ser true o false',
  'validate.number': 'Debe ser un número',
  'validate.min': 'Mín.: {{min}}',
  'validate.max': 'Máx.: {{max}}',
  'validate.string': 'Debe ser una cadena',
  'validate.tooLong': 'Demasiado largo (máx. {{max}} caracteres)',
  'validate.pattern': 'Debe coincidir con: {{pattern}}',
  'validate.oneOf': 'Debe ser uno de: {{options}}',
  'validate.list': 'Debe ser una lista',
  'validate.json': 'Debe ser JSON válido (no una cadena)',

  'schema._root.label': 'General',
  'schema._root.description': 'Actualización automática y ajustes de primer nivel',
  'schema.ai.label': 'IA y embeddings',
  'schema.ai.description':
    'Proveedor de IA para la búsqueda semántica, los resúmenes y la clasificación de intención',
  'schema.security.label': 'Seguridad',
  'schema.security.description': 'Detección de secretos y límites de archivo',
  'schema.predictive.label': 'Análisis predictivo',
  'schema.predictive.description':
    'Predicción de fallos, puntuación de deuda técnica y riesgo de cambio',
  'schema.intent.label': 'Intención y dominios',
  'schema.intent.description': 'Clasificación de dominios y etiquetado automático',
  'schema.runtime.label': 'Trazas de ejecución (OTLP)',
  'schema.runtime.description': 'Ingesta de spans de OpenTelemetry y análisis de trazas',
  'schema.topology.label': 'Topología entre repos',
  'schema.topology.description': 'Subproyectos y seguimiento de dependencias entre servicios',
  'schema.lsp.label': 'Enriquecimiento LSP',
  'schema.lsp.description':
    'Resolución del grafo de llamadas a nivel de compilador vía Language Server Protocol',
  'schema.quality_gates.label': 'Puertas de calidad',
  'schema.quality_gates.description': 'Comprobaciones automáticas de calidad en commits y PRs',
  'schema.tools.label': 'Exposición de herramientas',
  'schema.tools.description': 'Controla qué herramientas MCP se exponen y cómo',
  'schema.ignore.label': 'Reglas de exclusión',
  'schema.ignore.description': 'Directorios y patrones extra que saltarse al indexar',
  'schema.frameworks.label': 'Frameworks',
  'schema.frameworks.description': 'Ajustes específicos de cada framework (Laravel, etc.)',
  'schema.logging.label': 'Registro',
  'schema.logging.description': 'Registro en archivo y rotación',
  'schema.watch.label': 'Vigilante de archivos',
  'schema.watch.description': 'Reindexar automáticamente al cambiar archivos',

  'schema.f.enabled': 'Activado',
  'schema.f.baseUrl': 'URL base',
  'schema.f.apiKey': 'Clave de API',
  'schema.f.inferenceModel': 'Modelo de inferencia',
  'schema.f.fastModel': 'Modelo rápido',
  'schema.f.embeddingModel': 'Modelo de embeddings',
  'schema.f.rerankerModel': 'Modelo de reranking',
  'schema.f.autoDetect': 'Detectar los servidores automáticamente',
  'schema.f.batchSize': 'Tamaño de lote',

  'schema._root.auto_update.label': 'Actualización automática',
  'schema._root.interval.label': 'Intervalo entre comprobaciones (horas)',
  'schema._root.logLevel.label': 'Nivel de log del daemon',

  'schema.ai.provider.label': 'Proveedor',
  'schema.ai.provider.description':
    'onnx = local, sin configuración. ollama/lmstudio = local con elección de modelo. gemini = Google Generative Language API (consumo, clave AIza). vertex = Google Vertex AI (GCP, token OAuth + proyecto y ubicación). voyage = solo embeddings de Voyage AI. El resto = APIs en la nube.',
  'schema.ai.embedding.label': 'Usar embeddings',
  'schema.ai.embedding.description':
    'Generar vectores para la búsqueda semántica y el reranking. Desactívalo para apagar la búsqueda semántica y mantener la inferencia.',
  'schema.ai.inference.label': 'Usar inferencia',
  'schema.ai.inference.description':
    'Llamar al LLM para resúmenes, clasificación de intención y Preguntar. Desactívalo para saltarte todas las llamadas al LLM y mantener los embeddings.',
  'schema.ai.fast_inference.label': 'Usar inferencia rápida',
  'schema.ai.fast_inference.description':
    'Usar el modelo rápido en tareas de baja latencia. Si está apagado, quien use la vía rápida recibe respuestas vacías: déjalo encendido salvo que estés depurando.',

  'schema.ai.ollama.base_url.description':
    'Endpoint del servidor Ollama. Cámbialo si corre en otro host o puerto.',
  'schema.ai.lmstudio.base_url.description': 'Endpoint del servidor local de LM Studio.',
  'schema.ai.openai.base_url.description':
    'Endpoint de la API de OpenAI. Cámbialo para Azure OpenAI o proveedores compatibles.',
  'schema.ai.openai.api_key.description':
    'Obligatoria. O define la variable de entorno OPENAI_API_KEY.',
  'schema.ai.anthropic.api_key.description':
    'Clave de API de Anthropic, desde console.anthropic.com. O define la variable de entorno ANTHROPIC_API_KEY.',
  'schema.ai.gemini.api_key.description':
    'Clave de la Google Generative Language API, desde ai.google.dev (empieza por AIza). O define la variable de entorno GEMINI_API_KEY. Para GCP/Vertex usa el proveedor "vertex".',
  'schema.ai.vertex.api_key.label': 'Token de acceso',
  'schema.ai.vertex.api_key.description':
    'Token OAuth2 (de vida corta, ~1 h). Genéralo con: gcloud auth print-access-token. O define la variable de entorno GOOGLE_ACCESS_TOKEN.',
  'schema.ai.vertex.project.label': 'Proyecto de GCP',
  'schema.ai.vertex.project.description':
    'ID del proyecto de Google Cloud donde vive Vertex AI. O define la variable de entorno GOOGLE_CLOUD_PROJECT.',
  'schema.ai.vertex.location.label': 'Ubicación de GCP',
  'schema.ai.vertex.location.description':
    'Región de Vertex AI (p. ej. us-central1, europe-west4, asia-northeast1). O define la variable de entorno GOOGLE_CLOUD_LOCATION.',
  'schema.ai.voyage.base_url.description': 'Endpoint de Voyage AI. Normalmente el de por defecto.',
  'schema.ai.voyage.api_key.description':
    'Clave de API de Voyage, desde dash.voyageai.com. O define la variable de entorno VOYAGE_API_KEY. Solo embeddings, sin inferencia.',
  'schema.ai.mistral.base_url.description': 'Endpoint de la API de Mistral.',
  'schema.ai.mistral.api_key.description':
    'Clave de API de Mistral, desde console.mistral.ai. O define la variable de entorno MISTRAL_API_KEY.',
  'schema.ai.groq.base_url.description': 'Endpoint de la API de Groq.',
  'schema.ai.groq.api_key.description':
    'Clave de API de Groq, desde console.groq.com. O define la variable de entorno GROQ_API_KEY.',
  'schema.ai.together.base_url.description': 'Endpoint de la API de Together AI.',
  'schema.ai.together.api_key.description':
    'Clave de API de Together, desde api.together.ai. O define la variable de entorno TOGETHER_API_KEY.',
  'schema.ai.deepseek.base_url.description': 'Endpoint de la API de DeepSeek.',
  'schema.ai.deepseek.api_key.description':
    'Clave de API de DeepSeek, desde platform.deepseek.com. O define la variable de entorno DEEPSEEK_API_KEY.',
  'schema.ai.xai.base_url.description': 'Endpoint de la API de xAI (Grok).',
  'schema.ai.xai.api_key.description':
    'Clave de API de xAI, desde console.x.ai. O define la variable de entorno XAI_API_KEY.',

  'schema.ai.ollama.inference_model.description':
    'LLM para los resúmenes y la clasificación de intención.',
  'schema.ai.ollama.fast_model.description':
    'LLM más pequeño y rápido para tareas de baja latencia. Si no está, se usa el modelo de inferencia.',
  'schema.ai.ollama.embedding_model.description':
    'Modelo de embeddings para la búsqueda semántica. Debe cuadrar con embedding_dimensions.',
  'schema.ai.ollama.reranker_model.description':
    'Cross-encoder para reordenar los resultados de búsqueda.',
  'schema.ai.lmstudio.inference_model.description': 'LLM cargado en LM Studio.',
  'schema.ai.lmstudio.fast_model.description': 'LLM rápido para tareas de baja latencia.',
  'schema.ai.lmstudio.embedding_model.description': 'Modelo de embeddings cargado en LM Studio.',
  'schema.ai.openai.inference_model.description':
    'LLM para los resúmenes y la clasificación de intención.',
  'schema.ai.openai.fast_model.description':
    'LLM más rápido y barato. Si no está, se usa el modelo de inferencia.',
  'schema.ai.openai.embedding_model.description':
    'text-embedding-3-small (barato) o text-embedding-3-large (preciso).',
  'schema.ai.anthropic.inference_model.description':
    'Modelo de Claude para los resúmenes y el razonamiento.',
  'schema.ai.anthropic.fast_model.description':
    'El modelo de Claude más rápido, para tareas de baja latencia.',
  'schema.ai.gemini.inference_model.description': 'Modelo de Gemini para los resúmenes.',
  'schema.ai.gemini.fast_model.description':
    'Modelo rápido de Gemini para tareas de baja latencia.',
  'schema.ai.gemini.embedding_model.description':
    'Modelo de embeddings de Gemini. Se recomienda text-embedding-004 (768d).',
  'schema.ai.vertex.inference_model.description':
    'Modelo alojado en Vertex para los resúmenes (p. ej. gemini-2.5-flash, gemini-2.5-pro).',
  'schema.ai.vertex.fast_model.description':
    'Modelo rápido de Vertex para tareas de baja latencia.',
  'schema.ai.vertex.embedding_model.description':
    'Modelo de embeddings de Vertex (p. ej. text-embedding-005 768d, gemini-embedding-001 3072d).',
  'schema.ai.voyage.embedding_model.description':
    'Modelo de embeddings de Voyage. voyage-code-3 (1024d) está afinado para código.',
  'schema.ai.mistral.inference_model.description': 'LLM de Mistral para los resúmenes.',
  'schema.ai.mistral.fast_model.description': 'Modelo rápido de Mistral.',
  'schema.ai.mistral.embedding_model.description': 'Modelo de embeddings de Mistral (1024d).',
  'schema.ai.groq.inference_model.description': 'LLM alojado en Groq. Inferencia ultrarrápida.',
  'schema.ai.groq.fast_model.description':
    'El modelo de Groq más rápido, para tareas de baja latencia.',
  'schema.ai.groq.embedding_model.description': 'Modelo de embeddings de Groq.',
  'schema.ai.together.inference_model.description': 'LLM alojado en Together.',
  'schema.ai.together.fast_model.description': 'Modelo rápido de Together.',
  'schema.ai.together.embedding_model.description': 'Modelo de embeddings de Together.',
  'schema.ai.deepseek.inference_model.description':
    'DeepSeek V3 para los resúmenes y el razonamiento.',
  'schema.ai.deepseek.fast_model.description': 'Modelo rápido de DeepSeek.',
  'schema.ai.xai.inference_model.description': 'Modelo Grok para los resúmenes.',
  'schema.ai.xai.fast_model.description': 'Modelo rápido de Grok.',
  'schema.ai.onnx.embedding_model.description':
    'Modelo ONNX para embeddings locales. El de por defecto funciona sin tocar nada.',

  'schema.ai.dimensions.label': 'Dimensiones del embedding',
  'schema.ai.dimensions.description':
    'Tamaño del vector. Debe cuadrar con el modelo (384 para MiniLM, 768 para nomic/Gemini/Vertex text-embedding-005, 1024 para Mistral/voyage-code-3, 1536 para OpenAI, 3072 para gemini-embedding-001).',
  'schema.ai.summarize.label': 'Resumir al indexar',
  'schema.ai.summarize.description':
    'Generar resúmenes en lenguaje natural durante la indexación. Requiere un proveedor con modelo de inferencia.',
  'schema.ai.summarize_batch.label': 'Tamaño de lote de resúmenes',
  'schema.ai.summarize_batch.description': 'Símbolos que se resumen en paralelo por lote.',
  'schema.ai.summarize_kinds.label': 'Tipos que resumir',
  'schema.ai.summarize_kinds.description': 'Para qué tipos de símbolo se generan resúmenes.',
  'schema.ai.concurrency.label': 'Concurrencia',
  'schema.ai.concurrency.description':
    'Peticiones de IA en paralelo. Con Ollama, hazlo coincidir con OLLAMA_NUM_PARALLEL.',

  'schema.security.secret_patterns.label': 'Patrones de secretos',
  'schema.security.max_file_size.label': 'Tamaño máximo de archivo (bytes)',
  'schema.security.max_files.label': 'Máximo de archivos por proyecto',

  'schema.predictive.cache_ttl.label': 'TTL de caché (minutos)',
  'schema.predictive.git_since.label': 'Historial de git (días)',
  'schema.predictive.module_depth.label': 'Profundidad de módulos',
  'schema.predictive.weights.label': 'Pesos',
  'schema.predictive.weights.description':
    'Pesos de puntuación de fallos, deuda técnica y riesgo',

  'schema.intent.auto_classify.label': 'Clasificar automáticamente al indexar',
  'schema.intent.domain_hints.label': 'Pistas de dominio',
  'schema.intent.domain_hints.description': '{ "domain": ["path/**"] }',
  'schema.intent.custom_domains.label': 'Dominios propios',
  'schema.intent.custom_domains.description': '[{ name, path_patterns }]',

  'schema.runtime.port.label': 'Puerto OTLP',
  'schema.runtime.host.label': 'Host OTLP',
  'schema.runtime.max_body.label': 'Bytes máximos de cuerpo',
  'schema.runtime.max_span_age.label': 'Antigüedad máxima de span (días)',
  'schema.runtime.max_aggregate_age.label': 'Antigüedad máxima de agregado (días)',
  'schema.runtime.prune_interval.label': 'Intervalo de purga',
  'schema.runtime.fqn_attributes.label': 'Atributos FQN',
  'schema.runtime.route_patterns.label': 'Patrones de ruta',

  'schema.topology.auto_detect.label': 'Detectar repos automáticamente',
  'schema.topology.auto_discover.label': 'Descubrir subproyectos automáticamente',
  'schema.topology.repos.label': 'Rutas de repos adicionales',
  'schema.topology.contract_globs.label': 'Globs de contratos',

  'schema.lsp.enabled.description': 'Activar la pasada de enriquecimiento LSP tras la indexación',
  'schema.lsp.auto_detect.description':
    'Detectar automáticamente los servidores LSP disponibles (tsserver, pyright, gopls, rust-analyzer)',
  'schema.lsp.max_servers.label': 'Máximo de servidores simultáneos',
  'schema.lsp.max_servers.description': 'Limita los procesos de servidor LSP en paralelo',
  'schema.lsp.timeout.label': 'Tiempo límite del enriquecimiento (ms)',
  'schema.lsp.timeout.description': 'Tiempo límite total de la pasada de enriquecimiento LSP',
  'schema.lsp.batch_size.description': 'Símbolos procesados por lote',
  'schema.lsp.servers.label': 'Ajustes propios de servidor',
  'schema.lsp.servers.description':
    '{ "typescript": { "command": "npx", "args": ["typescript-language-server", "--stdio"], "timeout_ms": 30000 } }',

  'schema.quality_gates.fail_on.label': 'Fallar si',
  'schema.quality_gates.rules.label': 'Reglas',
  'schema.quality_gates.rules.description': 'Umbrales y severidades de las reglas',

  'schema.tools.preset.label': 'Preajuste',
  'schema.tools.include.label': 'Herramientas incluidas',
  'schema.tools.exclude.label': 'Herramientas excluidas',
  'schema.tools.description_verbosity.label': 'Detalle de las descripciones',
  'schema.tools.instructions_verbosity.label': 'Detalle de las instrucciones',
  'schema.tools.meta_fields.label': 'Campos meta',
  'schema.tools.compact_schemas.label': 'Esquemas compactos',
  'schema.tools.compact_schemas.description':
    'Quitar los parámetros avanzados de los esquemas de herramientas para reducir el coste en tokens (~42 %)',
  'schema.tools.descriptions.label': 'Descripciones propias',
  'schema.tools.descriptions.description': '{ "tool_name": "description" }',

  'schema.ignore.directories.label': 'Directorios',
  'schema.ignore.patterns.label': 'Patrones',

  'schema.frameworks.config.label': 'Configuración',
  'schema.frameworks.config.description': 'Ajustes propios de cada framework',

  'schema.logging.file.label': 'Registrar en archivo',
  'schema.logging.path.label': 'Ruta del archivo de log',
  'schema.logging.level.label': 'Nivel de log',
  'schema.logging.max_size.label': 'Tamaño máximo del log (MB)',

  'schema.watch.debounce.label': 'Debounce (ms)',
} as const;
