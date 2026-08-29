/* Русские строки экрана «Обзор проекта». Регистр тот же, что в английском:
   короткие подписи без точки, подсказки — обычными фразами.

   Существительные категорий находок стоят в именительном падеже множественного
   числа, потому что emptySmellTitle согласуется с ними глаголом «не найдены».
   Фрагменты errorXxx — наоборот, в винительном: их подставляют в «Не удалось
   загрузить …». */

export const overview = {
  statusChecking: 'Проверяем…',
  statusDaemonUnreachable: 'Служба недоступна',
  statusNotTracked: 'Не отслеживается',
  statusIndexing: 'Индексируется',
  statusReady: 'Готов',
  statusError: 'Ошибка',
  statusNotIndexed: 'Не проиндексирован',
  actionIndexing: 'Индексируем…',
  actionReindex: 'Переиндексировать',
  actionReAdd: 'Добавить заново',
  actionIndex: 'Проиндексировать',
  moreActions: 'Ещё действия',
  indexingProgress: 'Ход индексации',

  menuViewStats: 'Показать статистику',
  menuAddService: 'Добавить сервис…',
  menuOpenInEditor: 'Открыть в редакторе',
  menuOpenInGraph: 'Открыть в графе',
  menuSetGroup: 'Задать группу…',
  menuRemoveService: 'Удалить сервис…',

  sectionIndex: 'Индекс',
  rowStatus: 'Состояние',
  rowFiles: 'Файлов проиндексировано',
  rowSymbols: 'Символов',
  rowEdges: 'Связей',
  rowLastIndexed: 'Последняя индексация',
  never: 'Никогда',
  unknown: 'Неизвестно',
  emptyIndexTitle: 'Ещё не проиндексирован',
  emptyIndexBody:
    'Проиндексируйте проект, чтобы работать с его символами, связями и историей.',

  errorIndexSummary: 'сводку индекса',
  errorCoverage: 'покрытие зависимостей',
  errorQuality: 'проверку качества',
  errorServices: 'список сервисов',

  sectionCoverage: 'Покрытие',
  coverageMeter: 'Покрытие зависимостей',
  coverageCovered: 'Покрыто зависимостей: {{covered}} из {{total}}',
  emptyCoverageTitle: 'Зависимости не обнаружены',
  emptyCoverageBody:
    'Покрытие появится, когда в индексе будет манифест зависимостей этого проекта.',
  emptyCoverageFoundTitle: 'Зависимости не найдены',
  emptyCoverageFoundBody:
    'Покрытие появится, когда манифест зависимостей проекта попадёт в индекс.',
  coverageRequest: 'Запросить',
  coverageRequestTitle: 'Создать запрос на плагин для {{name}}',
  priorityHigh: 'высокий',
  priorityMedium: 'средний',
  priorityLow: 'низкий',
  needsLikely: 'вероятно',
  needsMaybe: 'возможно',
  needsNo: 'нет',

  sectionQuality: 'Качество',
  findings_one: '{{n}} находка',
  findings_few: '{{n}} находки',
  findings_many: '{{n}} находок',
  findings_other: '{{n}} находки',
  smellCategoryLabel: 'Категория находок',
  smellDebug: 'Отладка',
  smellTodo: 'TODO',
  smellHardcoded: 'Константы',
  smellStubs: 'Заглушки',
  nounDebug: 'Отладочные артефакты',
  nounTodo: 'Комментарии TODO',
  nounHardcoded: 'Жёстко заданные значения',
  nounStubs: 'Пустые функции',
  emptySmellTitle: '{{noun}} не найдены',
  emptySmellBody: 'В этой категории чистить нечего — просмотрено файлов: {{n}}.',
  openInEditorTitle: 'Открыть {{file}}:{{line}} в редакторе',
  moreNotShown: 'Ещё {{n}} не показаны',

  sectionServices: 'Сервисы',
  servicesAdd: 'Добавить',
  emptyServicesTitle: 'Сервисы не обнаружены',
  emptyServicesBody:
    'Сервисы находятся при индексации проекта — или укажите репозиторий сами.',
  noGroup: 'Без группы',
  groupPlaceholder: 'Название группы',
  groupFor: 'Группа сервиса {{name}}',
  actionsFor: 'Действия с {{name}}',
  endpoints_one: '{{n}} эндпоинт',
  endpoints_few: '{{n}} эндпоинта',
  endpoints_many: '{{n}} эндпоинтов',
  endpoints_other: '{{n}} эндпоинта',
  removeTitle: 'Удалить {{name}}?',
  removeBody: 'Сервис перестанет отслеживаться здесь. На диске ничего не меняется.',
  removeConfirm: 'Удалить сервис',
} as const;
