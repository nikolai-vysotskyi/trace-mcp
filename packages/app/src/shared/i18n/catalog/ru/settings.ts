/* Русский перевод surface'а настроек.

   Идентификаторы внутри предложений не переводятся: имена полей конфигурации,
   переменные окружения, модели, флаги и пути пользователь вводит обратно в
   .config.json, поэтому они остаются английскими во всех языках. */

export const settings = {
  title: 'Настройки',
  back: 'Назад',
  moreActions: 'Ещё действия',
  search: 'Поиск по настройкам',
  copyDaemon: 'Скопировать сведения о демоне',
  editConfigFile: 'Открыть файл конфигурации…',
  noMatches: 'Ничего не найдено по запросу «{{query}}».',

  'group.general': 'Общие',
  'group.intelligence': 'Интеллект',
  'group.quality': 'Качество и безопасность',
  'group.infrastructure': 'Инфраструктура',
  'group.development': 'Разработка',
  'group.monitoring': 'Наблюдение',
  'group.advanced': 'Дополнительно',

  'daemon.title': 'Демон',
  'daemon.state': 'Работает',
  'daemon.summary': 'Работает · порт {{port}} · время работы {{uptime}}',
  'uptime.seconds': '{{value}} с',
  'uptime.minutes': '{{value}} мин',
  'uptime.hours': '{{value}} ч',
  'uptime.hoursMinutes': '{{hours}} ч {{minutes}} мин',

  'app.title': 'Приложение',
  'app.language': 'Язык',
  'appearance.theme': 'Тема',

  'empty.loading': 'Загрузка настроек…',
  'empty.unreadableTitle': 'Не удалось прочитать настройки',
  'empty.unreadableBody':
    'Демон работает, но не вернул свою конфигурацию. Обычно помогает его перезапуск.',
  'empty.unreachableTitle': 'Демон недоступен',
  'empty.unreachableBody':
    'Настройки лежат в файле конфигурации демона, поэтому прочитать их можно только когда он запущен.',
  'empty.starting': 'Запуск…',
  'empty.restart': 'Перезапустить демон',
  'empty.start': 'Запустить демон',

  modified: 'Изменено',
  issues_one: '{{count}} ошибка',
  issues_few: '{{count}} ошибки',
  issues_many: '{{count}} ошибок',
  issues_other: '{{count}} ошибки',

  reset: 'Сбросить',
  resetSection: 'Сбросить раздел к значениям по умолчанию',
  notSet: 'Не задано',
  'field.aria': '{{label}}: {{value}}',
  'field.ariaUnset': '{{label}}: не задано',
  invalidJson: 'Некорректный JSON',

  'models.select': 'Выбрать модель…',
  'models.filter': 'Фильтр моделей',
  'models.loading': 'Загрузка моделей…',
  'models.retry': 'Повторить',
  'models.none': 'Моделей не найдено',
  'models.noMatches': 'Совпадений нет',
  'models.clear': 'Снять выбор',
  'models.type': 'Или введите имя модели…',
  'models.typeAria': 'Введите имя модели',
  'models.failed': 'Не удалось получить список моделей',
  'models.httpError': '{{provider}}: {{status}}',
  'models.authError': '{{provider}}: {{status}} (проверьте ключ API)',

  'projects.title': 'Настройки для отдельных проектов',
  'projects.intro':
    'Переопределите общие настройки для конкретных проектов. Значения накладываются поверх общей конфигурации.',
  'projects.done': 'Готово',
  'projects.edit': 'Изменить',
  'projects.remove': 'Удалить',
  'projects.apply': 'Применить',
  'projects.add': 'Добавить',
  'projects.pathAria': 'Путь к проекту',
  'projects.overridesAria': 'Переопределения для {{path}}',

  'diff.title': 'Несохранённые изменения',
  'diff.hide': 'Скрыть',
  'bar.hasErrors': 'Исправьте ошибки выше, прежде чем сохранять',
  'bar.saved': 'Сохранено',
  'bar.saveFailed': 'Не удалось сохранить — демон отклонил изменение',
  'bar.unsaved_one': '{{count}} несохранённое изменение',
  'bar.unsaved_few': '{{count}} несохранённых изменения',
  'bar.unsaved_many': '{{count}} несохранённых изменений',
  'bar.unsaved_other': '{{count}} несохранённых изменения',
  'bar.hideChanges': 'Скрыть изменения',
  'bar.reviewChanges': 'Посмотреть изменения',
  'bar.discard': 'Отменить',
  'bar.saving': 'Сохранение…',
  'bar.save': 'Сохранить',

  'activity.title': 'Активность ИИ',
  'activity.armed': 'Следующее окно проекта откроется на вкладке «Активность» → «Вызовы ИИ».',
  'activity.idle':
    'Недавние запросы к эмбеддингам, LLM и реранкеру видны в окне проекта, на вкладке «Активность».',
  'activity.ready': 'Готово',
  'activity.open': 'Открыть в следующем окне',

  'validate.boolean': 'Допустимо только true или false',
  'validate.number': 'Нужно число',
  'validate.min': 'Минимум: {{min}}',
  'validate.max': 'Максимум: {{max}}',
  'validate.string': 'Нужна строка',
  'validate.tooLong': 'Слишком длинное значение (максимум {{max}} символов)',
  'validate.pattern': 'Должно соответствовать: {{pattern}}',
  'validate.oneOf': 'Допустимые значения: {{options}}',
  'validate.list': 'Нужен список',
  'validate.json': 'Нужен корректный JSON (не строка)',

  'schema._root.label': 'Общие',
  'schema._root.description': 'Автообновление и настройки верхнего уровня',
  'schema.ai.label': 'ИИ и эмбеддинги',
  'schema.ai.description':
    'Провайдер ИИ для семантического поиска, кратких описаний и классификации намерений',
  'schema.security.label': 'Безопасность',
  'schema.security.description': 'Поиск секретов и ограничения на файлы',
  'schema.predictive.label': 'Предиктивный анализ',
  'schema.predictive.description': 'Прогноз ошибок, оценка техдолга, риск изменений',
  'schema.intent.label': 'Намерения и домены',
  'schema.intent.description': 'Классификация по доменам и автоматические теги',
  'schema.runtime.label': 'Трассировка выполнения (OTLP)',
  'schema.runtime.description': 'Приём спанов OpenTelemetry и анализ трасс',
  'schema.topology.label': 'Топология нескольких репозиториев',
  'schema.topology.description': 'Подпроекты и отслеживание зависимостей между сервисами',
  'schema.lsp.label': 'Обогащение через LSP',
  'schema.lsp.description':
    'Разрешение графа вызовов на уровне компилятора через Language Server Protocol',
  'schema.quality_gates.label': 'Контроль качества',
  'schema.quality_gates.description': 'Автоматические проверки качества на коммитах и PR',
  'schema.tools.label': 'Состав инструментов',
  'schema.tools.description': 'Какие инструменты MCP доступны и в каком виде',
  'schema.ignore.label': 'Правила игнорирования',
  'schema.ignore.description': 'Дополнительные каталоги и шаблоны, пропускаемые при индексации',
  'schema.frameworks.label': 'Фреймворки',
  'schema.frameworks.description': 'Настройки под конкретные фреймворки (Laravel и другие)',
  'schema.logging.label': 'Журналирование',
  'schema.logging.description': 'Запись журнала в файл и его ротация',
  'schema.watch.label': 'Наблюдение за файлами',
  'schema.watch.description': 'Автоматическая переиндексация при изменении файлов',

  'schema.f.enabled': 'Включено',
  'schema.f.baseUrl': 'Базовый URL',
  'schema.f.apiKey': 'Ключ API',
  'schema.f.inferenceModel': 'Модель вывода',
  'schema.f.fastModel': 'Быстрая модель',
  'schema.f.embeddingModel': 'Модель эмбеддингов',
  'schema.f.rerankerModel': 'Модель реранкера',
  'schema.f.autoDetect': 'Определять серверы автоматически',
  'schema.f.batchSize': 'Размер пакета',

  'schema._root.auto_update.label': 'Автообновление',
  'schema._root.interval.label': 'Интервал проверки обновлений (часы)',
  'schema._root.logLevel.label': 'Уровень журнала демона',

  'schema.ai.provider.label': 'Провайдер',
  'schema.ai.provider.description':
    'onnx — локально и без настройки. ollama/lmstudio — локально, с выбором модели. gemini — Google Generative Language API (потребительский, ключ AIza). vertex — Google Vertex AI (GCP, токен OAuth + проект и регион). voyage — только эмбеддинги Voyage AI. Остальные — облачные API.',
  'schema.ai.embedding.label': 'Использовать эмбеддинги',
  'schema.ai.embedding.description':
    'Строить векторные эмбеддинги для семантического поиска и переранжирования. Выключите, чтобы отключить семантический поиск, оставив вывод.',
  'schema.ai.inference.label': 'Использовать вывод',
  'schema.ai.inference.description':
    'Обращаться к LLM для кратких описаний, классификации намерений и Ask. Выключите, чтобы отказаться от вызовов LLM, оставив эмбеддинги.',
  'schema.ai.fast_inference.label': 'Использовать быстрый вывод',
  'schema.ai.fast_inference.description':
    'Использовать быструю модель для задач с малой задержкой. Когда выключено, такие вызовы возвращают пустой ответ — оставьте включённым, если не отлаживаете.',

  'schema.ai.ollama.base_url.description':
    'Адрес сервера Ollama. Измените, если он работает на другом хосте или порту.',
  'schema.ai.lmstudio.base_url.description': 'Адрес локального сервера LM Studio.',
  'schema.ai.openai.base_url.description':
    'Адрес API OpenAI. Измените для Azure OpenAI или совместимых провайдеров.',
  'schema.ai.openai.api_key.description': 'Обязателен. Либо задайте переменную OPENAI_API_KEY.',
  'schema.ai.anthropic.api_key.description':
    'Ключ API Anthropic с console.anthropic.com. Либо задайте переменную ANTHROPIC_API_KEY.',
  'schema.ai.gemini.api_key.description':
    'Ключ Google Generative Language API с ai.google.dev (начинается с AIza). Либо задайте переменную GEMINI_API_KEY. Для GCP/Vertex выберите провайдера «vertex».',
  'schema.ai.vertex.api_key.label': 'Токен доступа',
  'schema.ai.vertex.api_key.description':
    'Токен OAuth2 (живёт около часа). Получить: gcloud auth print-access-token. Либо задайте переменную GOOGLE_ACCESS_TOKEN.',
  'schema.ai.vertex.project.label': 'Проект GCP',
  'schema.ai.vertex.project.description':
    'Идентификатор проекта Google Cloud с Vertex AI. Либо задайте переменную GOOGLE_CLOUD_PROJECT.',
  'schema.ai.vertex.location.label': 'Регион GCP',
  'schema.ai.vertex.location.description':
    'Регион Vertex AI (например, us-central1, europe-west4, asia-northeast1). Либо задайте переменную GOOGLE_CLOUD_LOCATION.',
  'schema.ai.voyage.base_url.description': 'Адрес API Voyage AI. Обычно подходит значение по умолчанию.',
  'schema.ai.voyage.api_key.description':
    'Ключ API Voyage с dash.voyageai.com. Либо задайте переменную VOYAGE_API_KEY. Только эмбеддинги — вывода нет.',
  'schema.ai.mistral.base_url.description': 'Адрес API Mistral.',
  'schema.ai.mistral.api_key.description':
    'Ключ API Mistral с console.mistral.ai. Либо задайте переменную MISTRAL_API_KEY.',
  'schema.ai.groq.base_url.description': 'Адрес API Groq.',
  'schema.ai.groq.api_key.description':
    'Ключ API Groq с console.groq.com. Либо задайте переменную GROQ_API_KEY.',
  'schema.ai.together.base_url.description': 'Адрес API Together AI.',
  'schema.ai.together.api_key.description':
    'Ключ API Together с api.together.ai. Либо задайте переменную TOGETHER_API_KEY.',
  'schema.ai.deepseek.base_url.description': 'Адрес API DeepSeek.',
  'schema.ai.deepseek.api_key.description':
    'Ключ API DeepSeek с platform.deepseek.com. Либо задайте переменную DEEPSEEK_API_KEY.',
  'schema.ai.xai.base_url.description': 'Адрес API xAI (Grok).',
  'schema.ai.xai.api_key.description':
    'Ключ API xAI с console.x.ai. Либо задайте переменную XAI_API_KEY.',

  'schema.ai.ollama.inference_model.description':
    'LLM для кратких описаний и классификации намерений.',
  'schema.ai.ollama.fast_model.description':
    'Меньшая и более быстрая LLM для задач с малой задержкой. Если не задана, берётся модель вывода.',
  'schema.ai.ollama.embedding_model.description':
    'Модель эмбеддингов для семантического поиска. Должна соответствовать embedding_dimensions.',
  'schema.ai.ollama.reranker_model.description':
    'Кросс-энкодер для переранжирования результатов поиска.',
  'schema.ai.lmstudio.inference_model.description': 'LLM, загруженная в LM Studio.',
  'schema.ai.lmstudio.fast_model.description': 'Быстрая LLM для задач с малой задержкой.',
  'schema.ai.lmstudio.embedding_model.description': 'Модель эмбеддингов, загруженная в LM Studio.',
  'schema.ai.openai.inference_model.description':
    'LLM для кратких описаний и классификации намерений.',
  'schema.ai.openai.fast_model.description':
    'Более быстрая и дешёвая LLM. Если не задана, берётся модель вывода.',
  'schema.ai.openai.embedding_model.description':
    'text-embedding-3-small (дешевле) или text-embedding-3-large (точнее).',
  'schema.ai.anthropic.inference_model.description':
    'Модель Claude для кратких описаний и рассуждений.',
  'schema.ai.anthropic.fast_model.description':
    'Самая быстрая модель Claude для задач с малой задержкой.',
  'schema.ai.gemini.inference_model.description': 'Модель Gemini для кратких описаний.',
  'schema.ai.gemini.fast_model.description': 'Быстрая модель Gemini для задач с малой задержкой.',
  'schema.ai.gemini.embedding_model.description':
    'Модель эмбеддингов Gemini. Рекомендуется text-embedding-004 (768 измерений).',
  'schema.ai.vertex.inference_model.description':
    'Модель в Vertex для кратких описаний (например, gemini-2.5-flash, gemini-2.5-pro).',
  'schema.ai.vertex.fast_model.description':
    'Быстрая модель в Vertex для задач с малой задержкой.',
  'schema.ai.vertex.embedding_model.description':
    'Модель эмбеддингов в Vertex (например, text-embedding-005 — 768 измерений, gemini-embedding-001 — 3072).',
  'schema.ai.voyage.embedding_model.description':
    'Модель эмбеддингов Voyage. voyage-code-3 (1024 измерения) настроена на исходный код.',
  'schema.ai.mistral.inference_model.description': 'LLM Mistral для кратких описаний.',
  'schema.ai.mistral.fast_model.description': 'Быстрая модель Mistral.',
  'schema.ai.mistral.embedding_model.description': 'Модель эмбеддингов Mistral (1024 измерения).',
  'schema.ai.groq.inference_model.description': 'LLM в Groq. Очень быстрый вывод.',
  'schema.ai.groq.fast_model.description': 'Самая быстрая модель Groq для задач с малой задержкой.',
  'schema.ai.groq.embedding_model.description': 'Модель эмбеддингов Groq.',
  'schema.ai.together.inference_model.description': 'LLM в Together.',
  'schema.ai.together.fast_model.description': 'Быстрая модель Together.',
  'schema.ai.together.embedding_model.description': 'Модель эмбеддингов Together.',
  'schema.ai.deepseek.inference_model.description':
    'DeepSeek V3 для кратких описаний и рассуждений.',
  'schema.ai.deepseek.fast_model.description': 'Быстрая модель DeepSeek.',
  'schema.ai.xai.inference_model.description': 'Модель Grok для кратких описаний.',
  'schema.ai.xai.fast_model.description': 'Быстрая модель Grok.',
  'schema.ai.onnx.embedding_model.description':
    'Модель ONNX для локальных эмбеддингов. Значение по умолчанию работает сразу.',

  'schema.ai.dimensions.label': 'Размерность эмбеддингов',
  'schema.ai.dimensions.description':
    'Размер вектора. Должен совпадать с моделью (384 для MiniLM, 768 для nomic/Gemini/Vertex text-embedding-005, 1024 для Mistral/voyage-code-3, 1536 для OpenAI, 3072 для gemini-embedding-001).',
  'schema.ai.summarize.label': 'Краткие описания при индексации',
  'schema.ai.summarize.description':
    'Строить описания на естественном языке во время индексации. Нужен провайдер с моделью вывода.',
  'schema.ai.summarize_batch.label': 'Размер пакета описаний',
  'schema.ai.summarize_batch.description': 'Сколько символов описывать параллельно в одном пакете.',
  'schema.ai.summarize_kinds.label': 'Виды символов для описаний',
  'schema.ai.summarize_kinds.description': 'Для каких видов символов строить описания.',
  'schema.ai.concurrency.label': 'Параллелизм',
  'schema.ai.concurrency.description':
    'Число параллельных запросов к ИИ. Для Ollama согласуйте с OLLAMA_NUM_PARALLEL.',

  'schema.security.secret_patterns.label': 'Шаблоны секретов',
  'schema.security.max_file_size.label': 'Максимальный размер файла (байты)',
  'schema.security.max_files.label': 'Максимум файлов на проект',

  'schema.predictive.cache_ttl.label': 'Время жизни кеша (минуты)',
  'schema.predictive.git_since.label': 'История Git (дни)',
  'schema.predictive.module_depth.label': 'Глубина модулей',
  'schema.predictive.weights.label': 'Веса',
  'schema.predictive.weights.description': 'Веса оценки ошибок, техдолга и риска',

  'schema.intent.auto_classify.label': 'Классифицировать при индексации',
  'schema.intent.domain_hints.label': 'Подсказки по доменам',
  'schema.intent.domain_hints.description': '{ "domain": ["path/**"] }',
  'schema.intent.custom_domains.label': 'Свои домены',
  'schema.intent.custom_domains.description': '[{ name, path_patterns }]',

  'schema.runtime.port.label': 'Порт OTLP',
  'schema.runtime.host.label': 'Хост OTLP',
  'schema.runtime.max_body.label': 'Максимальный размер тела (байты)',
  'schema.runtime.max_span_age.label': 'Максимальный возраст спанов (дни)',
  'schema.runtime.max_aggregate_age.label': 'Максимальный возраст агрегатов (дни)',
  'schema.runtime.prune_interval.label': 'Интервал очистки',
  'schema.runtime.fqn_attributes.label': 'Атрибуты FQN',
  'schema.runtime.route_patterns.label': 'Шаблоны маршрутов',

  'schema.topology.auto_detect.label': 'Определять репозитории автоматически',
  'schema.topology.auto_discover.label': 'Находить подпроекты автоматически',
  'schema.topology.repos.label': 'Дополнительные пути к репозиториям',
  'schema.topology.contract_globs.label': 'Шаблоны файлов контрактов',

  'schema.lsp.enabled.description': 'Включить проход обогащения через LSP после индексации',
  'schema.lsp.auto_detect.description':
    'Находить доступные серверы LSP автоматически (tsserver, pyright, gopls, rust-analyzer)',
  'schema.lsp.max_servers.label': 'Максимум серверов одновременно',
  'schema.lsp.max_servers.description': 'Ограничить число параллельных процессов LSP',
  'schema.lsp.timeout.label': 'Тайм-аут обогащения (мс)',
  'schema.lsp.timeout.description': 'Общий тайм-аут прохода обогащения через LSP',
  'schema.lsp.batch_size.description': 'Сколько символов обрабатывается за пакет',
  'schema.lsp.servers.label': 'Переопределения серверов',
  'schema.lsp.servers.description':
    '{ "typescript": { "command": "npx", "args": ["typescript-language-server", "--stdio"], "timeout_ms": 30000 } }',

  'schema.quality_gates.fail_on.label': 'Считать ошибкой',
  'schema.quality_gates.rules.label': 'Правила',
  'schema.quality_gates.rules.description': 'Пороги и уровни серьёзности правил',

  'schema.tools.preset.label': 'Набор',
  'schema.tools.include.label': 'Включить инструменты',
  'schema.tools.exclude.label': 'Исключить инструменты',
  'schema.tools.description_verbosity.label': 'Подробность описаний',
  'schema.tools.instructions_verbosity.label': 'Подробность инструкций',
  'schema.tools.meta_fields.label': 'Служебные поля',
  'schema.tools.compact_schemas.label': 'Компактные схемы',
  'schema.tools.compact_schemas.description':
    'Убрать из схем инструментов необязательные параметры и сэкономить около 42% токенов',
  'schema.tools.descriptions.label': 'Свои описания',
  'schema.tools.descriptions.description': '{ "tool_name": "description" }',

  'schema.ignore.directories.label': 'Каталоги',
  'schema.ignore.patterns.label': 'Шаблоны',

  'schema.frameworks.config.label': 'Конфигурация',
  'schema.frameworks.config.description': 'Переопределения для фреймворков',

  'schema.logging.file.label': 'Писать журнал в файл',
  'schema.logging.path.label': 'Путь к файлу журнала',
  'schema.logging.level.label': 'Уровень журнала',
  'schema.logging.max_size.label': 'Максимальный размер журнала (МБ)',

  'schema.watch.debounce.label': 'Задержка (мс)',
} as const;
