/* «Служба» for the daemon: it is the word Russian users of a menu-bar app
   expect for a background process, and "демон" reads as a transliteration
   rather than as something you can start and stop. */

export const tray = {
  daemonRunning: 'Служба работает',
  daemonStopped: 'Служба остановлена',
  workspace: 'Рабочая область',
  clients: 'Клиенты MCP',
  settings: 'Настройки',
  quit: 'Завершить trace-mcp',
  tooltipRunning: 'trace-mcp — работает',
  tooltipStopped: 'trace-mcp — служба недоступна',
  menuWindow: 'Меню',
} as const;
