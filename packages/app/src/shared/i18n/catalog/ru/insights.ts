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
} as const;
