export const settings = {
  title: 'Configurações',
  back: 'Voltar',
  moreActions: 'Mais ações',
  search: 'Buscar nas configurações',
  copyDaemon: 'Copiar os dados do daemon',
  editConfigFile: 'Editar o arquivo de configuração…',
  noMatches: 'Nenhuma configuração corresponde a “{{query}}”.',

  'group.general': 'Geral',
  'group.intelligence': 'Inteligência',
  'group.quality': 'Qualidade e segurança',
  'group.infrastructure': 'Infraestrutura',
  'group.development': 'Desenvolvimento',
  'group.monitoring': 'Monitoramento',
  'group.advanced': 'Avançado',

  'daemon.title': 'Daemon',
  'daemon.state': 'Em execução',
  'daemon.summary': 'Em execução · porta {{port}} · no ar há {{uptime}}',
  'uptime.seconds': '{{value}} s',
  'uptime.minutes': '{{value}} min',
  'uptime.hours': '{{value}} h',
  'uptime.hoursMinutes': '{{hours}} h {{minutes}} min',

  'app.title': 'App',
  'app.language': 'Idioma',
  'appearance.theme': 'Tema',

  'empty.loading': 'Carregando configurações…',
  'empty.unreadableTitle': 'Não foi possível ler as configurações',
  'empty.unreadableBody':
    'O daemon está em execução, mas não devolveu a configuração dele. Reiniciá-lo costuma resolver.',
  'empty.unreachableTitle': 'Daemon inacessível',
  'empty.unreachableBody':
    'As configurações ficam no arquivo de configuração do daemon, então só dá para lê-las com ele em execução.',
  'empty.starting': 'Iniciando…',
  'empty.restart': 'Reiniciar o daemon',
  'empty.start': 'Iniciar o daemon',

  modified: 'Modificado',
  issues_one: '{{count}} problema',
  issues_many: '{{count}} de problemas',
  issues_other: '{{count}} problemas',

  reset: 'Restaurar',
  resetSection: 'Restaurar esta seção aos padrões',
  notSet: 'Não definido',
  'field.aria': '{{label}}: {{value}}',
  'field.ariaUnset': '{{label}}: não definido',
  invalidJson: 'JSON inválido',

  'models.select': 'Selecionar modelo…',
  'models.filter': 'Filtrar modelos',
  'models.loading': 'Carregando modelos…',
  'models.retry': 'Tentar de novo',
  'models.none': 'Nenhum modelo encontrado',
  'models.noMatches': 'Nenhuma correspondência',
  'models.clear': 'Limpar seleção',
  'models.type': 'Ou digite o nome de um modelo…',
  'models.typeAria': 'Digite o nome de um modelo',
  'models.failed': 'Falha ao buscar os modelos',
  'models.httpError': '{{provider}}: {{status}}',
  'models.authError': '{{provider}}: {{status}} (confira a chave de API)',

  'projects.title': 'Ajustes por projeto',
  'projects.intro':
    'Sobrescreva as configurações globais para projetos específicos. Os valores se somam por cima da configuração global.',
  'projects.done': 'Concluído',
  'projects.edit': 'Editar',
  'projects.remove': 'Remover',
  'projects.apply': 'Aplicar',
  'projects.add': 'Adicionar',
  'projects.pathAria': 'Caminho do projeto',
  'projects.overridesAria': 'Ajustes para {{path}}',

  'diff.title': 'Alterações pendentes',
  'diff.hide': 'Ocultar',
  'bar.hasErrors': 'Corrija os problemas acima antes de salvar',
  'bar.saved': 'Salvo',
  'bar.saveFailed': 'Não foi possível salvar — o daemon recusou a alteração',
  'bar.unsaved_one': '{{count}} alteração não salva',
  'bar.unsaved_many': '{{count}} de alterações não salvas',
  'bar.unsaved_other': '{{count}} alterações não salvas',
  'bar.hideChanges': 'Ocultar alterações',
  'bar.reviewChanges': 'Revisar alterações',
  'bar.discard': 'Descartar',
  'bar.saving': 'Salvando…',
  'bar.save': 'Salvar',

  'activity.title': 'Atividade de IA',
  'activity.armed': 'A próxima janela de projeto que você abrir vai cair em Atividade → Chamadas de IA.',
  'activity.idle':
    'As requisições recentes de embedding, LLM e reordenação ficam numa janela de projeto, em Atividade.',
  'activity.ready': 'Pronto',
  'activity.open': 'Abrir lá da próxima vez',

  'validate.boolean': 'Deve ser true ou false',
  'validate.number': 'Deve ser um número',
  'validate.min': 'Mín.: {{min}}',
  'validate.max': 'Máx.: {{max}}',
  'validate.string': 'Deve ser um texto',
  'validate.tooLong': 'Longo demais (máx. {{max}} caracteres)',
  'validate.pattern': 'Deve corresponder a: {{pattern}}',
  'validate.oneOf': 'Deve ser um destes: {{options}}',
  'validate.list': 'Deve ser uma lista',
  'validate.json': 'Deve ser um JSON válido (não um texto)',

  'schema._root.label': 'Geral',
  'schema._root.description': 'Atualização automática e configurações de primeiro nível',
  'schema.ai.label': 'IA e embeddings',
  'schema.ai.description':
    'Provedor de IA para busca semântica, resumos e classificação de intenção',
  'schema.security.label': 'Segurança',
  'schema.security.description': 'Detecção de segredos e limites de arquivo',
  'schema.predictive.label': 'Análise preditiva',
  'schema.predictive.description': 'Previsão de bugs, dívida técnica e risco de mudança',
  'schema.intent.label': 'Intenção e domínios',
  'schema.intent.description': 'Classificação de domínios e marcação automática',
  'schema.runtime.label': 'Tracing em execução (OTLP)',
  'schema.runtime.description': 'Ingestão de spans OpenTelemetry e análise de traces',
  'schema.topology.label': 'Topologia entre repositórios',
  'schema.topology.description': 'Subprojetos e dependências entre serviços',
  'schema.lsp.label': 'Enriquecimento por LSP',
  'schema.lsp.description':
    'Resolução do grafo de chamadas com precisão de compilador via Language Server Protocol',
  'schema.quality_gates.label': 'Quality gates',
  'schema.quality_gates.description': 'Verificações automáticas de qualidade em commits e PRs',
  'schema.tools.label': 'Exposição de ferramentas',
  'schema.tools.description': 'Controle de quais ferramentas MCP são expostas e como',
  'schema.ignore.label': 'Regras de exclusão',
  'schema.ignore.description': 'Diretórios e padrões extras a pular durante a indexação',
  'schema.frameworks.label': 'Frameworks',
  'schema.frameworks.description': 'Configurações por framework (Laravel etc.)',
  'schema.logging.label': 'Logs',
  'schema.logging.description': 'Log em arquivo e rotação',
  'schema.watch.label': 'Monitor de arquivos',
  'schema.watch.description': 'Reindexação automática ao mudar arquivos',

  'schema.f.enabled': 'Ativado',
  'schema.f.baseUrl': 'URL base',
  'schema.f.apiKey': 'Chave de API',
  'schema.f.inferenceModel': 'Modelo de inferência',
  'schema.f.fastModel': 'Modelo rápido',
  'schema.f.embeddingModel': 'Modelo de embedding',
  'schema.f.rerankerModel': 'Modelo de reordenação',
  'schema.f.autoDetect': 'Detectar servidores automaticamente',
  'schema.f.batchSize': 'Tamanho do lote',

  'schema._root.auto_update.label': 'Atualização automática',
  'schema._root.interval.label': 'Intervalo de verificação de atualizações (horas)',
  'schema._root.logLevel.label': 'Nível de log do daemon',

  'schema.ai.provider.label': 'Provedor',
  'schema.ai.provider.description':
    'onnx = local, sem configuração. ollama/lmstudio = local com escolha de modelo. gemini = Google Generative Language API (consumidor, chave AIza). vertex = Google Vertex AI (GCP, token bearer OAuth + projeto/região). voyage = somente embeddings da Voyage AI. Demais = APIs na nuvem.',
  'schema.ai.embedding.label': 'Usar embeddings',
  'schema.ai.embedding.description':
    'Gerar embeddings vetoriais para busca semântica e reordenação. Desligue para desativar a busca semântica mantendo a inferência.',
  'schema.ai.inference.label': 'Usar inferência',
  'schema.ai.inference.description':
    'Chamar a LLM para resumos, classificação de intenção e o Perguntar. Desligue para pular todas as chamadas de LLM mantendo os embeddings.',
  'schema.ai.fast_inference.label': 'Usar inferência rápida',
  'schema.ai.fast_inference.description':
    'Usar o modelo rápido em tarefas de baixa latência. Desligado, quem usa o caminho rápido recebe respostas vazias — deixe ligado, exceto ao depurar.',

  'schema.ai.ollama.base_url.description':
    'Endpoint do servidor Ollama. Altere se ele roda em outro host ou porta.',
  'schema.ai.lmstudio.base_url.description': 'Endpoint do servidor local do LM Studio.',
  'schema.ai.openai.base_url.description':
    'Endpoint da API da OpenAI. Altere para Azure OpenAI ou provedores compatíveis.',
  'schema.ai.openai.api_key.description': 'Obrigatória. Ou defina a variável OPENAI_API_KEY.',
  'schema.ai.anthropic.api_key.description':
    'Chave de API da Anthropic, em console.anthropic.com. Ou defina a variável ANTHROPIC_API_KEY.',
  'schema.ai.gemini.api_key.description':
    'Chave da Google Generative Language API, em ai.google.dev (começa com AIza). Ou defina a variável GEMINI_API_KEY. Para GCP/Vertex, use o provedor "vertex".',
  'schema.ai.vertex.api_key.label': 'Token de acesso',
  'schema.ai.vertex.api_key.description':
    'Token bearer OAuth2 (curta duração, ~1 h). Gere com: gcloud auth print-access-token. Ou defina a variável GOOGLE_ACCESS_TOKEN.',
  'schema.ai.vertex.project.label': 'Projeto GCP',
  'schema.ai.vertex.project.description':
    'ID do projeto do Google Cloud que hospeda o Vertex AI. Ou defina a variável GOOGLE_CLOUD_PROJECT.',
  'schema.ai.vertex.location.label': 'Região GCP',
  'schema.ai.vertex.location.description':
    'Região do Vertex AI (ex.: us-central1, europe-west4, asia-northeast1). Ou defina a variável GOOGLE_CLOUD_LOCATION.',
  'schema.ai.voyage.base_url.description': 'Endpoint da Voyage AI. Normalmente o padrão.',
  'schema.ai.voyage.api_key.description':
    'Chave de API da Voyage, em dash.voyageai.com. Ou defina a variável VOYAGE_API_KEY. Somente embeddings — sem inferência.',
  'schema.ai.mistral.base_url.description': 'Endpoint da API da Mistral.',
  'schema.ai.mistral.api_key.description':
    'Chave de API da Mistral, em console.mistral.ai. Ou defina a variável MISTRAL_API_KEY.',
  'schema.ai.groq.base_url.description': 'Endpoint da API da Groq.',
  'schema.ai.groq.api_key.description':
    'Chave de API da Groq, em console.groq.com. Ou defina a variável GROQ_API_KEY.',
  'schema.ai.together.base_url.description': 'Endpoint da API da Together AI.',
  'schema.ai.together.api_key.description':
    'Chave de API da Together, em api.together.ai. Ou defina a variável TOGETHER_API_KEY.',
  'schema.ai.deepseek.base_url.description': 'Endpoint da API da DeepSeek.',
  'schema.ai.deepseek.api_key.description':
    'Chave de API da DeepSeek, em platform.deepseek.com. Ou defina a variável DEEPSEEK_API_KEY.',
  'schema.ai.xai.base_url.description': 'Endpoint da API da xAI (Grok).',
  'schema.ai.xai.api_key.description':
    'Chave de API da xAI, em console.x.ai. Ou defina a variável XAI_API_KEY.',

  'schema.ai.ollama.inference_model.description':
    'LLM para resumos e classificação de intenção.',
  'schema.ai.ollama.fast_model.description':
    'LLM menor/mais rápida para tarefas de baixa latência. Recorre ao modelo de inferência.',
  'schema.ai.ollama.embedding_model.description':
    'Modelo de embedding para busca semântica. Precisa bater com embedding_dimensions.',
  'schema.ai.ollama.reranker_model.description':
    'Cross-encoder para reordenar os resultados da busca.',
  'schema.ai.lmstudio.inference_model.description': 'LLM carregada no LM Studio.',
  'schema.ai.lmstudio.fast_model.description': 'LLM rápida para tarefas de baixa latência.',
  'schema.ai.lmstudio.embedding_model.description': 'Modelo de embedding carregado no LM Studio.',
  'schema.ai.openai.inference_model.description':
    'LLM para resumos e classificação de intenção.',
  'schema.ai.openai.fast_model.description':
    'LLM mais rápida/barata. Recorre ao modelo de inferência.',
  'schema.ai.openai.embedding_model.description':
    'text-embedding-3-small (barato) ou text-embedding-3-large (preciso).',
  'schema.ai.anthropic.inference_model.description':
    'Modelo Claude para resumos e raciocínio.',
  'schema.ai.anthropic.fast_model.description':
    'Modelo Claude mais rápido para tarefas de baixa latência.',
  'schema.ai.gemini.inference_model.description': 'Modelo Gemini para resumos.',
  'schema.ai.gemini.fast_model.description':
    'Modelo Gemini rápido para tarefas de baixa latência.',
  'schema.ai.gemini.embedding_model.description':
    'Modelo de embedding do Gemini. Recomenda-se o text-embedding-004 (768d).',
  'schema.ai.vertex.inference_model.description':
    'Modelo hospedado no Vertex para resumos (ex.: gemini-2.5-flash, gemini-2.5-pro).',
  'schema.ai.vertex.fast_model.description':
    'Modelo Vertex rápido para tarefas de baixa latência.',
  'schema.ai.vertex.embedding_model.description':
    'Modelo de embedding do Vertex (ex.: text-embedding-005 768d, gemini-embedding-001 3072d).',
  'schema.ai.voyage.embedding_model.description':
    'Modelo de embedding da Voyage. O voyage-code-3 (1024d) é ajustado para código-fonte.',
  'schema.ai.mistral.inference_model.description': 'LLM da Mistral para resumos.',
  'schema.ai.mistral.fast_model.description': 'Modelo Mistral rápido.',
  'schema.ai.mistral.embedding_model.description': 'Modelo de embedding da Mistral (1024d).',
  'schema.ai.groq.inference_model.description': 'LLM hospedada na Groq. Inferência ultrarrápida.',
  'schema.ai.groq.fast_model.description':
    'Modelo Groq mais rápido para tarefas de baixa latência.',
  'schema.ai.groq.embedding_model.description': 'Modelo de embedding da Groq.',
  'schema.ai.together.inference_model.description': 'LLM hospedada na Together.',
  'schema.ai.together.fast_model.description': 'Modelo Together rápido.',
  'schema.ai.together.embedding_model.description': 'Modelo de embedding da Together.',
  'schema.ai.deepseek.inference_model.description': 'DeepSeek V3 para resumos e raciocínio.',
  'schema.ai.deepseek.fast_model.description': 'Modelo rápido da DeepSeek.',
  'schema.ai.xai.inference_model.description': 'Modelo Grok para resumos.',
  'schema.ai.xai.fast_model.description': 'Modelo Grok rápido.',
  'schema.ai.onnx.embedding_model.description':
    'Modelo ONNX para embeddings locais. O padrão já funciona.',

  'schema.ai.dimensions.label': 'Dimensões do embedding',
  'schema.ai.dimensions.description':
    'Tamanho do vetor. Precisa bater com o modelo (384 para MiniLM, 768 para nomic/Gemini/Vertex text-embedding-005, 1024 para Mistral/voyage-code-3, 1536 para OpenAI, 3072 para gemini-embedding-001).',
  'schema.ai.summarize.label': 'Resumir ao indexar',
  'schema.ai.summarize.description':
    'Gerar resumos em linguagem natural durante a indexação. Exige um provedor com modelo de inferência.',
  'schema.ai.summarize_batch.label': 'Tamanho do lote de resumo',
  'schema.ai.summarize_batch.description': 'Símbolos resumidos em paralelo por lote.',
  'schema.ai.summarize_kinds.label': 'Tipos a resumir',
  'schema.ai.summarize_kinds.description': 'Para quais tipos de símbolo gerar resumos.',
  'schema.ai.concurrency.label': 'Concorrência',
  'schema.ai.concurrency.description':
    'Requisições de IA em paralelo. No Ollama, use o mesmo valor de OLLAMA_NUM_PARALLEL.',

  'schema.security.secret_patterns.label': 'Padrões de segredo',
  'schema.security.max_file_size.label': 'Tamanho máx. de arquivo (bytes)',
  'schema.security.max_files.label': 'Máx. de arquivos por projeto',

  'schema.predictive.cache_ttl.label': 'TTL do cache (minutos)',
  'schema.predictive.git_since.label': 'Histórico do git (dias)',
  'schema.predictive.module_depth.label': 'Profundidade de módulo',
  'schema.predictive.weights.label': 'Pesos',
  'schema.predictive.weights.description': 'Pesos das pontuações de bug/dívida/risco',

  'schema.intent.auto_classify.label': 'Classificar automaticamente ao indexar',
  'schema.intent.domain_hints.label': 'Dicas de domínio',
  'schema.intent.domain_hints.description': '{ "domain": ["path/**"] }',
  'schema.intent.custom_domains.label': 'Domínios personalizados',
  'schema.intent.custom_domains.description': '[{ name, path_patterns }]',

  'schema.runtime.port.label': 'Porta OTLP',
  'schema.runtime.host.label': 'Host OTLP',
  'schema.runtime.max_body.label': 'Máx. de bytes no corpo',
  'schema.runtime.max_span_age.label': 'Idade máx. do span (dias)',
  'schema.runtime.max_aggregate_age.label': 'Idade máx. do agregado (dias)',
  'schema.runtime.prune_interval.label': 'Intervalo de limpeza',
  'schema.runtime.fqn_attributes.label': 'Atributos de FQN',
  'schema.runtime.route_patterns.label': 'Padrões de rota',

  'schema.topology.auto_detect.label': 'Detectar repositórios automaticamente',
  'schema.topology.auto_discover.label': 'Descobrir subprojetos automaticamente',
  'schema.topology.repos.label': 'Caminhos extras de repositório',
  'schema.topology.contract_globs.label': 'Globs de contrato',

  'schema.lsp.enabled.description': 'Ativar a passagem de enriquecimento por LSP após a indexação',
  'schema.lsp.auto_detect.description':
    'Detectar automaticamente os servidores LSP disponíveis (tsserver, pyright, gopls, rust-analyzer)',
  'schema.lsp.max_servers.label': 'Máx. de servidores simultâneos',
  'schema.lsp.max_servers.description': 'Limitar os processos de servidor LSP em paralelo',
  'schema.lsp.timeout.label': 'Tempo limite do enriquecimento (ms)',
  'schema.lsp.timeout.description': 'Tempo limite total da passagem de enriquecimento por LSP',
  'schema.lsp.batch_size.description': 'Símbolos processados por lote',
  'schema.lsp.servers.label': 'Ajustes de servidor',
  'schema.lsp.servers.description':
    '{ "typescript": { "command": "npx", "args": ["typescript-language-server", "--stdio"], "timeout_ms": 30000 } }',

  'schema.quality_gates.fail_on.label': 'Falhar em',
  'schema.quality_gates.rules.label': 'Regras',
  'schema.quality_gates.rules.description': 'Limites e severidades das regras',

  'schema.tools.preset.label': 'Preset',
  'schema.tools.include.label': 'Incluir ferramentas',
  'schema.tools.exclude.label': 'Excluir ferramentas',
  'schema.tools.description_verbosity.label': 'Detalhamento das descrições',
  'schema.tools.instructions_verbosity.label': 'Detalhamento das instruções',
  'schema.tools.meta_fields.label': 'Campos de metadados',
  'schema.tools.compact_schemas.label': 'Esquemas compactos',
  'schema.tools.compact_schemas.description':
    'Remover os parâmetros avançados dos esquemas das ferramentas para reduzir o custo em tokens (~42%)',
  'schema.tools.descriptions.label': 'Descrições personalizadas',
  'schema.tools.descriptions.description': '{ "tool_name": "description" }',

  'schema.ignore.directories.label': 'Diretórios',
  'schema.ignore.patterns.label': 'Padrões',

  'schema.frameworks.config.label': 'Configuração',
  'schema.frameworks.config.description': 'Ajustes por framework',

  'schema.logging.file.label': 'Ativar log em arquivo',
  'schema.logging.path.label': 'Caminho do arquivo de log',
  'schema.logging.level.label': 'Nível de log',
  'schema.logging.max_size.label': 'Tamanho máx. do log (MB)',

  'schema.watch.debounce.label': 'Debounce (ms)',
} as const;
