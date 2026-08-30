export const clients = {
  title: 'Клиенты MCP',
  refresh: 'Обновить список клиентов',

  supported: 'Поддерживаемые клиенты',
  sessions: 'Активные сессии',
  detecting: 'Ищем клиентов',
  loadingSessions: 'Загружаем сессии',

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
  updateAll: 'Обновить все',
  updatingProgress: 'Обновляем {{done}} из {{total}}',
  writeFailed: 'Не удалось записать конфигурацию.',
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
