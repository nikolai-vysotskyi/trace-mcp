/* Подписи, которые примитивы задают сами: подсказка поля поиска, имя кнопки
   очистки, расшифровка буквы на значке оценки.

   «/regex/i» — синтаксис, а не текст: он не переводится. */

export const ui = {
  search: 'Поиск',
  clearSearch: 'Очистить поиск',
  gradeBadge: 'Оценка техдолга {{grade}}',
  loading: 'Загрузка',
  retry: 'Повторить',
  sectionError: 'Не удалось загрузить: {{what}}.',

  filterMatch: 'Совпадение',
  filterExclude: 'Исключить',
  filterPattern: 'подстрока или /regex/i',
  filterDepth: 'Глубина',
  regex: 'regex',
  regexMode: 'Режим регулярного выражения',
  regexInvalid: 'Ошибка в регулярном выражении (ищем как подстроку)',
  decreaseDepth: 'Уменьшить глубину',
  decreaseDepthTitle: 'Уменьшить глубину (или снять ограничение)',
  increaseDepth: 'Увеличить глубину',
  unlimitedDepth: 'Глубина не ограничена',
  depthLimit: 'Ограничение глубины: {{n}}',
  resetToUnlimited: 'Снять ограничение',
} as const;
