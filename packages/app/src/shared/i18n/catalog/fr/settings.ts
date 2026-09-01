export const settings = {
  title: 'Réglages',
  back: 'Retour',
  moreActions: 'Plus d’actions',
  search: 'Rechercher dans les réglages',
  copyDaemon: 'Copier les infos du démon',
  editConfigFile: 'Modifier le fichier de config…',
  noMatches: 'Aucun réglage ne correspond à « {{query}} ».',

  'group.general': 'Général',
  'group.intelligence': 'Intelligence',
  'group.quality': 'Qualité et sécurité',
  'group.infrastructure': 'Infrastructure',
  'group.development': 'Développement',
  'group.monitoring': 'Supervision',
  'group.advanced': 'Avancé',

  'daemon.title': 'Démon',
  'daemon.state': 'En cours',
  'daemon.summary': 'En cours · port {{port}} · actif depuis {{uptime}}',
  'uptime.seconds': '{{value}} s',
  'uptime.minutes': '{{value}} min',
  'uptime.hours': '{{value}} h',
  'uptime.hoursMinutes': '{{hours}} h {{minutes}} min',

  'app.title': 'App',
  'app.language': 'Langue',
  'appearance.theme': 'Thème',

  'empty.loading': 'Chargement des réglages…',
  'empty.unreadableTitle': 'Impossible de lire les réglages',
  'empty.unreadableBody':
    'Le démon tourne mais n’a pas renvoyé sa configuration. Le redémarrer règle généralement le problème.',
  'empty.unreachableTitle': 'Démon injoignable',
  'empty.unreachableBody':
    'Les réglages sont dans le fichier de config du démon : ils ne peuvent pas être lus tant qu’il ne tourne pas.',
  'empty.starting': 'Démarrage…',
  'empty.restart': 'Redémarrer le démon',
  'empty.start': 'Démarrer le démon',

  modified: 'Modifié',
  issues_one: '{{count}} problème',
  issues_many: '{{count}} problèmes',
  issues_other: '{{count}} problèmes',

  reset: 'Réinitialiser',
  resetSection: 'Rétablir les valeurs par défaut de cette section',
  notSet: 'Non défini',
  'field.aria': '{{label}} : {{value}}',
  'field.ariaUnset': '{{label}} : non défini',
  invalidJson: 'JSON invalide',

  'models.select': 'Choisir un modèle…',
  'models.filter': 'Filtrer les modèles',
  'models.loading': 'Chargement des modèles…',
  'models.retry': 'Réessayer',
  'models.none': 'Aucun modèle trouvé',
  'models.noMatches': 'Aucune correspondance',
  'models.clear': 'Effacer la sélection',
  'models.type': 'Ou saisissez un nom de modèle…',
  'models.typeAria': 'Saisir un nom de modèle',
  'models.failed': 'Échec de la récupération des modèles',
  'models.httpError': '{{provider}} : {{status}}',
  'models.authError': '{{provider}} : {{status}} (vérifiez la clé API)',

  'projects.title': 'Réglages par projet',
  'projects.intro':
    'Remplacez les réglages globaux pour certains projets. Les valeurs se superposent à la config globale.',
  'projects.done': 'Terminé',
  'projects.edit': 'Modifier',
  'projects.remove': 'Retirer',
  'projects.apply': 'Appliquer',
  'projects.add': 'Ajouter',
  'projects.pathAria': 'Chemin du projet',
  'projects.overridesAria': 'Réglages spécifiques à {{path}}',

  'diff.title': 'Modifications en attente',
  'diff.hide': 'Masquer',
  'bar.hasErrors': 'Corrigez les problèmes ci-dessus avant d’enregistrer',
  'bar.saved': 'Enregistré',
  'bar.saveFailed': 'Enregistrement impossible — le démon a rejeté la modification',
  'bar.unsaved_one': '{{count}} modification non enregistrée',
  'bar.unsaved_many': '{{count}} modifications non enregistrées',
  'bar.unsaved_other': '{{count}} modifications non enregistrées',
  'bar.hideChanges': 'Masquer les modifications',
  'bar.reviewChanges': 'Revoir les modifications',
  'bar.discard': 'Abandonner',
  'bar.saving': 'Enregistrement…',
  'bar.save': 'Enregistrer',

  'activity.title': 'Activité IA',
  'activity.armed':
    'La prochaine fenêtre de projet que vous ouvrirez s’ouvrira sur Activité → Appels IA.',
  'activity.idle':
    'Les requêtes récentes d’embedding, de LLM et de reclassement sont dans une fenêtre de projet, sous Activité.',
  'activity.ready': 'Prêt',
  'activity.open': 'Ouvrir là au prochain lancement',

  'validate.boolean': 'Doit être true ou false',
  'validate.number': 'Doit être un nombre',
  'validate.min': 'Min : {{min}}',
  'validate.max': 'Max : {{max}}',
  'validate.string': 'Doit être une chaîne',
  'validate.tooLong': 'Trop long (max {{max}} caractères)',
  'validate.pattern': 'Doit correspondre à : {{pattern}}',
  'validate.oneOf': 'Doit être l’une de ces valeurs : {{options}}',
  'validate.list': 'Doit être une liste',
  'validate.json': 'Doit être du JSON valide (pas une chaîne)',

  'schema._root.label': 'Général',
  'schema._root.description': 'Mise à jour automatique et réglages de premier niveau',
  'schema.ai.label': 'IA et embeddings',
  'schema.ai.description':
    'Fournisseur IA pour la recherche sémantique, les résumés et la classification d’intention',
  'schema.security.label': 'Sécurité',
  'schema.security.description': 'Détection de secrets et limites de fichiers',
  'schema.predictive.label': 'Analyse prédictive',
  'schema.predictive.description':
    'Prédiction de bugs, score de dette technique, risque de changement',
  'schema.intent.label': 'Intention et domaines',
  'schema.intent.description': 'Classification par domaine et étiquetage automatique',
  'schema.runtime.label': 'Traçage à l’exécution (OTLP)',
  'schema.runtime.description': 'Réception des spans OpenTelemetry et analyse des traces',
  'schema.topology.label': 'Topologie inter-dépôts',
  'schema.topology.description': 'Sous-projets et suivi des dépendances entre services',
  'schema.lsp.label': 'Enrichissement LSP',
  'schema.lsp.description':
    'Résolution du graphe d’appels au niveau du compilateur via Language Server Protocol',
  'schema.quality_gates.label': 'Portes de qualité',
  'schema.quality_gates.description':
    'Contrôles de qualité automatiques sur les commits et les PR',
  'schema.tools.label': 'Exposition des outils',
  'schema.tools.description': 'Choisir quels outils MCP sont exposés et comment',
  'schema.ignore.label': 'Règles d’exclusion',
  'schema.ignore.description':
    'Répertoires et motifs supplémentaires à ignorer pendant l’indexation',
  'schema.frameworks.label': 'Frameworks',
  'schema.frameworks.description': 'Réglages propres aux frameworks (Laravel, etc.)',
  'schema.logging.label': 'Journalisation',
  'schema.logging.description': 'Journalisation dans un fichier et rotation',
  'schema.watch.label': 'Surveillance des fichiers',
  'schema.watch.description': 'Réindexation automatique à la modification des fichiers',

  'schema.f.enabled': 'Activé',
  'schema.f.baseUrl': 'URL de base',
  'schema.f.apiKey': 'Clé API',
  'schema.f.inferenceModel': 'Modèle d’inférence',
  'schema.f.fastModel': 'Modèle rapide',
  'schema.f.embeddingModel': 'Modèle d’embedding',
  'schema.f.rerankerModel': 'Modèle de reclassement',
  'schema.f.autoDetect': 'Détecter les serveurs automatiquement',
  'schema.f.batchSize': 'Taille des lots',

  'schema._root.auto_update.label': 'Mise à jour automatique',
  'schema._root.interval.label': 'Intervalle de vérification des mises à jour (heures)',
  'schema._root.logLevel.label': 'Niveau de journal du démon',

  'schema.ai.provider.label': 'Fournisseur',
  'schema.ai.provider.description':
    'onnx = local, sans configuration. ollama/lmstudio = local avec choix du modèle. gemini = Google Generative Language API (grand public, clé AIza). vertex = Google Vertex AI (GCP, jeton OAuth + projet/région). voyage = embeddings Voyage AI uniquement. Les autres = API cloud.',
  'schema.ai.embedding.label': 'Utiliser les embeddings',
  'schema.ai.embedding.description':
    'Générer des vecteurs pour la recherche sémantique et le reclassement. Désactivez pour couper la recherche sémantique tout en gardant l’inférence.',
  'schema.ai.inference.label': 'Utiliser l’inférence',
  'schema.ai.inference.description':
    'Appeler le LLM pour les résumés, la classification d’intention et Ask. Désactivez pour éviter tout appel LLM tout en gardant les embeddings.',
  'schema.ai.fast_inference.label': 'Utiliser l’inférence rapide',
  'schema.ai.fast_inference.description':
    'Utiliser le modèle rapide pour les tâches à faible latence. Désactivé, les appelants du chemin rapide reçoivent des réponses vides — laissez activé sauf en débogage.',

  'schema.ai.ollama.base_url.description':
    'Point d’accès du serveur Ollama. À changer s’il tourne sur un autre hôte ou port.',
  'schema.ai.lmstudio.base_url.description': 'Point d’accès du serveur local LM Studio.',
  'schema.ai.openai.base_url.description':
    'Point d’accès de l’API OpenAI. À changer pour Azure OpenAI ou un fournisseur compatible.',
  'schema.ai.openai.api_key.description':
    'Obligatoire. Ou définissez la variable d’environnement OPENAI_API_KEY.',
  'schema.ai.anthropic.api_key.description':
    'Clé API Anthropic depuis console.anthropic.com. Ou définissez la variable d’environnement ANTHROPIC_API_KEY.',
  'schema.ai.gemini.api_key.description':
    'Clé de la Google Generative Language API depuis ai.google.dev (commence par AIza). Ou définissez la variable d’environnement GEMINI_API_KEY. Pour GCP/Vertex, utilisez plutôt le fournisseur « vertex ».',
  'schema.ai.vertex.api_key.label': 'Jeton d’accès',
  'schema.ai.vertex.api_key.description':
    'Jeton OAuth2 (courte durée, ~1 h). À générer avec : gcloud auth print-access-token. Ou définissez la variable d’environnement GOOGLE_ACCESS_TOKEN.',
  'schema.ai.vertex.project.label': 'Projet GCP',
  'schema.ai.vertex.project.description':
    'ID du projet Google Cloud hébergeant Vertex AI. Ou définissez la variable d’environnement GOOGLE_CLOUD_PROJECT.',
  'schema.ai.vertex.location.label': 'Région GCP',
  'schema.ai.vertex.location.description':
    'Région Vertex AI (ex. us-central1, europe-west4, asia-northeast1). Ou définissez la variable d’environnement GOOGLE_CLOUD_LOCATION.',
  'schema.ai.voyage.base_url.description': 'Point d’accès Voyage AI. En général la valeur par défaut.',
  'schema.ai.voyage.api_key.description':
    'Clé API Voyage depuis dash.voyageai.com. Ou définissez la variable d’environnement VOYAGE_API_KEY. Embeddings uniquement — pas d’inférence.',
  'schema.ai.mistral.base_url.description': 'Point d’accès de l’API Mistral.',
  'schema.ai.mistral.api_key.description':
    'Clé API Mistral depuis console.mistral.ai. Ou définissez la variable d’environnement MISTRAL_API_KEY.',
  'schema.ai.groq.base_url.description': 'Point d’accès de l’API Groq.',
  'schema.ai.groq.api_key.description':
    'Clé API Groq depuis console.groq.com. Ou définissez la variable d’environnement GROQ_API_KEY.',
  'schema.ai.together.base_url.description': 'Point d’accès de l’API Together AI.',
  'schema.ai.together.api_key.description':
    'Clé API Together depuis api.together.ai. Ou définissez la variable d’environnement TOGETHER_API_KEY.',
  'schema.ai.deepseek.base_url.description': 'Point d’accès de l’API DeepSeek.',
  'schema.ai.deepseek.api_key.description':
    'Clé API DeepSeek depuis platform.deepseek.com. Ou définissez la variable d’environnement DEEPSEEK_API_KEY.',
  'schema.ai.xai.base_url.description': 'Point d’accès de l’API xAI (Grok).',
  'schema.ai.xai.api_key.description':
    'Clé API xAI depuis console.x.ai. Ou définissez la variable d’environnement XAI_API_KEY.',

  'schema.ai.ollama.inference_model.description':
    'LLM pour les résumés et la classification d’intention.',
  'schema.ai.ollama.fast_model.description':
    'LLM plus petit et plus rapide pour les tâches à faible latence. Bascule sur le modèle d’inférence.',
  'schema.ai.ollama.embedding_model.description':
    'Modèle d’embedding pour la recherche sémantique. Doit correspondre à embedding_dimensions.',
  'schema.ai.ollama.reranker_model.description':
    'Cross-encoder pour reclasser les résultats de recherche.',
  'schema.ai.lmstudio.inference_model.description': 'LLM chargé dans LM Studio.',
  'schema.ai.lmstudio.fast_model.description': 'LLM rapide pour les tâches à faible latence.',
  'schema.ai.lmstudio.embedding_model.description': 'Modèle d’embedding chargé dans LM Studio.',
  'schema.ai.openai.inference_model.description':
    'LLM pour les résumés et la classification d’intention.',
  'schema.ai.openai.fast_model.description':
    'LLM plus rapide et moins cher. Bascule sur le modèle d’inférence.',
  'schema.ai.openai.embedding_model.description':
    'text-embedding-3-small (économique) ou text-embedding-3-large (précis).',
  'schema.ai.anthropic.inference_model.description':
    'Modèle Claude pour les résumés et le raisonnement.',
  'schema.ai.anthropic.fast_model.description':
    'Modèle Claude le plus rapide pour les tâches à faible latence.',
  'schema.ai.gemini.inference_model.description': 'Modèle Gemini pour les résumés.',
  'schema.ai.gemini.fast_model.description':
    'Modèle Gemini rapide pour les tâches à faible latence.',
  'schema.ai.gemini.embedding_model.description':
    'Modèle d’embedding Gemini. text-embedding-004 (768d) est recommandé.',
  'schema.ai.vertex.inference_model.description':
    'Modèle hébergé sur Vertex pour les résumés (ex. gemini-2.5-flash, gemini-2.5-pro).',
  'schema.ai.vertex.fast_model.description':
    'Modèle Vertex rapide pour les tâches à faible latence.',
  'schema.ai.vertex.embedding_model.description':
    'Modèle d’embedding Vertex (ex. text-embedding-005 768d, gemini-embedding-001 3072d).',
  'schema.ai.voyage.embedding_model.description':
    'Modèle d’embedding Voyage. voyage-code-3 (1024d) est optimisé pour le code source.',
  'schema.ai.mistral.inference_model.description': 'LLM Mistral pour les résumés.',
  'schema.ai.mistral.fast_model.description': 'Modèle Mistral rapide.',
  'schema.ai.mistral.embedding_model.description': 'Modèle d’embedding Mistral (1024d).',
  'schema.ai.groq.inference_model.description': 'LLM hébergé par Groq. Inférence ultra-rapide.',
  'schema.ai.groq.fast_model.description':
    'Modèle Groq le plus rapide pour les tâches à faible latence.',
  'schema.ai.groq.embedding_model.description': 'Modèle d’embedding Groq.',
  'schema.ai.together.inference_model.description': 'LLM hébergé par Together.',
  'schema.ai.together.fast_model.description': 'Modèle Together rapide.',
  'schema.ai.together.embedding_model.description': 'Modèle d’embedding Together.',
  'schema.ai.deepseek.inference_model.description':
    'DeepSeek V3 pour les résumés et le raisonnement.',
  'schema.ai.deepseek.fast_model.description': 'Modèle DeepSeek rapide.',
  'schema.ai.xai.inference_model.description': 'Modèle Grok pour les résumés.',
  'schema.ai.xai.fast_model.description': 'Modèle Grok rapide.',
  'schema.ai.onnx.embedding_model.description':
    'Modèle ONNX pour les embeddings locaux. La valeur par défaut fonctionne telle quelle.',

  'schema.ai.dimensions.label': 'Dimensions des embeddings',
  'schema.ai.dimensions.description':
    'Taille des vecteurs. Doit correspondre au modèle (384 pour MiniLM, 768 pour nomic/Gemini/Vertex text-embedding-005, 1024 pour Mistral/voyage-code-3, 1536 pour OpenAI, 3072 pour gemini-embedding-001).',
  'schema.ai.summarize.label': 'Résumer à l’indexation',
  'schema.ai.summarize.description':
    'Générer des résumés en langage naturel pendant l’indexation. Nécessite un fournisseur avec un modèle d’inférence.',
  'schema.ai.summarize_batch.label': 'Taille des lots de résumé',
  'schema.ai.summarize_batch.description': 'Symboles résumés en parallèle par lot.',
  'schema.ai.summarize_kinds.label': 'Types à résumer',
  'schema.ai.summarize_kinds.description': 'Types de symboles pour lesquels générer des résumés.',
  'schema.ai.concurrency.label': 'Parallélisme',
  'schema.ai.concurrency.description':
    'Requêtes IA en parallèle. Pour Ollama, alignez sur OLLAMA_NUM_PARALLEL.',

  'schema.security.secret_patterns.label': 'Motifs de secrets',
  'schema.security.max_file_size.label': 'Taille de fichier max (octets)',
  'schema.security.max_files.label': 'Nombre max de fichiers par projet',

  'schema.predictive.cache_ttl.label': 'TTL du cache (minutes)',
  'schema.predictive.git_since.label': 'Historique git (jours)',
  'schema.predictive.module_depth.label': 'Profondeur des modules',
  'schema.predictive.weights.label': 'Pondérations',
  'schema.predictive.weights.description': 'Pondérations des scores de bug, dette et risque',

  'schema.intent.auto_classify.label': 'Classer automatiquement à l’indexation',
  'schema.intent.domain_hints.label': 'Indices de domaine',
  'schema.intent.domain_hints.description': '{ "domain": ["path/**"] }',
  'schema.intent.custom_domains.label': 'Domaines personnalisés',
  'schema.intent.custom_domains.description': '[{ name, path_patterns }]',

  'schema.runtime.port.label': 'Port OTLP',
  'schema.runtime.host.label': 'Hôte OTLP',
  'schema.runtime.max_body.label': 'Taille max du corps (octets)',
  'schema.runtime.max_span_age.label': 'Âge max des spans (jours)',
  'schema.runtime.max_aggregate_age.label': 'Âge max des agrégats (jours)',
  'schema.runtime.prune_interval.label': 'Intervalle de purge',
  'schema.runtime.fqn_attributes.label': 'Attributs FQN',
  'schema.runtime.route_patterns.label': 'Motifs de routes',

  'schema.topology.auto_detect.label': 'Détecter les dépôts automatiquement',
  'schema.topology.auto_discover.label': 'Découvrir les sous-projets automatiquement',
  'schema.topology.repos.label': 'Chemins de dépôts supplémentaires',
  'schema.topology.contract_globs.label': 'Globs de contrats',

  'schema.lsp.enabled.description': 'Activer la passe d’enrichissement LSP après l’indexation',
  'schema.lsp.auto_detect.description':
    'Détecter automatiquement les serveurs LSP disponibles (tsserver, pyright, gopls, rust-analyzer)',
  'schema.lsp.max_servers.label': 'Serveurs simultanés max',
  'schema.lsp.max_servers.description': 'Limiter le nombre de processus LSP en parallèle',
  'schema.lsp.timeout.label': 'Délai d’enrichissement (ms)',
  'schema.lsp.timeout.description': 'Délai global de la passe d’enrichissement LSP',
  'schema.lsp.batch_size.description': 'Symboles traités par lot',
  'schema.lsp.servers.label': 'Réglages de serveurs',
  'schema.lsp.servers.description':
    '{ "typescript": { "command": "npx", "args": ["typescript-language-server", "--stdio"], "timeout_ms": 30000 } }',

  'schema.quality_gates.fail_on.label': 'Échouer sur',
  'schema.quality_gates.rules.label': 'Règles',
  'schema.quality_gates.rules.description': 'Seuils et sévérités des règles',

  'schema.tools.preset.label': 'Préréglage',
  'schema.tools.include.label': 'Outils inclus',
  'schema.tools.exclude.label': 'Outils exclus',
  'schema.tools.description_verbosity.label': 'Verbosité des descriptions',
  'schema.tools.instructions_verbosity.label': 'Verbosité des instructions',
  'schema.tools.meta_fields.label': 'Champs méta',
  'schema.tools.compact_schemas.label': 'Schémas compacts',
  'schema.tools.compact_schemas.description':
    'Retirer les paramètres avancés des schémas d’outils pour réduire le coût en tokens (~42 %)',
  'schema.tools.descriptions.label': 'Descriptions personnalisées',
  'schema.tools.descriptions.description': '{ "tool_name": "description" }',

  'schema.ignore.directories.label': 'Répertoires',
  'schema.ignore.patterns.label': 'Motifs',

  'schema.frameworks.config.label': 'Configuration',
  'schema.frameworks.config.description': 'Réglages spécifiques aux frameworks',

  'schema.logging.file.label': 'Activer la journalisation dans un fichier',
  'schema.logging.path.label': 'Chemin du fichier de journal',
  'schema.logging.level.label': 'Niveau de journal',
  'schema.logging.max_size.label': 'Taille max du journal (Mo)',

  'schema.watch.debounce.label': 'Anti-rebond (ms)',

  /* ── Setup wizard ── */
  'app.setupWizard': "Assistant de configuration initiale",
  'app.runSetupWizard': "Lancer l'assistant…",
} as const;
