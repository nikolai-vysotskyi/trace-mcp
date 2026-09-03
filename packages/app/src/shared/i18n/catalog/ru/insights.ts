/* Русские строки вкладки «Аналитика». CLAUDE.md, PageRank и git — имена
   собственные и не переводятся. */

export const insights = {
  title: 'Аналитика',
  reportPicker: 'Отчёт',
  run: 'Запустить',
  refresh: 'Обновить',
  running: 'Выполняется…',
  runAction: '{{action}}: {{report}}',
  unknownError: 'Неизвестная ошибка',
  errorInit: 'Не удалось начать сеанс со службой (HTTP {{status}}).',
  errorNoSession: 'Служба начала сеанс, но не сообщила его идентификатор.',
  errorHttp: 'Запрос отчёта не прошёл (HTTP {{status}}). {{detail}}',
  errorToolFailed: 'Отчёт не выполнился.',

  reportDriftTitle: 'Расхождения в CLAUDE.md',
  reportDriftDescription:
    'Устаревшие пути и ссылки на исчезнувшие символы в файлах настроек агента.',
  reportPagerankTitle: 'Самые центральные файлы',
  reportPagerankDescription:
    'Файлы, наиболее важные для архитектуры, по PageRank на графе импортов.',
  reportRiskTitle: 'Зоны риска',
  reportRiskDescription:
    'Файлы, где высокая сложность сочетается с частыми изменениями в git.',

  runningDrift: 'Сверяем настройки агента с индексом…',
  runningPagerank: 'Ранжируем файлы по центральности импортов…',
  runningRisk: 'Сопоставляем сложность с частотой изменений…',

  emptyTitle: 'Сообщать нечего',
  emptyBody: 'Отчёт вернулся пустым — сейчас в проекте нет ничего подходящего.',

  noDescription: '(без описания)',
  rowIssue: '{{location}} — {{issue}}',
  rowFix: 'Как исправить: {{fix}}',
  rowScore: 'оценка {{score}}',
  rowHotspot: 'сложность {{complexity}} · коммитов: {{commits}}',
  rowHotspotConfidence:
    'сложность {{complexity}} · коммитов: {{commits}} · {{confidence}}',

  reportStartupTitle: 'Стартовый контекст',
  reportStartupDescription:
    'За что каждая сессия платит ещё до вашего первого сообщения, сколько это стоит и из-за чего оплачивается дважды. Читается из журналов сессий на этом Mac; наружу ничего не уходит.',
  runningStartup: 'Измеряем стартовый блок по журналам сессий…',

  startupBlockRow: 'Стартовый блок — {{tokens}} токенов',
  startupBlockDetail: 'медиана · p10 {{p10}} · p90 {{p90}} · сессий: {{sessions}} за {{days}} дн.',
  startupCostRow: 'Цена старта — {{usd}}',
  startupCostDetail: 'из {{total}}, потраченных на вход за {{days}} дн.',
  startupSourceRow: '{{source}} — {{tokens}} токенов',
  startupSourceDetail: 'измерено в {{sessions}} сессиях',
  startupResidualDetail:
    'Не разложено — системный промпт, схемы инструментов и CLAUDE.md в журнал сессии не попадают',
  startupRebuildRow: 'Кэш пересобран: {{cause}} — раз: {{events}}',
  startupRebuildDetail: '{{usd}} сверх того, во что обошлось бы чтение тех же токенов из кэша',
  startupServerRow: '{{server}} — в {{sessions}} стартовых блоках',
  startupServerDetail: 'вызовов: {{calls}}',

  sourceResidual: 'Системный промпт, схемы инструментов и инструкции',
  sourceSkills: 'Список скиллов',
  sourceDeferredTools: 'Список отложенных инструментов',
  sourceAgentListing: 'Список агентов',
  sourceMcpInstructions: 'Инструкции MCP-серверов',
  sourceMemory: 'Файлы памяти',
  sourceOther: 'Прочие вставки',
  sourceHook: 'Хук: {{name}}',

  causeCompact: 'сжатие контекста',
  causeTtlExpiry: 'кэш истёк между сообщениями',
  causeModelSwitch: 'сменилась модель',
  causeToolsChanged: 'изменился набор инструментов',
  causeListingChanged: 'изменился список скиллов или агентов',
  causeUnexplained: 'причина не установлена',
} as const;
