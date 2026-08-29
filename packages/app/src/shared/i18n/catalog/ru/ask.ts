export const ask = {
  title: 'Вопросы',

  noProviderTitle: 'Подключите ИИ-провайдера',
  noProviderSubtitle:
    'Вопросы о проекте разбирает та модель, которую вы подключите. Добавьте её в настройках, чтобы включить эту вкладку.',
  openAiSettings: 'Открыть настройки ИИ',

  chats: 'Диалоги',
  newChat: 'Новый диалог',
  noChats: 'Диалогов пока нет.',
  untitled: 'Без названия',
  deleteChat: 'Удалить диалог (⌫)',
  connectingProvider: 'Подключаемся…',
  noProvider: 'Провайдер не выбран',

  showContextPanel: 'Показать панель контекста',
  hideContextPanel: 'Скрыть панель контекста',
  showContext: 'Показать контекст',
  hideContext: 'Скрыть контекст',
  loadingChat: 'Загружаем диалог',
  conversation: 'Диалог',

  emptyTitle: 'Спросите что угодно об этом коде',
  emptySubtitle:
    'Ответы опираются на построенный граф — файлы, символы и решения, которые уже есть в проекте.',
  slashCommands: 'Команды со слешем',
  slashFind: 'Найти символы по имени',
  slashImpact: 'Показать, на что повлияет изменение символа',
  slashScan: 'Проверить безопасность (главные находки OWASP)',
  suggestionAuth: 'Как устроена авторизация?',
  suggestionPlugins: 'Объясни систему плагинов',
  suggestionRoutes: 'Где находятся маршруты API?',

  retrieving: 'Ищем по коду',
  thinking: 'Думаем',
  sendAgain: 'Отправить снова',

  composerLabel: 'Вопрос об этом проекте',
  composerPlaceholder: 'Спросите об этом проекте или введите / для команд',
  stopGenerating: 'Остановить ответ',
  sendMessage: 'Отправить сообщение',
  sendShortcut: 'Отправить (⌘↵)',
  copyCode: 'Скопировать код',
  copied: 'Скопировано',

  context: 'Контекст',
  noContextTitle: 'Контекста пока нет',
  noContextSubtitle:
    'Файлы, символы и решения, которые прочитала модель, появятся здесь после первого сообщения. Команды со слешем контекст не собирают.',
  filesRead: 'Прочитано файлов',
  noFilesRead: 'Файлы не читались.',
  symbolsRead: 'Прочитано символов',
  decisionsConsulted: 'Учтено решений',

  loadSessionFailed: 'Не удалось загрузить диалог',
  createSessionFailed: 'Не удалось создать диалог',
  noSession: 'Не удалось начать диалог',
  slashFailed: 'Команда не выполнилась',
  unknownError: 'Неизвестная ошибка',
} as const;
