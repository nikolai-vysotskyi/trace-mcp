/* Menu titles follow the Russian macOS convention: «Файл», «Правка», «Вид»,
   «Окно», «Справка» — the same words the system's own menus use, so the app's
   bar reads as one bar and not as a translation sitting next to the OS. */

export const menu = {
  file: 'Файл',
  newWindow: 'Новое окно',
  openProject: 'Открыть проект…',
  quickOpen: 'Быстрое открытие…',
  closeTab: 'Закрыть вкладку',
  closeWindow: 'Закрыть окно',
  edit: 'Правка',
  find: 'Найти',
  view: 'Вид',
  toggleSidebar: 'Скрыть или показать боковую панель',
  reload: 'Обновить',
  window: 'Окно',
  help: 'Справка',
  documentation: 'Документация',
  selectProjectRoot: 'Выберите папку проекта',

  settings: 'Настройки…',
  viewChangelog: 'Список изменений',
  getHelp: 'Получить помощь',
  checkForUpdate: 'Проверить обновления…',
} as const;
