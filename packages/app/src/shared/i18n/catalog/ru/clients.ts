export const clients = {
  title: 'Клиенты MCP',
  refresh: 'Обновить список клиентов',

  supported: 'Поддерживаемые клиенты',
  sessions: 'Активные сессии',
  detecting: 'Ищем клиентов',
  loadingSessions: 'Загружаем сессии',

  daemonDownTitle: 'Сервис недоступен',
  daemonDownSubtitle:
    'Клиенты trace-mcp подключаются через локальный сервис. Запустите его, чтобы увидеть и настроить их.',
  startDaemon: 'Запустить сервис',
  starting: 'Запускаем…',

  noSessionsTitle: 'Активных сессий нет',
  noSessionsSubtitle: 'Сессия появится здесь, когда клиент подключится к сервису.',
  unnamedSession: 'Сессия без имени',

  sessionActive: 'Активна',
  sessionIdle: 'Простаивает',
  sessionStale: 'Давно молчит',

  connected: 'Подключён',
  connect: 'Подключить',
  connecting: 'Подключаем…',
  updateAvailable: 'Есть обновление',
  update: 'Обновить',
  updating: 'Обновляем…',
  driftedField: 'Разошлось поле: {{field}}',
  setUpManually: 'Настроить вручную…',
  hideSteps: 'Скрыть шаги',

  enforcementLevel: 'Уровень контроля',
  levelBase: 'Базовый',
  levelBaseHint: 'Только CLAUDE.md — мягкие правила выбора инструментов',
  levelStandard: 'Обычный',
  levelStandardHint: 'CLAUDE.md и хуки',
  levelMax: 'Максимум',
  levelMaxHint: 'CLAUDE.md, хуки и tweakcc — рекомендуем',
} as const;
