/* Единственное число без plural-форм: главный процесс присылает максимум один
   устаревший каталог — тот, из которого MCP-клиенты действительно запускаются
   (TRA-377). */

export const update = {
  staleRoots: 'MCP-клиенты работают на v{{version}}',
  staleRootsTitle:
    'Ваши редакторы запускают trace-mcp из {{pkgDir}} — там версия v{{version}}. Эту копию установил другой npm, поэтому обновление приложения её не затронуло: пока она не обновлена, все MCP-клиенты работают со старым сервером.\n\nОбновите её из терминала:\n{{command}}',
  copyStaleRootCommand: 'Скопировать команду обновления',

  duplicateApps: 'Установлено больше одного раза',
  duplicateApp: '{{path}} · v{{version}}',
  duplicateAppRunning: '{{path}} · v{{version}} — работает сейчас',
  duplicateAppsTitle:
    'На этом Mac больше одной копии trace-mcp:\n\n{{list}}\n\nОбновляется только та копия, которую вы открываете, поэтому версию определяет та, что запустится следующей. Оставьте ту, которой пользуетесь, а другую переместите в корзину — или откройте другую один раз и дайте ей обновиться самой.',
  revealDuplicateApp: 'Показать другую копию в Finder',

  headerVersion: 'Версия {{version}}',
  headerChecking: 'Проверяем…',
  headerAvailable: 'Доступна версия {{version}}',
  headerUpToDate: 'Актуальная версия · проверено {{when}}',

  cardReadyTitle: 'v{{version}} готова',
  cardReadySubtitle: 'Перезапустите, чтобы установить · v{{current}}',
  cardRestart: 'Перезапустить и установить',
  cardAvailableTitle: 'Доступна v{{version}}',
  cardAvailableSubtitle: 'Сейчас v{{current}} · проверено {{when}}',
  cardUpdate: 'Обновить',
  cardUpdating: 'Обновляем…',
} as const;
