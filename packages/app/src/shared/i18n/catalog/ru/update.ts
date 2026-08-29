/* Единственное число без plural-форм: главный процесс присылает максимум один
   устаревший каталог — тот, из которого MCP-клиенты действительно запускаются
   (TRA-377). */

export const update = {
  staleRoots: 'MCP-клиенты работают на v{{version}}',
  staleRootsTitle:
    'Ваши редакторы запускают trace-mcp из {{pkgDir}} — там версия v{{version}}. Эту копию установил другой npm, поэтому обновление приложения её не затронуло: пока она не обновлена, все MCP-клиенты работают со старым сервером.\n\nОбновите её из терминала:\n{{command}}',
  copyStaleRootCommand: 'Скопировать команду обновления',

  headerVersion: 'Версия {{version}}',
  headerChecking: 'Проверяем…',
  headerAvailable: 'Доступна версия {{version}}',
  headerManualInstall: 'Версию {{version}} нужно установить вручную',
  headerUpToDate: 'Актуальная версия · проверено {{when}}',

  cardReadyTitle: 'v{{version}} готова',
  cardReadySubtitle: 'Перезапустите, чтобы установить · v{{current}}',
  cardRestart: 'Перезапустить и установить',
  cardStuckTitle: 'Версию {{version}} нужно установить вручную',
  cardStuckSubtitle:
    'Утилита командной строки обновилась, а само приложение осталось на v{{current}} — оно не смогло заменить свои файлы. Скачайте релиз и перетащите его в «Программы».',
  cardDownload: 'Скачать v{{version}}',
  cardAvailableTitle: 'Доступна v{{version}}',
  cardAvailableSubtitle: 'Сейчас v{{current}} · проверено {{when}}',
  cardUpdate: 'Обновить',
  cardUpdating: 'Обновляем…',
} as const;
